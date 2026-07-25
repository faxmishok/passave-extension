/**
 * PASSAVE — background.js
 * The invisible service worker. Securely fetches credentials for the current page.
 */

importScripts(
  'lib/capture-core.js',
  'lib/pending-store.js',
  'lib/auth-core.js',
  'lib/session-manager.js',
);

const API = 'https://passave.org/api/v1';

// Captures awaiting the user's answer. Session-scoped, not disk-backed, and
// invisible to content scripts — see lib/pending-store.js for why this cannot
// be a plain Map.
const pendingCaptures = PassavePendingStore.createPendingStore(
  chrome.storage.session,
);

// The one owner of the access/refresh pair. Nothing else in the extension —
// popup included — reads or writes tokens, because two contexts redeeming the
// same single-use refresh token reads server-side as theft and revokes the
// session.
const session = PassaveSessionManager.createSessionManager({
  fetch: (url, init) => fetch(url, init),
  storage: chrome.storage.local,
  apiBase: API,
  appVersion: chrome.runtime.getManifest().version,
  osVersion: navigator.userAgent,
});

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

// Fetch the vault and return saves whose domain matches `domain`.
async function fetchDomainMatches(domain) {
  const res = await session.apiFetch('/save/all');
  if (!res.ok) {
    const err = new Error(res.reason);
    err.code = res.reason;
    throw err;
  }
  const saves = (res.body && res.body.saves) || [];
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
  const { signedIn } = await session.getAuthState();
  if (!signedIn) return sendResponse({ success: false, matches: [] });

  // The prompt outlives the navigation that submitted the form, so re-serve it
  // to the next page — but only on the domain it was captured from.
  const pending = await pendingCaptures.get(tabId, { domain: request.domain });
  const pendingCapture = pending ? toPendingView(pending) : null;

  try {
    const matches = await fetchDomainMatches(request.domain);
    sendResponse({ success: true, matches, pendingCapture });
  } catch (err) {
    if (err.code === 'signed_out') {
      return sendResponse({ success: false, error: 'unauthorized', matches: [] });
    }
    sendResponse({ success: false, matches: [], pendingCapture });
  }
}

// ─── Capture intake ───────────────────────────────────────────
async function handleCaptureSubmit(request, tabId, sendResponse) {
  if (tabId == null) return sendResponse({ pendingCapture: null });

  const { signedIn } = await session.getAuthState();
  if (!signedIn) return sendResponse({ pendingCapture: null }); // can't save without a logged-in vault

  let matches = [];
  try {
    matches = await fetchDomainMatches(request.domain);
  } catch {
    return sendResponse({ pendingCapture: null }); // signed out or network error → skip prompting
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
  const body = PassaveCaptureCore.buildSaveBody(pending, request.edits);
  const isUpdate = pending.action === 'update';
  const path = isUpdate ? `/save/${pending.saveId}` : '/save/add';

  const res = await session.apiFetch(path, {
    method: isUpdate ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    if (res.reason === 'signed_out') {
      return sendResponse({ success: false, error: 'unauthorized' });
    }
    if (res.reason === 'network' || res.reason === 'network_unavailable') {
      return sendResponse({ success: false, error: 'network' });
    }
    // Surface the API's own wording — "Username is required!" is a far more
    // actionable prompt than a bare failure state.
    return sendResponse({
      success: false,
      error: `http_${res.status}`,
      message: (res.body && res.body.message) || null,
    });
  }

  await pendingCaptures.remove(tabId);
  sendResponse({ success: true });
}

async function handleIgnoreSite(request, tabId, sendResponse) {
  const { ignoredSites = [] } = await storageGet(['ignoredSites']);
  const next = PassaveCaptureCore.addIgnoredSite(ignoredSites, request.domain);
  await chrome.storage.local.set({ ignoredSites: next });
  await pendingCaptures.remove(tabId);
  sendResponse({ success: true });
}

// ─── Popup auth + vault bridge ────────────────────────────────
// The popup owns no tokens; it asks the worker for everything.
async function handleAuthState(request, tabId, sendResponse) {
  sendResponse(await session.getAuthState());
}

async function handleAuthLogin(request, tabId, sendResponse) {
  sendResponse(await session.login(request.credentials));
}

async function handleAuthLogout(request, tabId, sendResponse) {
  sendResponse(await session.signOut());
}

async function handleVaultFetch(request, tabId, sendResponse) {
  const res = await session.apiFetch('/save/all');
  if (!res.ok) {
    return sendResponse({ success: false, saves: [], reason: res.reason });
  }
  sendResponse({ success: true, saves: (res.body && res.body.saves) || [] });
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
  if (request.type === 'AUTH_STATE') {
    return run(handleAuthState, { signedIn: false, username: null });
  }
  if (request.type === 'AUTH_LOGIN') {
    return run(handleAuthLogin, { success: false, message: 'Login failed. Please try again.' });
  }
  if (request.type === 'AUTH_LOGOUT') {
    return run(handleAuthLogout, { success: true });
  }
  if (request.type === 'VAULT_FETCH') {
    return run(handleVaultFetch, { success: false, saves: [], reason: 'internal' });
  }
});
