/**
 * PASSAVE — background.js
 * The invisible service worker. Securely fetches credentials for the current page.
 */

importScripts('lib/capture-core.js');

const API = 'https://passave.org/api/v1';

// ─── In-memory pending captures (never persisted; holds plaintext pw) ──
const pendingCaptures = new Map(); // tabId -> pending

const PENDING_TTL_MS = 5 * 60 * 1000;

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

function isFresh(pending) {
  return pending && Date.now() - pending.createdAt < PENDING_TTL_MS;
}

// ─── Capture intake ───────────────────────────────────────────
async function handleCaptureSubmit(request, tabId) {
  if (tabId == null) return;
  const token = await getToken();
  if (!token) return; // can't save without a logged-in vault

  let matches = [];
  try {
    matches = await fetchDomainMatches(token, request.domain);
  } catch {
    return; // unauthorized or network error → skip prompting
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
    pendingCaptures.delete(tabId);
    return;
  }

  pendingCaptures.set(tabId, {
    nonce: Math.random().toString(36).slice(2) + Date.now().toString(36),
    action: decision.action,
    saveId: decision.saveId,
    scenario: request.scenario,
    name: PassaveCaptureCore.deriveName(request.domain),
    identifiers: request.identifiers,
    password: request.password,
    loginURL: request.loginURL,
    domain: request.domain,
    createdAt: Date.now(),
    navsSeen: 0,
  });
}

// Drop a pending capture once the tab navigates a second time.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  const pending = pendingCaptures.get(tabId);
  if (!pending) return;
  pending.navsSeen += 1;
  if (pending.navsSeen > 1) pendingCaptures.delete(tabId);
});

async function handleSaveCredential(request, tabId, sendResponse) {
  const pending = pendingCaptures.get(tabId);
  if (!pending || pending.nonce !== request.nonce) {
    return sendResponse({ success: false, error: 'stale' });
  }
  const token = await getToken();
  if (!token) return sendResponse({ success: false, error: 'unauthorized' });

  const edits = request.edits || {};
  const body = {
    name: edits.name || pending.name,
    username: edits.username || pending.identifiers.username,
    email: edits.email || pending.identifiers.email,
    password_secret: pending.password,
    registered_number: pending.identifiers.registered_number,
    loginURL: pending.loginURL,
  };

  const isUpdate = pending.action === 'update';
  const url = isUpdate ? `${API}/save/${pending.saveId}` : `${API}/save/add`;
  const method = isUpdate ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return sendResponse({ success: false, error: `http_${res.status}` });
    pendingCaptures.delete(tabId);
    sendResponse({ success: true });
  } catch {
    sendResponse({ success: false, error: 'network' });
  }
}

async function handleIgnoreSite(request, tabId, sendResponse) {
  const { ignoredSites = [] } = await storageGet(['ignoredSites']);
  if (!ignoredSites.includes(request.domain)) {
    ignoredSites.push(request.domain);
    await new Promise((resolve) =>
      chrome.storage.local.set({ ignoredSites }, resolve),
    );
  }
  pendingCaptures.delete(tabId);
  sendResponse({ success: true });
}

// ─── Message router ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;

  if (request.type === 'CHECK_MATCHES') {
    getToken().then(async (token) => {
      if (!token) return sendResponse({ success: false, matches: [] });
      try {
        const matches = await fetchDomainMatches(token, request.domain);
        const pending = pendingCaptures.get(tabId);
        const pendingCapture = isFresh(pending) ? toPendingView(pending) : null;
        sendResponse({ success: true, matches, pendingCapture });
      } catch (err) {
        if (err.code === 'unauthorized') {
          return sendResponse({ success: false, error: 'unauthorized', matches: [] });
        }
        sendResponse({ success: false, matches: [] });
      }
    });
    return true;
  }

  if (request.type === 'CAPTURE_SUBMIT') {
    handleCaptureSubmit(request, tabId);
    return false; // no response needed
  }

  if (request.type === 'SAVE_CREDENTIAL') {
    handleSaveCredential(request, tabId, sendResponse);
    return true;
  }

  if (request.type === 'IGNORE_SITE') {
    handleIgnoreSite(request, tabId, sendResponse);
    return true;
  }
});
