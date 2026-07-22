# Credential Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add credential capture to the Passave Chrome extension so signing up, logging into a not-yet-saved site, or changing a password prompts the user to save/update the credential in their vault.

**Architecture:** All decision logic lives in a new pure, UMD-style module `lib/capture-core.js` (loads as a browser global for content/background scripts *and* is `require`-able by Node tests). `content.js` snapshots submitted forms and sends captures to `background.js`; the service worker resolves the action against the vault, holds a per-tab pending capture in memory (password never persisted), and returns it on the next page load's existing `CHECK_MATCHES` round-trip, where `content.js` renders a capture pill. Saving/updating calls the existing `POST /save/add` and `PUT /save/:id` endpoints.

**Tech Stack:** Vanilla JS (Chrome MV3 extension), Node built-in test runner (`node --test`, no external dependencies).

## Global Constraints

- Manifest V3; content scripts and the background service worker are **classic scripts** (no ES modules). `lib/capture-core.js` MUST use a UMD footer that assigns to `self.PassaveCaptureCore` in the browser and `module.exports` in Node.
- **No new permissions.** Only `storage`, `activeTab`, `<all_urls>` content script, and `host_permissions` for `https://passave.org/*` (all already present). `chrome.tabs.onUpdated` is used without the `"tabs"` permission (event fires without it; we never read `changeInfo.url`).
- **No external npm dependencies.** Tests use `node:test` + `node:assert` only.
- Plaintext passwords must never be written to `chrome.storage` or logged. They exist only in the DOM, the `CAPTURE_SUBMIT` message, and the service-worker `pendingCaptures` map.
- API base is `https://passave.org/api/v1` (already defined as `API` in `background.js`). Save body fields: `name` (required), `username` (required), `email`, `password_secret` (required), `registered_number`, `loginURL`, `category`.
- Reuse the existing floating-pill styling from `content.js` `injectFloatingUI` for the capture pill (design-system match).
- Suppress all capture on `passave.org` itself (never capture the vault's own master login).

---

### Task 1: Test bootstrap + identifier classifier

**Files:**
- Create: `package.json`
- Create: `lib/capture-core.js`
- Test: `tests/capture-core.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `EMAIL_RE: RegExp`
  - `classifyIdentifierField(field: {type: string, value: string}) => 'email' | 'registered_number' | 'username'`
  - `classifyIdentifiers(fields: Array<{type,value}>) => {username: string, email: string, registered_number: string}` — first non-empty value of each kind wins; if only an email was found, it also fills `username`.
  - Global name in browser: `self.PassaveCaptureCore`; Node: `module.exports`.

- [ ] **Step 1: Write the failing test**

Create `tests/capture-core.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../lib/capture-core');

test('classifyIdentifierField: email by value shape', () => {
  assert.equal(core.classifyIdentifierField({ type: 'text', value: 'jane@x.com' }), 'email');
  assert.equal(core.classifyIdentifierField({ type: 'email', value: 'jane@x.com' }), 'email');
});

test('classifyIdentifierField: phone by tel type or digits', () => {
  assert.equal(core.classifyIdentifierField({ type: 'tel', value: '555 123 4567' }), 'registered_number');
  assert.equal(core.classifyIdentifierField({ type: 'text', value: '+1 (555) 123-4567' }), 'registered_number');
});

test('classifyIdentifierField: username otherwise', () => {
  assert.equal(core.classifyIdentifierField({ type: 'text', value: 'jane_doe' }), 'username');
});

test('classifyIdentifiers: username + email form', () => {
  const out = core.classifyIdentifiers([
    { type: 'text', value: 'jane_doe' },
    { type: 'email', value: 'jane@x.com' },
  ]);
  assert.deepEqual(out, { username: 'jane_doe', email: 'jane@x.com', registered_number: '' });
});

test('classifyIdentifiers: email-only form fills username with full email', () => {
  const out = core.classifyIdentifiers([{ type: 'email', value: 'jane@x.com' }]);
  assert.deepEqual(out, { username: 'jane@x.com', email: 'jane@x.com', registered_number: '' });
});

test('classifyIdentifiers: skips empty values', () => {
  const out = core.classifyIdentifiers([
    { type: 'text', value: '' },
    { type: 'text', value: 'jane_doe' },
  ]);
  assert.equal(out.username, 'jane_doe');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test`
Expected: FAIL — `Cannot find module '../lib/capture-core'`.

- [ ] **Step 3: Create package.json**

Create `package.json`:

```json
{
  "name": "passave-extension",
  "version": "2.2.3",
  "private": true,
  "description": "Passave browser extension",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 4: Write minimal implementation**

Create `lib/capture-core.js`:

```js
'use strict';
/**
 * PASSAVE — capture-core.js
 * Pure, framework-free decision logic for credential capture.
 * Loads as a browser global (self.PassaveCaptureCore) and as a Node module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PassaveCaptureCore = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  function classifyIdentifierField(field) {
    const value = (field && field.value ? String(field.value) : '').trim();
    if (EMAIL_RE.test(value)) return 'email';
    const digits = value.replace(/\D/g, '');
    const phoneShaped = digits.length >= 7 && /^[+()\d][\d\s()+-]*$/.test(value);
    if (field && field.type === 'tel') return 'registered_number';
    if (phoneShaped) return 'registered_number';
    return 'username';
  }

  function classifyIdentifiers(fields) {
    const out = { username: '', email: '', registered_number: '' };
    for (const field of fields || []) {
      const value = (field && field.value ? String(field.value) : '').trim();
      if (!value) continue;
      const kind = classifyIdentifierField(field);
      if (!out[kind]) out[kind] = value;
    }
    if (!out.username && out.email) out.username = out.email;
    return out;
  }

  return {
    EMAIL_RE,
    classifyIdentifierField,
    classifyIdentifiers,
  };
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test`
Expected: PASS — all 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json lib/capture-core.js tests/capture-core.test.js
git commit -m "feat(capture): add identifier classifier + test bootstrap"
```

---

### Task 2: Scenario detection

**Files:**
- Modify: `lib/capture-core.js`
- Test: `tests/capture-core.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `detectScenario(passwordValues: string[]) => { scenario: 'signup' | 'change-password' | 'login', password: string | null }`
  - Rules: 0 non-empty → `login`, `null`. Exactly 1 field → `login`. 2 fields all-equal → `signup`. Otherwise (2–3 fields, not all equal) → `change-password`, new password = the value that repeats, else the last non-empty value.

- [ ] **Step 1: Write the failing test**

Append to `tests/capture-core.test.js`:

```js
test('detectScenario: single password field is login', () => {
  assert.deepEqual(core.detectScenario(['hunter2']), { scenario: 'login', password: 'hunter2' });
});

test('detectScenario: two equal fields is signup', () => {
  assert.deepEqual(core.detectScenario(['hunter2', 'hunter2']), { scenario: 'signup', password: 'hunter2' });
});

test('detectScenario: current + new is change-password (new is last)', () => {
  assert.deepEqual(core.detectScenario(['oldpw', 'newpw']), { scenario: 'change-password', password: 'newpw' });
});

test('detectScenario: current + new + confirm uses the repeated new password', () => {
  assert.deepEqual(core.detectScenario(['oldpw', 'newpw', 'newpw']), { scenario: 'change-password', password: 'newpw' });
});

test('detectScenario: no non-empty passwords yields null', () => {
  assert.deepEqual(core.detectScenario(['', '']), { scenario: 'login', password: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test`
Expected: FAIL — `core.detectScenario is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/capture-core.js`, add this function inside the factory, before the `return` block:

```js
  function detectScenario(passwordValues) {
    const values = passwordValues || [];
    const nonEmpty = values.filter((p) => p && p.length > 0);
    if (nonEmpty.length === 0) return { scenario: 'login', password: null };
    if (values.length === 1) return { scenario: 'login', password: values[0] };

    const allEqual = nonEmpty.every((p) => p === nonEmpty[0]);
    if (values.length === 2 && allEqual) {
      return { scenario: 'signup', password: nonEmpty[0] };
    }

    const counts = {};
    for (const p of nonEmpty) counts[p] = (counts[p] || 0) + 1;
    const repeated = nonEmpty.find((p) => counts[p] >= 2);
    const newPassword = repeated || nonEmpty[nonEmpty.length - 1];
    return { scenario: 'change-password', password: newPassword };
  }
```

Then add `detectScenario` to the returned object:

```js
  return {
    EMAIL_RE,
    classifyIdentifierField,
    classifyIdentifiers,
    detectScenario,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test`
Expected: PASS — all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/capture-core.js tests/capture-core.test.js
git commit -m "feat(capture): add scenario detection"
```

---

### Task 3: Capture action resolver

**Files:**
- Modify: `lib/capture-core.js`
- Test: `tests/capture-core.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `resolveCaptureAction(input) => { action: 'save-new' | 'update' | 'suppress', saveId: string | null, reason: string }`
  - `input`: `{ domain: string, identifiers: {username,email,registered_number}, password: string|null, matches: Array<{_id?,id?,username,email,password_secret}>, ignoredSites: string[] }`
  - Rules (in order): no password → `suppress`/`no-password`; `passave.org` domain → `suppress`/`self-domain`; domain in `ignoredSites` → `suppress`/`ignored`; a match with the same identifier (case-insensitive username/email) and same password → `suppress`/`already-saved`; same identifier, different password → `update` with that save's id; otherwise → `save-new` (`new-account` if other matches exist, else `not-in-vault`).

- [ ] **Step 1: Write the failing test**

Append to `tests/capture-core.test.js`:

```js
const ids = (username, email) => ({ username, email, registered_number: '' });

test('resolveCaptureAction: no vault match saves new', () => {
  const r = core.resolveCaptureAction({
    domain: 'example.com', identifiers: ids('jane', 'jane@x.com'),
    password: 'pw', matches: [], ignoredSites: [],
  });
  assert.deepEqual(r, { action: 'save-new', saveId: null, reason: 'not-in-vault' });
});

test('resolveCaptureAction: same identifier + changed password updates', () => {
  const r = core.resolveCaptureAction({
    domain: 'example.com', identifiers: ids('jane', 'jane@x.com'), password: 'newpw',
    matches: [{ _id: 'abc', username: 'jane', email: 'jane@x.com', password_secret: 'oldpw' }],
    ignoredSites: [],
  });
  assert.deepEqual(r, { action: 'update', saveId: 'abc', reason: 'password-changed' });
});

test('resolveCaptureAction: same identifier + same password is suppressed', () => {
  const r = core.resolveCaptureAction({
    domain: 'example.com', identifiers: ids('jane', 'jane@x.com'), password: 'samepw',
    matches: [{ _id: 'abc', username: 'jane', email: 'jane@x.com', password_secret: 'samepw' }],
    ignoredSites: [],
  });
  assert.equal(r.action, 'suppress');
  assert.equal(r.reason, 'already-saved');
});

test('resolveCaptureAction: different identifier on known site saves new account', () => {
  const r = core.resolveCaptureAction({
    domain: 'example.com', identifiers: ids('bob', 'bob@x.com'), password: 'pw',
    matches: [{ _id: 'abc', username: 'jane', email: 'jane@x.com', password_secret: 'oldpw' }],
    ignoredSites: [],
  });
  assert.deepEqual(r, { action: 'save-new', saveId: null, reason: 'new-account' });
});

test('resolveCaptureAction: ignored site suppressed', () => {
  const r = core.resolveCaptureAction({
    domain: 'example.com', identifiers: ids('jane', 'jane@x.com'), password: 'pw',
    matches: [], ignoredSites: ['example.com'],
  });
  assert.equal(r.action, 'suppress');
  assert.equal(r.reason, 'ignored');
});

test('resolveCaptureAction: passave.org is always suppressed', () => {
  const r = core.resolveCaptureAction({
    domain: 'passave.org', identifiers: ids('jane', 'jane@x.com'), password: 'pw',
    matches: [], ignoredSites: [],
  });
  assert.equal(r.reason, 'self-domain');
});

test('resolveCaptureAction: no password suppressed', () => {
  const r = core.resolveCaptureAction({
    domain: 'example.com', identifiers: ids('jane', ''), password: null,
    matches: [], ignoredSites: [],
  });
  assert.equal(r.reason, 'no-password');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test`
Expected: FAIL — `core.resolveCaptureAction is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/capture-core.js`, add this function inside the factory, before the `return` block:

```js
  function resolveCaptureAction(input) {
    const {
      domain = '',
      identifiers = {},
      password = null,
      matches = [],
      ignoredSites = [],
    } = input || {};

    if (!password) return { action: 'suppress', saveId: null, reason: 'no-password' };
    if (domain.replace(/^www\./i, '') === 'passave.org') {
      return { action: 'suppress', saveId: null, reason: 'self-domain' };
    }
    if (ignoredSites.includes(domain)) {
      return { action: 'suppress', saveId: null, reason: 'ignored' };
    }

    const idValues = [identifiers.username, identifiers.email]
      .filter(Boolean)
      .map((s) => s.toLowerCase());
    const sameId = matches.find((m) =>
      [m.username, m.email]
        .filter(Boolean)
        .some((v) => idValues.includes(String(v).toLowerCase())),
    );

    if (sameId) {
      if (sameId.password_secret === password) {
        return { action: 'suppress', saveId: null, reason: 'already-saved' };
      }
      return { action: 'update', saveId: sameId._id || sameId.id || null, reason: 'password-changed' };
    }

    return {
      action: 'save-new',
      saveId: null,
      reason: matches.length ? 'new-account' : 'not-in-vault',
    };
  }
```

Then add `resolveCaptureAction` to the returned object:

```js
  return {
    EMAIL_RE,
    classifyIdentifierField,
    classifyIdentifiers,
    detectScenario,
    resolveCaptureAction,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test`
Expected: PASS — all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/capture-core.js tests/capture-core.test.js
git commit -m "feat(capture): add capture action resolver"
```

---

### Task 4: Display-name derivation

**Files:**
- Modify: `lib/capture-core.js`
- Test: `tests/capture-core.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `deriveName(domain: string) => string` — strips leading `www.`, takes the second-level label, capitalizes the first letter. `github.com` → `Github`, `mail.google.com` → `Google`, empty → `Credential`.

- [ ] **Step 1: Write the failing test**

Append to `tests/capture-core.test.js`:

```js
test('deriveName: registrable label, capitalized', () => {
  assert.equal(core.deriveName('github.com'), 'Github');
  assert.equal(core.deriveName('www.github.com'), 'Github');
  assert.equal(core.deriveName('mail.google.com'), 'Google');
});

test('deriveName: empty falls back to Credential', () => {
  assert.equal(core.deriveName(''), 'Credential');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test`
Expected: FAIL — `core.deriveName is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/capture-core.js`, add this function inside the factory, before the `return` block:

```js
  function deriveName(domain) {
    if (!domain) return 'Credential';
    const host = String(domain).replace(/^www\./i, '');
    const parts = host.split('.');
    const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (!label) return 'Credential';
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
```

Then add `deriveName` to the returned object:

```js
  return {
    EMAIL_RE,
    classifyIdentifierField,
    classifyIdentifiers,
    detectScenario,
    resolveCaptureAction,
    deriveName,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test`
Expected: PASS — all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/capture-core.js tests/capture-core.test.js
git commit -m "feat(capture): add display-name derivation"
```

---

### Task 5: Load capture-core in manifest + background

**Files:**
- Modify: `manifest.json:25-31` (content_scripts)
- Modify: `background.js:1-6` (top of service worker)

**Interfaces:**
- Consumes: `lib/capture-core.js` (`self.PassaveCaptureCore`).
- Produces: `PassaveCaptureCore` available as a global in both the content-script world and the service-worker global.

- [ ] **Step 1: Add capture-core to the content script list**

In `manifest.json`, change the `content_scripts` `js` array so `lib/capture-core.js` loads first:

```json
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["lib/capture-core.js", "content.js"],
      "run_at": "document_idle"
    }
  ],
```

- [ ] **Step 2: Import capture-core into the service worker**

In `background.js`, add `importScripts` immediately after the file's opening doc comment and before `const API`:

```js
importScripts('lib/capture-core.js');

const API = 'https://passave.org/api/v1';
```

- [ ] **Step 3: Manual verification**

1. Open `chrome://extensions`, enable Developer mode, "Load unpacked" → select the extension folder (or click the reload icon if already loaded).
2. Confirm no manifest/parse errors are shown on the card.
3. Click the card's "service worker" link to open its DevTools console, type `PassaveCaptureCore.deriveName('github.com')`, press Enter.

Expected: console prints `'Github'` and there are no red errors.

- [ ] **Step 4: Commit**

```bash
git add manifest.json background.js
git commit -m "feat(capture): load capture-core in content + background"
```

---

### Task 6: Background capture intake + pending store

**Files:**
- Modify: `background.js` (refactor `CHECK_MATCHES`, add `CAPTURE_SUBMIT`, add pending store + staleness)

**Interfaces:**
- Consumes: `PassaveCaptureCore.resolveCaptureAction`, `PassaveCaptureCore.deriveName`.
- Produces:
  - `fetchDomainMatches(token: string, domain: string) => Promise<Array<save>>` — extracted from the existing `CHECK_MATCHES` fetch+filter.
  - In-memory `pendingCaptures: Map<number, pending>` keyed by `tabId`.
  - `pending` shape: `{ nonce, action, saveId, scenario, name, identifiers, password, loginURL, domain, createdAt, navsSeen }`.
  - `CHECK_MATCHES` response gains `pendingCapture` (a password-free view) — consumed by Task 9.
  - `CAPTURE_SUBMIT` message handler — consumed by Task 8.

- [ ] **Step 1: Extract `fetchDomainMatches` and the pending store**

Replace the entire body of `background.js` after the `const API = ...` line with the following. This preserves the existing `CHECK_MATCHES` behavior (now via `fetchDomainMatches`) and adds the pending-capture machinery:

```js
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
});
```

- [ ] **Step 2: Manual verification**

1. Reload the extension in `chrome://extensions`.
2. Open the service worker console. Paste and run:

```js
handleCaptureSubmit(
  { domain: 'example.com', identifiers: { username: 'jane', email: 'jane@x.com', registered_number: '' }, password: 'pw', scenario: 'signup', loginURL: 'https://example.com/signup' },
  999,
).then(() => console.log('pending:', pendingCaptures.get(999)));
```

Expected: after login (a `token` must exist in `chrome.storage.local` from using the extension), it logs a pending object with `action` `save-new` for a site not in the vault. With no token, it logs `pending: undefined` (correctly skipped). No red errors either way.

- [ ] **Step 3: Commit**

```bash
git add background.js
git commit -m "feat(capture): background capture intake + pending store"
```

---

### Task 7: Background save / update / ignore handlers

**Files:**
- Modify: `background.js` (extend the message router)

**Interfaces:**
- Consumes: `pendingCaptures`, `getToken`, `API`.
- Produces:
  - `SAVE_CREDENTIAL` message `{ type, nonce, edits: {name, username, email} }` → `POST /save/add` or `PUT /save/:id` depending on the pending action; responds `{ success, error? }`.
  - `IGNORE_SITE` message `{ type, domain }` → appends to `chrome.storage.local.ignoredSites`; responds `{ success }`.

- [ ] **Step 1: Add the write handlers**

In `background.js`, add these two functions above the `chrome.runtime.onMessage.addListener` router:

```js
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
```

- [ ] **Step 2: Route the new messages**

In `background.js`, inside the `chrome.runtime.onMessage.addListener` callback, add these branches before the closing `}` of the listener (after the `CAPTURE_SUBMIT` branch):

```js
  if (request.type === 'SAVE_CREDENTIAL') {
    handleSaveCredential(request, tabId, sendResponse);
    return true;
  }

  if (request.type === 'IGNORE_SITE') {
    handleIgnoreSite(request, tabId, sendResponse);
    return true;
  }
```

- [ ] **Step 3: Manual verification**

1. Reload the extension. Ensure you are logged into the extension (a real `token` in storage).
2. In the service worker console, seed a pending capture:

```js
pendingCaptures.set(999, {
  nonce: 'n1', action: 'save-new', saveId: null, scenario: 'signup',
  name: 'Example', identifiers: { username: 'jane@x.com', email: 'jane@x.com', registered_number: '' },
  password: 'test-pw-123', loginURL: 'https://example.com/signup',
  domain: 'example.com', createdAt: Date.now(), navsSeen: 0,
});
```

3. Trigger the save by calling the handler directly from the same console:

```js
handleSaveCredential({ type: 'SAVE_CREDENTIAL', nonce: 'n1', edits: {} }, 999, (r) => console.log('save result:', r));
```

Expected: logs `save result: { success: true }`. Open the Passave vault (popup or web) and confirm an "Example" credential for `jane@x.com` now exists. Re-running logs `{ success: false, error: 'stale' }` (pending was cleared).

- [ ] **Step 4: Commit**

```bash
git add background.js
git commit -m "feat(capture): background save/update/ignore handlers"
```

---

### Task 8: Content-script capture on submit

**Files:**
- Modify: `content.js` (add capture listeners + form snapshot + send `CAPTURE_SUBMIT`)

**Interfaces:**
- Consumes: `PassaveCaptureCore.detectScenario`, `PassaveCaptureCore.classifyIdentifiers`, existing `isVisible`.
- Produces:
  - `snapshotForm(root: Element|Document) => { identifierFields: Array<{type,value}>, passwordValues: string[] }`
  - `handleCapture(root)` — snapshots, detects scenario, sends `CAPTURE_SUBMIT`; debounced 1s.
  - Global `submit` (capture phase) + SPA click fallback listeners.

- [ ] **Step 1: Add snapshot + capture logic**

Append to the end of `content.js`:

```js
// ─── 6. CREDENTIAL CAPTURE (submit → background) ──────────────
let lastCaptureAt = 0;

function isIdentifierInput(el) {
  if (el.type === 'email' || el.type === 'tel') return true;
  return el.type === 'text';
}

function snapshotForm(root) {
  const inputs = Array.from(root.querySelectorAll('input')).filter(isVisible);
  const passwordValues = inputs
    .filter((el) => el.type === 'password')
    .map((el) => el.value);
  const identifierFields = inputs
    .filter((el) => el.type !== 'password' && isIdentifierInput(el))
    .map((el) => ({ type: el.type, value: el.value }));
  return { identifierFields, passwordValues };
}

function handleCapture(root) {
  const now = Date.now();
  if (now - lastCaptureAt < 1000) return; // debounce submit + click double-fire
  const snap = snapshotForm(root);
  const { scenario, password } = PassaveCaptureCore.detectScenario(snap.passwordValues);
  if (!password) return;
  lastCaptureAt = now;
  const identifiers = PassaveCaptureCore.classifyIdentifiers(snap.identifierFields);
  chrome.runtime.sendMessage({
    type: 'CAPTURE_SUBMIT',
    domain: window.location.hostname,
    loginURL: window.location.origin + window.location.pathname,
    scenario,
    password,
    identifiers,
  });
}

// Real form submits (capture phase runs before navigation).
document.addEventListener(
  'submit',
  (e) => {
    if (e.target instanceof HTMLFormElement) handleCapture(e.target);
  },
  true,
);

// SPA fallback: clicks on submit-like controls with a password field present.
document.addEventListener(
  'click',
  (e) => {
    const btn = e.target.closest(
      'button, input[type="submit"], input[type="button"], [role="button"]',
    );
    if (!btn) return;
    if (!document.querySelector('input[type="password"]')) return;
    const form = btn.closest('form') || document;
    handleCapture(form);
  },
  true,
);
```

- [ ] **Step 2: Manual verification**

1. Reload the extension. Open any site with a signup or login form (e.g. a test page or a real login page) and its page DevTools console (not the service worker).
2. Fill username/email + password, open the service worker console alongside, then submit the form.
3. In the service worker console run `pendingCaptures` (or add a temporary `console.log` in `handleCaptureSubmit`).

Expected: a `CAPTURE_SUBMIT` reaches the background; for a not-yet-saved site a pending capture with `action: 'save-new'` appears. On `passave.org` no pending is created.

- [ ] **Step 3: Commit**

```bash
git add content.js
git commit -m "feat(capture): capture credentials on form submit"
```

---

### Task 9: Content-script capture pill

**Files:**
- Modify: `content.js:19-36` (the `window.load` `CHECK_MATCHES` handler) and append the pill renderer.

**Interfaces:**
- Consumes: `response.pendingCapture` from `CHECK_MATCHES` (Task 6), existing pill styling (`injectFloatingUI` conventions, `passave-styles`).
- Produces: `injectCapturePill(pending)` — renders the capture prompt with Save/Update, an Edit disclosure (`name`/`username`/`email`), and a dismiss menu with "Never for this site"; sends `SAVE_CREDENTIAL` / `IGNORE_SITE`.

- [ ] **Step 1: Consume `pendingCapture` on load**

In `content.js`, replace the `window.addEventListener('load', ...)` block (the current section 2) with:

```js
window.addEventListener('load', () => {
  chrome.runtime.sendMessage(
    { type: 'CHECK_MATCHES', domain: window.location.hostname },
    (response) => {
      if (!response) return;

      if (response.success && response.matches.length > 0) {
        pageCredentials = response.matches[0];
        setupFocusListener();
        const { usernameField, passwordField } = getLoginFields();
        if (usernameField || passwordField)
          injectFloatingUI(usernameField || passwordField);
      }

      if (response.pendingCapture) {
        injectCapturePill(response.pendingCapture);
      }
    },
  );
});
```

- [ ] **Step 2: Add the capture pill renderer**

Append to the end of `content.js`:

```js
// ─── 7. CAPTURE PILL UI ───────────────────────────────────────
function injectCapturePill(pending) {
  const existing = document.getElementById('passave-capture-pill');
  if (existing) existing.remove();

  const isUpdate = pending.action === 'update';
  const title = isUpdate ? 'Update password in Passave?' : 'Save to Passave?';
  const cta = isUpdate ? 'Update' : 'Save';

  const pill = document.createElement('div');
  pill.id = 'passave-capture-pill';
  pill.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    width: 320px;
    background: #13131a;
    border: 1px solid rgba(124, 106, 247, 0.3);
    border-radius: 12px;
    padding: 16px;
    font-family: system-ui, -apple-system, sans-serif;
    color: #f0f0f5;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    animation: passavePop 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  `;

  if (!document.getElementById('passave-styles')) {
    const styleBlock = document.createElement('style');
    styleBlock.id = 'passave-styles';
    styleBlock.textContent = `
      @keyframes passavePop {
        from { transform: translateY(-10px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
    `;
    document.head.appendChild(styleBlock);
  }

  pill.innerHTML = `
    <div style="font-size: 14px; font-weight: 600; margin-bottom: 4px;">${title}</div>
    <div style="font-size: 12px; color: #8888a0; margin-bottom: 12px;">${pending.username || pending.email || pending.name}</div>
    <div id="passave-capture-edit" style="display: none; flex-direction: column; gap: 8px; margin-bottom: 12px;">
      <input id="passave-edit-name" placeholder="Name" value="${escapeAttr(pending.name)}" style="${pcInput()}" />
      <input id="passave-edit-username" placeholder="Username" value="${escapeAttr(pending.username || '')}" style="${pcInput()}" />
      <input id="passave-edit-email" placeholder="Email" value="${escapeAttr(pending.email || '')}" style="${pcInput()}" />
    </div>
    <div style="display: flex; gap: 8px; align-items: center;">
      <button id="passave-capture-save" style="${pcBtnPrimary()}">${cta}</button>
      <button id="passave-capture-edit-toggle" style="${pcBtnGhost()}">Edit</button>
      <button id="passave-capture-never" style="${pcBtnGhost()}; margin-left: auto;">Never for this site</button>
    </div>
  `;

  document.body.appendChild(pill);

  pill.querySelector('#passave-capture-edit-toggle').addEventListener('click', () => {
    const box = pill.querySelector('#passave-capture-edit');
    box.style.display = box.style.display === 'none' ? 'flex' : 'none';
  });

  pill.querySelector('#passave-capture-never').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'IGNORE_SITE', domain: pending.domain });
    pill.remove();
  });

  pill.querySelector('#passave-capture-save').addEventListener('click', () => {
    const edits = {
      name: pill.querySelector('#passave-edit-name').value,
      username: pill.querySelector('#passave-edit-username').value,
      email: pill.querySelector('#passave-edit-email').value,
    };
    chrome.runtime.sendMessage(
      { type: 'SAVE_CREDENTIAL', nonce: pending.nonce, edits },
      (res) => {
        const ok = res && res.success;
        pill.innerHTML = `<span style="font-size: 13px; font-weight: 600; color: ${ok ? '#50d890' : '#ff6b6b'};">${ok ? (isUpdate ? 'Updated!' : 'Saved!') : 'Could not save'}</span>`;
        setTimeout(() => pill.remove(), 1500);
      },
    );
  });
}

function pcInput() {
  return 'background:#1a1a24;border:1px solid rgba(124,106,247,0.3);border-radius:8px;padding:8px 10px;color:#f0f0f5;font-size:12px;';
}
function pcBtnPrimary() {
  return 'background:#7c6af7;border:none;border-radius:8px;padding:8px 16px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;';
}
function pcBtnGhost() {
  return 'background:transparent;border:none;color:#8888a0;font-size:12px;cursor:pointer;';
}
function escapeAttr(s) {
  return String(s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
```

- [ ] **Step 3: Run the unit tests (guard against regressions)**

Run: `node --test`
Expected: PASS — all core tests still pass (this task adds no core logic but confirms nothing broke).

- [ ] **Step 4: Commit**

```bash
git add content.js
git commit -m "feat(capture): capture pill UI with edit + never-for-site"
```

---

### Task 10: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Save-new flow**

1. Reload the extension; be logged into the vault.
2. Go to a login/signup page for a site **not** in your vault. Enter an email + password and submit.
3. On the page that loads next, expect the capture pill bottom-right: "Save to Passave?" with the derived name.
4. Click "Edit", confirm fields are pre-filled and editable, then click "Save".

Expected: pill shows "Saved!"; the credential (with the email in both username and email) appears in the vault.

- [ ] **Step 2: Update flow**

1. On the same site, change the password (a change-password form, or log in again with a new password).
2. Expect "Update password in Passave?".
3. Click "Update".

Expected: pill shows "Updated!"; the existing vault entry's password is updated (not a duplicate).

- [ ] **Step 3: Suppression flows**

1. Submit the same login with the **same** password already stored → **no** pill appears.
2. On a fresh site, submit a login, then on the pill click "Never for this site". Submit again → **no** pill appears.
3. Log into `passave.org` itself → **no** pill appears.

Expected: all three suppress the pill as described.

- [ ] **Step 4: Full test suite**

Run: `node --test`
Expected: PASS — all core unit tests pass.

- [ ] **Step 5: Commit (docs/notes only, if any)**

```bash
git add -A
git commit -m "test(capture): manual E2E verification pass" --allow-empty
```

---

## Notes for the implementer

- The core module is the only unit-tested unit by design; `content.js` and `background.js` are thin wiring around it, verified manually because Chrome's runtime and DOM aren't available under `node --test` (no jsdom, per the no-dependencies constraint).
- If the SPA click fallback proves too eager on a real site (double prompts), the 1s debounce in `handleCapture` is the first knob; tightening `isIdentifierInput` is the second.
- `password_secret` comparison in `resolveCaptureAction` relies on `/save/all` returning decrypted secrets (as the autofill path already does). If that ever changes, the "same password → suppress" branch must move server-side.
