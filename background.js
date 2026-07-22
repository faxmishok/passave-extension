/**
 * PASSAVE — background.js
 * The invisible service worker. Securely fetches credentials for the current page.
 */

importScripts('lib/capture-core.js', 'lib/pending-store.js');

const API = 'https://passave.org/api/v1';

// Captures awaiting the user's answer. Session-scoped, not disk-backed, and
// invisible to content scripts — see lib/pending-store.js for why this cannot
// be a plain Map.
const pendingCaptures = PassavePendingStore.createPendingStore(
  chrome.storage.session,
);

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function getToken() {
  return storageGet(['token']).then((r) => r.token || null);
}

// Fetch the vault and return saves whose domain matches `domain`.
async function fetchDomainMatches(token, domain) {
  const res = await fetch(`${API}/save/all`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    chrome.storage.local.remove('token');
    const err = new Error('unauthorized');
    err.code = 'unauthorized';
    throw err;
  }
  if (!res.ok) return [];
  const data = await res.json();
  const saves = data.saves || [];
  const currentDomain = domain.replace(/^www\./i, '');
  return saves.filter((s) => {
    if (!s.loginURL) return false;
    try {
      const saveDomain = new URL(
        s.loginURL.startsWith('http') ? s.loginURL : 'https://' + s.loginURL,
      ).hostname.replace(/^www\./i, '');
      return saveDomain === currentDomain;
    } catch {
      return false;
    }
  });
}

// Password-free projection of a pending capture for the content script.
function toPendingView(pending) {
  if (!pending) return null;
  return {
    nonce: pending.nonce,
    action: pending.action,
    saveId: pending.saveId,
    scenario: pending.scenario,
    name: pending.name,
    username: pending.identifiers.username,
    email: pending.identifiers.email,
    domain: pending.domain,
  };
}

// ─── Page load: vault matches + any prompt still owed ─────────
async function handleCheckMatches(request, tabId, sendResponse) {
  const token = await getToken();
  if (!token) return sendResponse({ success: false, matches: [] });

  // The prompt outlives the navigation that submitted the form, so re-serve it
  // to the next page — but only on the domain it was captured from.
  const pending = await pendingCaptures.get(tabId, { domain: request.domain });
  const pendingCapture = pending ? toPendingView(pending) : null;

  try {
    const matches = await fetchDomainMatches(token, request.domain);
    sendResponse({ success: true, matches, pendingCapture });
  } catch (err) {
    if (err.code === 'unauthorized') {
      return sendResponse({ success: false, error: 'unauthorized', matches: [] });
    }
    sendResponse({ success: false, matches: [], pendingCapture });
  }
}

// ─── Capture intake ───────────────────────────────────────────
async function handleCaptureSubmit(request, tabId, sendResponse) {
  if (tabId == null) return sendResponse({ pendingCapture: null });
  const token = await getToken();
  if (!token) return sendResponse({ pendingCapture: null }); // can't save without a logged-in vault

  let matches = [];
  try {
    matches = await fetchDomainMatches(token, request.domain);
  } catch {
    return sendResponse({ pendingCapture: null }); // unauthorized or network error → skip prompting
  }

  const { ignoredSites = [] } = await storageGet(['ignoredSites']);
  const decision = PassaveCaptureCore.resolveCaptureAction({
    domain: request.domain,
    identifiers: request.identifiers,
    password: request.password,
    matches,
    ignoredSites,
  });

  if (decision.action === 'suppress') {
    await pendingCaptures.remove(tabId);
    return sendResponse({ pendingCapture: null });
  }

  const pending = {
    nonce: crypto.randomUUID(),
    action: decision.action,
    saveId: decision.saveId,
    scenario: request.scenario,
    name: PassaveCaptureCore.deriveName(request.domain),
    identifiers: request.identifiers,
    password: request.password,
    loginURL: request.loginURL,
    domain: request.domain,
  };

  await pendingCaptures.put(tabId, pending);
  sendResponse({ pendingCapture: toPendingView(pending) });
}

// A closed tab can never answer its prompt — drop the plaintext password.
chrome.tabs.onRemoved.addListener((tabId) => {
  pendingCaptures.remove(tabId).catch(() => {});
});

// The user waved the prompt away; don't re-serve it on the next page.
async function handleDismissCapture(request, tabId, sendResponse) {
  await pendingCaptures.remove(tabId);
  sendResponse({ success: true });
}

async function handleSaveCredential(request, tabId, sendResponse) {
  const pending = await pendingCaptures.get(tabId);
  if (!pending || pending.nonce !== request.nonce) {
    return sendResponse({ success: false, error: 'stale' });
  }
  const token = await getToken();
  if (!token) return sendResponse({ success: false, error: 'unauthorized' });

  const body = PassaveCaptureCore.buildSaveBody(pending, request.edits);
  const isUpdate = pending.action === 'update';
  const url = isUpdate ? `${API}/save/${pending.saveId}` : `${API}/save/add`;

  try {
    const res = await fetch(url, {
      method: isUpdate ? 'PUT' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Surface the API's own wording — "Username is required!" is a far more
      // actionable prompt than a bare failure state.
      const detail = await res
        .json()
        .then((d) => d && d.message)
        .catch(() => null);
      return sendResponse({
        success: false,
        error: `http_${res.status}`,
        message: detail || null,
      });
    }
    await pendingCaptures.remove(tabId);
    sendResponse({ success: true });
  } catch {
    sendResponse({ success: false, error: 'network' });
  }
}

async function handleIgnoreSite(request, tabId, sendResponse) {
  const { ignoredSites = [] } = await storageGet(['ignoredSites']);
  const next = PassaveCaptureCore.addIgnoredSite(ignoredSites, request.domain);
  await chrome.storage.local.set({ ignoredSites: next });
  await pendingCaptures.remove(tabId);
  sendResponse({ success: true });
}

// ─── Message router ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;

  // An async handler that throws would otherwise leave the port open forever
  // and the prompt spinning with no answer.
  const run = (handler, fallback) => {
    Promise.resolve(handler(request, tabId, sendResponse)).catch((err) => {
      console.error('[Passave] handler failed', request.type, err);
      sendResponse(fallback);
    });
    return true;
  };

  if (request.type === 'CHECK_MATCHES') {
    return run(handleCheckMatches, { success: false, matches: [] });
  }
  if (request.type === 'CAPTURE_SUBMIT') {
    return run(handleCaptureSubmit, { pendingCapture: null });
  }
  if (request.type === 'SAVE_CREDENTIAL') {
    return run(handleSaveCredential, { success: false, error: 'internal' });
  }
  if (request.type === 'IGNORE_SITE') {
    return run(handleIgnoreSite, { success: false });
  }
  if (request.type === 'DISMISS_CAPTURE') {
    return run(handleDismissCapture, { success: false });
  }
});
