# Refresh-Token Auth Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Passave Chrome extension from a single long-lived JWT to the backend's new access + refresh token pair, with the service worker as the sole owner of both tokens.

**Architecture:** Two new `lib/` modules follow the repo's existing UMD pattern — `auth-core.js` holds pure decision logic (what a failure code means, how long to back off) and `session-manager.js` holds the stateful orchestration (storage, single-flight refresh, `apiFetch`) with all its dependencies injected so it runs under `node --test`. `background.js` instantiates the manager and becomes the only context that reads tokens or calls authenticated endpoints; `popup.js` drops all token handling and talks to it over `chrome.runtime.sendMessage`.

**Tech Stack:** Vanilla JS, Chrome Manifest V3 service worker, `node --test` (no dependencies, no build step).

## Global Constraints

- **API base is `https://passave.org/api/v1`.** Auth calls are `/auth/login`, `/auth/refresh`, `/auth/signout` under that base. Do **not** use the web `/auth/*` mount.
- **Never wipe tokens on 403 or 429.** Only `401 TOKEN_INVALID`, `401 TOKEN_MISSING`, and refresh failures wipe.
- **`TOKEN_EXPIRED` retries the original request exactly once.** Never loop.
- **Exactly one refresh request may be in flight per service worker.** Enforced by a single module-scope promise.
- **Access token TTL comes from the response's `expiresIn` field.** Never hardcode 900.
- **Backward compatibility is required:** a login response with no `refreshToken` means a pre-cutover backend. Store the access token, arm no refresh loop, behave exactly as the extension does today.
- **Headers on every authenticated request:** `Authorization`, `X-Device-UUID`, `X-Device-Model: Chrome Extension`, `X-OS-Version`, `X-App-Version`, `X-Platform: extension`. All are already allowlisted in the backend's `CorsConf.js`; any *other* custom header would be silently stripped by Chrome.
- **`X-Device-UUID` must be stable per install**, generated once with `crypto.randomUUID()` and persisted. A missing or malformed value makes the server silently mint a fresh id per request.
- **No new files outside `lib/`, `tests/`, and the two existing entry points.** No new manifest permissions.
- **Existing `lib/` module style is mandatory:** `'use strict'`, the UMD wrapper from `lib/capture-core.js`, and a `tests/*.test.js` suite runnable with `npm test`.
- **Commit after every task.**

---

### Task 1: `lib/auth-core.js` — pure auth decision logic

**Files:**
- Create: `lib/auth-core.js`
- Test: `tests/auth-core.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces, on the `PassaveAuthCore` global / CommonJS export:
  - Action constants `REFRESH='refresh'`, `SIGNOUT='signout'`, `BACKOFF='backoff'`, `PERMISSION='permission'`, `OTHER='other'`, and `MAX_BACKOFF_MS=8000`
  - `isLegacyPayload(json) -> boolean`
  - `readAuthPayload(json, nowMs) -> { accessToken: string, refreshToken: string|null, expiresAt: number|null, legacy: boolean } | null`
  - `isAccessTokenExpired(record, nowMs) -> boolean`
  - `classifyApiFailure({ status, body }) -> string` (one of the action constants)
  - `classifyRefreshFailure({ status, body }) -> 'signout' | 'backoff'`
  - `nextBackoffDelay({ attempt, retryAfter, random }) -> number` (milliseconds)

- [ ] **Step 1: Write the failing test**

Create `tests/auth-core.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../lib/auth-core');

test('readAuthPayload: derives expiresAt from expiresIn, never a hardcoded TTL', () => {
  const out = core.readAuthPayload(
    { success: true, token: 'a.b.c', refreshToken: 'opaque', expiresIn: 900 },
    1_000_000,
  );
  assert.deepEqual(out, {
    accessToken: 'a.b.c',
    refreshToken: 'opaque',
    expiresAt: 1_000_000 + 900_000,
    legacy: false,
  });
});

test('readAuthPayload: no expiresIn leaves expiry unknown rather than guessing', () => {
  const out = core.readAuthPayload({ token: 'a.b.c', refreshToken: 'opaque' }, 5);
  assert.equal(out.expiresAt, null);
});

test('readAuthPayload: a pre-cutover response yields a legacy record', () => {
  const out = core.readAuthPayload({ success: true, token: 'legacy.jwt' }, 5);
  assert.equal(out.refreshToken, null);
  assert.equal(out.legacy, true);
});

test('readAuthPayload: no token at all is not a session', () => {
  assert.equal(core.readAuthPayload({ success: true }, 5), null);
  assert.equal(core.readAuthPayload(null, 5), null);
});

test('isLegacyPayload: keyed on the absence of refreshToken', () => {
  assert.equal(core.isLegacyPayload({ token: 't' }), true);
  assert.equal(core.isLegacyPayload({ token: 't', refreshToken: 'r' }), false);
});

test('isAccessTokenExpired: unknown expiry never counts as expired', () => {
  assert.equal(core.isAccessTokenExpired({ expiresAt: null }, 999), false);
  assert.equal(core.isAccessTokenExpired({ expiresAt: 1000 }, 999), false);
  assert.equal(core.isAccessTokenExpired({ expiresAt: 1000 }, 1000), true);
});

test('classifyApiFailure: TOKEN_EXPIRED is the only refreshable 401', () => {
  const at = (status, code) => core.classifyApiFailure({ status, body: { code } });
  assert.equal(at(401, 'TOKEN_EXPIRED'), core.REFRESH);
  assert.equal(at(401, 'TOKEN_INVALID'), core.SIGNOUT);
  assert.equal(at(401, 'TOKEN_MISSING'), core.SIGNOUT);
});

test('classifyApiFailure: a 401 with no code signs out rather than looping', () => {
  assert.equal(core.classifyApiFailure({ status: 401, body: null }), core.SIGNOUT);
});

test('classifyApiFailure: 403 and 429 never touch tokens', () => {
  assert.equal(
    core.classifyApiFailure({ status: 403, body: { code: 'INSUFFICIENT_PERMISSIONS' } }),
    core.PERMISSION,
  );
  assert.equal(core.classifyApiFailure({ status: 403, body: null }), core.PERMISSION);
  assert.equal(core.classifyApiFailure({ status: 429, body: null }), core.BACKOFF);
  assert.equal(core.classifyApiFailure({ status: 500, body: null }), core.OTHER);
});

test('classifyRefreshFailure: 429 backs off, spent tokens sign out', () => {
  assert.equal(core.classifyRefreshFailure({ status: 429, body: null }), core.BACKOFF);
  assert.equal(
    core.classifyRefreshFailure({ status: 401, body: { code: 'TOKEN_REUSED' } }),
    core.SIGNOUT,
  );
  assert.equal(
    core.classifyRefreshFailure({ status: 401, body: { code: 'TOKEN_INVALID' } }),
    core.SIGNOUT,
  );
  assert.equal(
    core.classifyRefreshFailure({ status: 400, body: { code: 'TOKEN_MISSING' } }),
    core.SIGNOUT,
  );
});

test('classifyRefreshFailure: a server blip keeps the 30-day credential', () => {
  assert.equal(core.classifyRefreshFailure({ status: 500, body: null }), core.BACKOFF);
  assert.equal(core.classifyRefreshFailure({ status: 0, body: null }), core.BACKOFF);
});

test('nextBackoffDelay: doubles per attempt, capped, with sub-second jitter', () => {
  const noJitter = { random: () => 0 };
  assert.equal(core.nextBackoffDelay({ attempt: 0, ...noJitter }), 1000);
  assert.equal(core.nextBackoffDelay({ attempt: 1, ...noJitter }), 2000);
  assert.equal(core.nextBackoffDelay({ attempt: 2, ...noJitter }), 4000);
  assert.equal(core.nextBackoffDelay({ attempt: 3, ...noJitter }), 8000);
  assert.equal(core.nextBackoffDelay({ attempt: 9, ...noJitter }), core.MAX_BACKOFF_MS);
  assert.equal(core.nextBackoffDelay({ attempt: 0, random: () => 0.5 }), 1500);
});

test('nextBackoffDelay: Retry-After wins over the local schedule', () => {
  assert.equal(core.nextBackoffDelay({ attempt: 0, retryAfter: 45, random: () => 0 }), 45_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/auth-core.test.js`
Expected: FAIL — `Cannot find module '../lib/auth-core'`

- [ ] **Step 3: Write the implementation**

Create `lib/auth-core.js`:

```js
'use strict';
/**
 * PASSAVE — auth-core.js
 * Pure decision logic for session auth: what a token payload contains, what a
 * failed response means, and how long to wait before trying again.
 *
 * No fetch, no chrome, no clock of its own — every input is passed in. The 401
 * contract is the part of this migration that is most expensive to get wrong
 * (treat TOKEN_INVALID as refreshable and you loop forever; treat TOKEN_EXPIRED
 * as fatal and you sign a user out every 15 minutes), so it lives here where
 * `node --test` can pin every branch of it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PassaveAuthCore = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const REFRESH = 'refresh';
  const SIGNOUT = 'signout';
  const BACKOFF = 'backoff';
  const PERMISSION = 'permission';
  const OTHER = 'other';

  const MAX_BACKOFF_MS = 8000;

  function str(value) {
    return typeof value === 'string' && value ? value : null;
  }

  function isLegacyPayload(json) {
    return !json || json.refreshToken == null;
  }

  /**
   * Read a login/refresh success body into the record we persist.
   * Returns null when there is no usable access token.
   */
  function readAuthPayload(json, nowMs) {
    const accessToken = str(json && json.token);
    if (!accessToken) return null;

    const refreshToken = str(json && json.refreshToken);

    // expiresIn is the server's word on the access token's TTL. When it is
    // absent there is nothing honest to compute from, so expiry stays unknown
    // and the pre-flight check simply never fires — the 401 still catches it.
    const expiresIn = json && json.expiresIn;
    const expiresAt =
      typeof expiresIn === 'number' && expiresIn > 0
        ? nowMs + expiresIn * 1000
        : null;

    return {
      accessToken,
      refreshToken,
      expiresAt,
      legacy: refreshToken === null,
    };
  }

  function isAccessTokenExpired(record, nowMs) {
    return (
      !!record &&
      typeof record.expiresAt === 'number' &&
      nowMs >= record.expiresAt
    );
  }

  /**
   * What a failed /api/v1 response means for the stored tokens.
   * Mirrors src/middleware/protectApi.js on the backend.
   */
  function classifyApiFailure(res) {
    const status = res && res.status;
    const code = res && res.body && res.body.code;

    if (status === 401) return code === 'TOKEN_EXPIRED' ? REFRESH : SIGNOUT;

    // Never wipe tokens for a 403: it is a verdict on the account's status (or
    // a CORS rejection), not on the token.
    if (status === 403) return PERMISSION;

    if (status === 429) return BACKOFF;

    return OTHER;
  }

  /**
   * What a failed /auth/refresh response means.
   *
   * 400 TOKEN_MISSING, 401 TOKEN_INVALID and 401 TOKEN_REUSED all mean the
   * refresh token is spent. Anything else — a 5xx, a proxy error page, a dead
   * network — is a transient condition, and backing off keeps a still-valid
   * 30-day credential that signing out would throw away.
   */
  function classifyRefreshFailure(res) {
    const status = res && res.status;
    if (status === 429) return BACKOFF;
    if (status === 400 || status === 401) return SIGNOUT;
    return BACKOFF;
  }

  /**
   * Milliseconds to wait before retry `attempt` (0-indexed).
   * A server-supplied Retry-After takes precedence over the local schedule.
   */
  function nextBackoffDelay(opts) {
    const o = opts || {};

    const retryAfter = Number(o.retryAfter);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.round(retryAfter * 1000);
    }

    const attempt = Number.isFinite(o.attempt) && o.attempt > 0 ? o.attempt : 0;
    const random = typeof o.random === 'function' ? o.random : Math.random;

    // Jitter matters more than usual here: the limiter buckets per IP, so a
    // whole office's extensions would otherwise re-collide in lockstep.
    const base = Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
    return Math.round(base + random() * 1000);
  }

  return {
    REFRESH,
    SIGNOUT,
    BACKOFF,
    PERMISSION,
    OTHER,
    MAX_BACKOFF_MS,
    isLegacyPayload,
    readAuthPayload,
    isAccessTokenExpired,
    classifyApiFailure,
    classifyRefreshFailure,
    nextBackoffDelay,
  };
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/auth-core.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/auth-core.js tests/auth-core.test.js
git commit -m "feat(auth): pure decision logic for the access/refresh token contract"
```

---

### Task 2: `lib/session-manager.js` — token storage, device id, headers

**Files:**
- Create: `lib/session-manager.js`
- Test: `tests/session-manager.test.js`

**Interfaces:**
- Consumes: `PassaveAuthCore` from Task 1.
- Produces, on the `PassaveSessionManager` global / CommonJS export:
  - `createSessionManager(deps) -> manager`, where `deps` is
    `{ fetch, storage, apiBase, appVersion, osVersion, now?, sleep?, random?, randomUuid? }`
  - Key constants `AUTH_KEY='auth'`, `LEGACY_TOKEN_KEY='token'`, `DEVICE_KEY='deviceUuid'`, `COOLDOWN_KEY='refreshCooldownUntil'`, `USERNAME_KEY='username'`
  - This task's manager methods: `getDeviceUuid()`, `getAuthRecord()`, `setAuthRecord(record)`, `clearAuthRecord()`, `buildHeaders(record, deviceUuid, extra)`
- Later tasks add `refreshTokens()`, `apiFetch()`, `login()`, `signOut()`, `getAuthState()` to the same factory.

- [ ] **Step 1: Write the failing test**

Create `tests/session-manager.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSessionManager } = require('../lib/session-manager');

// Stand-in for chrome.storage.local: promise-based, and shared across manager
// instances so "does this survive a service worker restart?" is expressible.
function fakeStorage(initial) {
  let data = Object.assign({}, initial);
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return Object.assign({}, data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) if (key in data) out[key] = data[key];
      return out;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    dump: () => Object.assign({}, data),
  };
}

// Minimal Response stand-in. `calls` records every request the manager made.
function fakeFetch(responses) {
  const calls = [];
  const queue = responses.slice();
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) throw new Error('fakeFetch: no response queued');
    if (next.throws) throw new Error('network down');
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (name) => (next.headers || {})[name] || null },
      json: async () => {
        if (next.body === undefined) throw new Error('not json');
        return next.body;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

function build(overrides) {
  const o = overrides || {};
  const storage = o.storage || fakeStorage();
  const fetchImpl = o.fetch || fakeFetch([{ status: 200, body: {} }]);
  const manager = createSessionManager({
    fetch: fetchImpl,
    storage,
    apiBase: 'https://passave.org/api/v1',
    appVersion: '2.6.0',
    osVersion: 'Test OS',
    now: o.now || (() => 1_000_000),
    sleep: o.sleep || (async () => {}),
    random: o.random || (() => 0),
    randomUuid: o.randomUuid || (() => 'fixed-uuid-0000-0000-000000000000'),
  });
  return { manager, storage, fetchImpl };
}

test('getDeviceUuid: mints once and reuses forever', async () => {
  const { manager, storage } = build();
  const first = await manager.getDeviceUuid();
  assert.equal(first, 'fixed-uuid-0000-0000-000000000000');
  assert.equal(storage.dump().deviceUuid, first);

  // A second manager over the same storage — i.e. a restarted worker — must
  // not mint a new id, or the server fragments this browser into many sessions.
  const second = createSessionManager({
    fetch: fakeFetch([{ status: 200, body: {} }]),
    storage,
    apiBase: 'https://passave.org/api/v1',
    appVersion: '2.6.0',
    osVersion: 'Test OS',
    randomUuid: () => 'a-different-uuid',
  });
  assert.equal(await second.getDeviceUuid(), first);
});

test('getAuthRecord: adopts a pre-migration bare token as a legacy record', async () => {
  const storage = fakeStorage({ token: 'old.jwt.value' });
  const { manager } = build({ storage });

  assert.deepEqual(await manager.getAuthRecord(), {
    accessToken: 'old.jwt.value',
    refreshToken: null,
    expiresAt: null,
    legacy: true,
  });

  // The duplicate credential must not be left lying on disk.
  assert.equal('token' in storage.dump(), false);
  assert.equal(storage.dump().auth.accessToken, 'old.jwt.value');
});

test('getAuthRecord: null when nothing is stored', async () => {
  const { manager } = build();
  assert.equal(await manager.getAuthRecord(), null);
});

test('clearAuthRecord: drops credentials but keeps the device id', async () => {
  const storage = fakeStorage({
    auth: { accessToken: 'a', refreshToken: 'r', expiresAt: null, legacy: false },
    username: 'jane',
    deviceUuid: 'keep-me',
  });
  const { manager } = build({ storage });
  await manager.clearAuthRecord();

  const after = storage.dump();
  assert.equal('auth' in after, false);
  assert.equal('username' in after, false);
  assert.equal(after.deviceUuid, 'keep-me');
});

test('buildHeaders: sends every allowlisted device header', async () => {
  const { manager } = build();
  const headers = manager.buildHeaders(
    { accessToken: 'a.b.c' },
    'device-1234-5678',
    { 'Content-Type': 'application/json' },
  );
  assert.deepEqual(headers, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Device-UUID': 'device-1234-5678',
    'X-Device-Model': 'Chrome Extension',
    'X-OS-Version': 'Test OS',
    'X-App-Version': '2.6.0',
    'X-Platform': 'extension',
    Authorization: 'Bearer a.b.c',
  });
});

test('buildHeaders: omits Authorization when there is no token', async () => {
  const { manager } = build();
  const headers = manager.buildHeaders(null, 'device-1234-5678');
  assert.equal('Authorization' in headers, false);
  assert.equal(headers['X-Platform'], 'extension');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/session-manager.test.js`
Expected: FAIL — `Cannot find module '../lib/session-manager'`

- [ ] **Step 3: Write the implementation**

Create `lib/session-manager.js`:

```js
'use strict';
/**
 * PASSAVE — session-manager.js
 * The service worker's sole owner of auth tokens.
 *
 * Nothing else in the extension reads or writes them. That is not tidiness for
 * its own sake: the refresh token is single-use and rotates on every redemption,
 * so two contexts refreshing at once is read server-side as token theft and
 * revokes the session. One owner means one module-scope in-flight promise, which
 * makes the race structurally impossible rather than merely unlikely.
 *
 * Every dependency is injected so the whole thing runs under `node --test`.
 */
(function (root, factory) {
  const core =
    typeof module !== 'undefined' && module.exports
      ? require('./auth-core')
      : root.PassaveAuthCore;
  const api = factory(core);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PassaveSessionManager = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function (core) {
  const AUTH_KEY = 'auth';
  const LEGACY_TOKEN_KEY = 'token';
  const DEVICE_KEY = 'deviceUuid';
  const COOLDOWN_KEY = 'refreshCooldownUntil';
  const USERNAME_KEY = 'username';

  function createSessionManager(deps) {
    const d = deps || {};
    const fetchImpl = d.fetch;
    const storage = d.storage;
    const apiBase = d.apiBase;
    const appVersion = d.appVersion || '0.0.0';
    const osVersion = d.osVersion || 'unknown';
    const now = d.now || (() => Date.now());
    const sleep = d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const random = d.random || Math.random;
    const randomUuid = d.randomUuid || (() => crypto.randomUUID());

    function read(keys) {
      return storage.get(keys);
    }

    /**
     * Stable per install. crypto.randomUUID() gives 36 chars of hex and dashes,
     * which satisfies the server's ^[A-Za-z0-9._:-]{8,128}$ check — a value that
     * fails it is not rejected, it is silently replaced with a fresh server-side
     * id, splitting this browser across many session rows.
     */
    async function getDeviceUuid() {
      const stored = (await read([DEVICE_KEY]))[DEVICE_KEY];
      if (typeof stored === 'string' && stored) return stored;
      const fresh = randomUuid();
      await storage.set({ [DEVICE_KEY]: fresh });
      return fresh;
    }

    async function getAuthRecord() {
      const stored = await read([AUTH_KEY, LEGACY_TOKEN_KEY]);

      const record = stored[AUTH_KEY];
      if (record && typeof record.accessToken === 'string' && record.accessToken) {
        return record;
      }

      // Installs upgrading from the single-token build carry a bare `token`.
      // Adopt it as a legacy record so the user stays signed in against a
      // pre-cutover backend, and drop the duplicate credential from disk.
      const legacy = stored[LEGACY_TOKEN_KEY];
      if (typeof legacy === 'string' && legacy) {
        const adopted = {
          accessToken: legacy,
          refreshToken: null,
          expiresAt: null,
          legacy: true,
        };
        await storage.set({ [AUTH_KEY]: adopted });
        await storage.remove(LEGACY_TOKEN_KEY);
        return adopted;
      }

      return null;
    }

    async function setAuthRecord(record) {
      await storage.set({ [AUTH_KEY]: record });
    }

    /**
     * The device id deliberately survives, so a returning user reuses their
     * existing session row instead of spawning a duplicate.
     */
    async function clearAuthRecord() {
      await storage.remove([AUTH_KEY, LEGACY_TOKEN_KEY, USERNAME_KEY]);
    }

    function buildHeaders(record, deviceUuid, extra) {
      const headers = Object.assign(
        {
          Accept: 'application/json',
          'X-Device-UUID': deviceUuid,
          'X-Device-Model': 'Chrome Extension',
          'X-OS-Version': osVersion,
          'X-App-Version': appVersion,
          'X-Platform': 'extension',
        },
        extra || {},
      );
      if (record && record.accessToken) {
        headers.Authorization = `Bearer ${record.accessToken}`;
      }
      return headers;
    }

    return {
      getDeviceUuid,
      getAuthRecord,
      setAuthRecord,
      clearAuthRecord,
      buildHeaders,
    };
  }

  return {
    createSessionManager,
    AUTH_KEY,
    LEGACY_TOKEN_KEY,
    DEVICE_KEY,
    COOLDOWN_KEY,
    USERNAME_KEY,
  };
});
```

Note: `fetchImpl`, `apiBase`, `now`, `sleep`, `random` and `core` are unused until Task 3 — that is expected, do not delete them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/session-manager.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/session-manager.js tests/session-manager.test.js
git commit -m "feat(auth): session manager storage, device id and request headers"
```

---

### Task 3: Single-flight refresh with rotation

**Files:**
- Modify: `lib/session-manager.js` (add inside `createSessionManager`, export the new method)
- Test: `tests/session-manager.test.js` (append)

**Interfaces:**
- Consumes: `getAuthRecord`, `setAuthRecord`, `clearAuthRecord`, `getDeviceUuid`, `buildHeaders` from Task 2; `core.readAuthPayload`, `core.classifyRefreshFailure`, `core.SIGNOUT` from Task 1.
- Produces: `refreshTokens() -> Promise<'ok' | 'signout' | 'unavailable'>`. Never rejects — the outcome is data. Also adds the internal helpers `readJson(res)`, `postJson(path, body, record, deviceUuid)` and `retryAfterSeconds(headers)` used by Tasks 4–6.

- [ ] **Step 1: Write the failing test**

Append to `tests/session-manager.test.js`:

```js
const signedIn = {
  auth: { accessToken: 'access.1', refreshToken: 'refresh.1', expiresAt: null, legacy: false },
  username: 'jane',
};

test('refreshTokens: stores both rotated tokens, never keeping the old one', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([
    { status: 200, body: { success: true, token: 'access.2', refreshToken: 'refresh.2', expiresIn: 900 } },
  ]);
  const { manager } = build({ storage, fetch: fetchImpl });

  assert.equal(await manager.refreshTokens(), 'ok');

  const stored = storage.dump().auth;
  assert.equal(stored.accessToken, 'access.2');
  assert.equal(stored.refreshToken, 'refresh.2');
  assert.equal(stored.expiresAt, 1_000_000 + 900_000);

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://passave.org/api/v1/auth/refresh');
  assert.equal(JSON.parse(call.init.body).refreshToken, 'refresh.1');
});

test('refreshTokens: concurrent callers share ONE request', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([
    { status: 200, body: { success: true, token: 'access.2', refreshToken: 'refresh.2', expiresIn: 900 } },
  ]);
  const { manager } = build({ storage, fetch: fetchImpl });

  const outcomes = await Promise.all([
    manager.refreshTokens(),
    manager.refreshTokens(),
    manager.refreshTokens(),
    manager.refreshTokens(),
    manager.refreshTokens(),
  ]);

  assert.deepEqual(outcomes, ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(fetchImpl.calls.length, 1, 'a second refresh would risk TOKEN_REUSED');
});

test('refreshTokens: the in-flight promise is released for the next cycle', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([
    { status: 200, body: { success: true, token: 'access.2', refreshToken: 'refresh.2', expiresIn: 900 } },
  ]);
  const { manager } = build({ storage, fetch: fetchImpl });

  await manager.refreshTokens();
  await manager.refreshTokens();
  assert.equal(fetchImpl.calls.length, 2);
});

test('refreshTokens: TOKEN_REUSED wipes immediately and never retries', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([
    { status: 401, body: { success: false, code: 'TOKEN_REUSED', message: 'revoked' } },
  ]);
  const { manager } = build({ storage, fetch: fetchImpl });

  assert.equal(await manager.refreshTokens(), 'signout');
  assert.equal('auth' in storage.dump(), false);
  assert.equal(fetchImpl.calls.length, 1);
});

test('refreshTokens: TOKEN_INVALID wipes', async () => {
  const storage = fakeStorage(signedIn);
  const { manager } = build({
    storage,
    fetch: fakeFetch([{ status: 401, body: { code: 'TOKEN_INVALID' } }]),
  });
  assert.equal(await manager.refreshTokens(), 'signout');
  assert.equal('auth' in storage.dump(), false);
});

test('refreshTokens: legacy mode never calls the refresh endpoint', async () => {
  const storage = fakeStorage({ token: 'old.jwt.value' });
  const fetchImpl = fakeFetch([{ status: 200, body: {} }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  assert.equal(await manager.refreshTokens(), 'signout');
  assert.equal(fetchImpl.calls.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/session-manager.test.js`
Expected: FAIL — `manager.refreshTokens is not a function`

- [ ] **Step 3: Write the implementation**

In `lib/session-manager.js`, add these declarations immediately after `const randomUuid = ...` inside `createSessionManager`:

```js
    // THE single-flight slot. Module-scope per manager instance, which is
    // per service worker — not per call, not per tab.
    let refreshInFlight = null;
```

Then add these functions after `buildHeaders`:

```js
    async function readJson(res) {
      try {
        return await res.json();
      } catch {
        return null;
      }
    }

    function retryAfterSeconds(headers) {
      if (!headers || typeof headers.get !== 'function') return null;
      const seconds = Number(headers.get('Retry-After'));
      return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    }

    async function postJson(path, body, record, deviceUuid) {
      const res = await fetchImpl(apiBase + path, {
        method: 'POST',
        credentials: 'omit',
        headers: buildHeaders(record, deviceUuid, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(body),
      });
      return {
        ok: res.ok,
        status: res.status,
        body: await readJson(res),
        headers: res.headers,
      };
    }

    /**
     * One refresh attempt. Resolves 'ok' | 'signout' | 'unavailable' and never
     * rejects: every caller treats the outcome as data, so a thrown error can
     * never leak past the single-flight slot and strand other awaiters.
     */
    async function doRefresh() {
      const record = await getAuthRecord();
      if (!record || !record.refreshToken) return 'signout';

      const deviceUuid = await getDeviceUuid();

      let res;
      try {
        res = await postJson(
          '/auth/refresh',
          { refreshToken: record.refreshToken },
          null,
          deviceUuid,
        );
      } catch {
        return 'unavailable';
      }

      if (res.ok) {
        const next = core.readAuthPayload(res.body, now());
        if (!next) return 'signout';
        // Both values, unconditionally. The refresh token rotated server-side
        // the moment it was presented; keeping the old one is never correct.
        await setAuthRecord(next);
        return 'ok';
      }

      if (core.classifyRefreshFailure(res) === core.SIGNOUT) {
        await clearAuthRecord();
        return 'signout';
      }

      return 'unavailable';
    }

    /**
     * Every caller that needs a fresh access token awaits this same promise —
     * whether or not it was the one that started the refresh.
     */
    function refreshTokens() {
      if (refreshInFlight) return refreshInFlight;
      refreshInFlight = doRefresh().finally(() => {
        refreshInFlight = null;
      });
      return refreshInFlight;
    }
```

Add `refreshTokens` to the object returned by `createSessionManager`:

```js
    return {
      getDeviceUuid,
      getAuthRecord,
      setAuthRecord,
      clearAuthRecord,
      buildHeaders,
      refreshTokens,
    };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/session-manager.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/session-manager.js tests/session-manager.test.js
git commit -m "feat(auth): single-flight token refresh with rotation"
```

---

### Task 4: 429 backoff and a cooldown that survives worker death

**Files:**
- Modify: `lib/session-manager.js` (replace `doRefresh`, add two constants)
- Test: `tests/session-manager.test.js` (append)

**Interfaces:**
- Consumes: everything from Task 3, plus `core.nextBackoffDelay`, `core.BACKOFF`, and the injected `sleep`/`random`.
- Produces: unchanged `refreshTokens()` signature. New exported constants `MAX_REFRESH_ATTEMPTS = 4` and `MAX_SLEEP_MS = 10000`, `MAX_COOLDOWN_MS = 60000`. Writes `refreshCooldownUntil` (epoch ms) to storage when it gives up.

- [ ] **Step 1: Write the failing test**

Append to `tests/session-manager.test.js`:

```js
test('refreshTokens: a 429 retries with backoff and never wipes tokens', async () => {
  const storage = fakeStorage(signedIn);
  const slept = [];
  const fetchImpl = fakeFetch([
    { status: 429, body: { success: false, message: 'Too many token refresh attempts, please sign in again' } },
    { status: 200, body: { success: true, token: 'access.2', refreshToken: 'refresh.2', expiresIn: 900 } },
  ]);
  const { manager } = build({
    storage,
    fetch: fetchImpl,
    sleep: async (ms) => slept.push(ms),
  });

  assert.equal(await manager.refreshTokens(), 'ok');
  assert.deepEqual(slept, [1000]);
  assert.equal(storage.dump().auth.refreshToken, 'refresh.2');
});

test('refreshTokens: sustained 429 gives up without signing the user out', async () => {
  const storage = fakeStorage(signedIn);
  const slept = [];
  const fetchImpl = fakeFetch([{ status: 429, body: { success: false } }]);
  const { manager } = build({
    storage,
    fetch: fetchImpl,
    sleep: async (ms) => slept.push(ms),
  });

  assert.equal(await manager.refreshTokens(), 'unavailable');
  assert.equal(fetchImpl.calls.length, 4);
  assert.deepEqual(slept, [1000, 2000, 4000]);

  // The 30-day credential is still good; only the cooldown is recorded.
  assert.equal(storage.dump().auth.refreshToken, 'refresh.1');
  assert.equal(storage.dump().refreshCooldownUntil, 1_000_000 + 60_000);
});

test('refreshTokens: a live cooldown short-circuits without any request', async () => {
  const storage = fakeStorage(
    Object.assign({ refreshCooldownUntil: 1_000_001 }, signedIn),
  );
  const fetchImpl = fakeFetch([{ status: 200, body: {} }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  assert.equal(await manager.refreshTokens(), 'unavailable');
  assert.equal(fetchImpl.calls.length, 0, 'a fresh worker must not re-hammer a limited IP');
});

test('refreshTokens: an expired cooldown does not block', async () => {
  const storage = fakeStorage(
    Object.assign({ refreshCooldownUntil: 999_999 }, signedIn),
  );
  const fetchImpl = fakeFetch([
    { status: 200, body: { success: true, token: 'access.2', refreshToken: 'refresh.2', expiresIn: 900 } },
  ]);
  const { manager } = build({ storage, fetch: fetchImpl });

  assert.equal(await manager.refreshTokens(), 'ok');
  assert.equal('refreshCooldownUntil' in storage.dump(), false);
});

test('refreshTokens: a long Retry-After is parked, not slept through', async () => {
  const storage = fakeStorage(signedIn);
  const slept = [];
  const fetchImpl = fakeFetch([
    { status: 429, body: { success: false }, headers: { 'Retry-After': '120' } },
  ]);
  const { manager } = build({
    storage,
    fetch: fetchImpl,
    sleep: async (ms) => slept.push(ms),
  });

  // An MV3 worker will not live for two minutes, so the wait goes to storage.
  assert.equal(await manager.refreshTokens(), 'unavailable');
  assert.deepEqual(slept, []);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(storage.dump().refreshCooldownUntil, 1_000_000 + 120_000);
  assert.equal(storage.dump().auth.refreshToken, 'refresh.1');
});

test('refreshTokens: a network failure backs off instead of signing out', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([{ throws: true }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  assert.equal(await manager.refreshTokens(), 'unavailable');
  assert.equal(storage.dump().auth.refreshToken, 'refresh.1');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/session-manager.test.js`
Expected: FAIL — the first new test fails because the single 429 attempt returns `'unavailable'` with no retry.

- [ ] **Step 3: Write the implementation**

In `lib/session-manager.js`, add next to the other key constants at the top of the factory module (beside `USERNAME_KEY`):

```js
  const MAX_REFRESH_ATTEMPTS = 4;
  // An MV3 worker is evicted after ~30s idle and a pending timer does not hold
  // it open, so anything longer than this is not a wait this context can serve.
  const MAX_SLEEP_MS = 10000;
  const MAX_COOLDOWN_MS = 60000;
```

Replace the whole `doRefresh` function from Task 3 with:

```js
    /**
     * Refresh with bounded backoff. Resolves 'ok' | 'signout' | 'unavailable'
     * and never rejects.
     *
     * A 429 here says nothing about the tokens — the limiter buckets per IP, so
     * an office behind one egress address can be limited by other people's
     * traffic. Its message even reads "please sign in again"; that is misleading
     * and is ignored in favour of the status code. Signing out would discard a
     * still-valid 30-day credential over a transient condition.
     */
    async function doRefresh() {
      const record = await getAuthRecord();
      if (!record || !record.refreshToken) return 'signout';

      const cooldown = (await read([COOLDOWN_KEY]))[COOLDOWN_KEY];
      if (typeof cooldown === 'number' && now() < cooldown) return 'unavailable';

      const deviceUuid = await getDeviceUuid();

      for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt++) {
        // Re-read every attempt: a rotation may have landed server-side even
        // though the response was lost, and retrying with a stale token is
        // exactly what reads as reuse.
        const current = await getAuthRecord();
        if (!current || !current.refreshToken) return 'signout';

        let res;
        try {
          res = await postJson(
            '/auth/refresh',
            { refreshToken: current.refreshToken },
            null,
            deviceUuid,
          );
        } catch {
          res = { ok: false, status: 0, body: null, headers: null };
        }

        if (res.ok) {
          const next = core.readAuthPayload(res.body, now());
          if (!next) return 'signout';
          // Both values, unconditionally. The refresh token rotated server-side
          // the moment it was presented; keeping the old one is never correct.
          await setAuthRecord(next);
          await storage.remove(COOLDOWN_KEY);
          return 'ok';
        }

        if (core.classifyRefreshFailure(res) === core.SIGNOUT) {
          await clearAuthRecord();
          return 'signout';
        }

        const delay = core.nextBackoffDelay({
          attempt,
          retryAfter: retryAfterSeconds(res.headers),
          random,
        });

        // Too long to wait inside a worker that may be killed mid-sleep. Park
        // it in storage instead — the next wake-up, in whatever worker
        // instance, honours it rather than re-hammering a limited IP.
        if (delay > MAX_SLEEP_MS) {
          await storage.set({ [COOLDOWN_KEY]: now() + delay });
          return 'unavailable';
        }

        // Nothing follows the final attempt, so waiting before it would only
        // hold the worker open for no reason.
        if (attempt === MAX_REFRESH_ATTEMPTS - 1) break;

        await sleep(delay);
      }

      await storage.set({ [COOLDOWN_KEY]: now() + MAX_COOLDOWN_MS });
      return 'unavailable';
    }
```

Add the new constants to the module's return value:

```js
  return {
    createSessionManager,
    AUTH_KEY,
    LEGACY_TOKEN_KEY,
    DEVICE_KEY,
    COOLDOWN_KEY,
    USERNAME_KEY,
    MAX_REFRESH_ATTEMPTS,
    MAX_SLEEP_MS,
    MAX_COOLDOWN_MS,
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/session-manager.test.js`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/session-manager.js tests/session-manager.test.js
git commit -m "feat(auth): bounded 429 backoff with a cooldown that outlives the worker"
```

---

### Task 5: `apiFetch` — the 401 contract with a single retry

**Files:**
- Modify: `lib/session-manager.js`
- Test: `tests/session-manager.test.js` (append)

**Interfaces:**
- Consumes: `refreshTokens`, `getAuthRecord`, `clearAuthRecord`, `getDeviceUuid`, `buildHeaders`; `core.classifyApiFailure`, `core.isAccessTokenExpired`, and the action constants.
- Produces: `apiFetch(path, init) -> Promise<Result>` where `path` is relative to `apiBase` (e.g. `'/save/all'`) and

  ```js
  // success
  { ok: true,  status: number, body: object|null }
  // failure
  { ok: false, status: number, body: object|null, reason: string }
  // reason ∈ 'signed_out' | 'permission' | 'network_unavailable' | 'network' | 'http'
  ```

  `'signed_out'` means the manager has already wiped the tokens. Never rejects.

- [ ] **Step 1: Write the failing test**

Append to `tests/session-manager.test.js`:

```js
test('apiFetch: sends the bearer token and returns the parsed body', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([{ status: 200, body: { success: true, saves: [{ _id: '1' }] } }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  const res = await manager.apiFetch('/save/all');
  assert.equal(res.ok, true);
  assert.deepEqual(res.body.saves, [{ _id: '1' }]);

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://passave.org/api/v1/save/all');
  assert.equal(call.init.headers.Authorization, 'Bearer access.1');
  assert.equal(call.init.headers['X-Platform'], 'extension');
  assert.equal(call.init.credentials, 'omit');
});

test('apiFetch: TOKEN_EXPIRED refreshes and retries exactly once', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([
    { status: 401, body: { code: 'TOKEN_EXPIRED' } },
    { status: 200, body: { success: true, token: 'access.2', refreshToken: 'refresh.2', expiresIn: 900 } },
    { status: 200, body: { success: true, saves: [] } },
  ]);
  const { manager } = build({ storage, fetch: fetchImpl });

  const res = await manager.apiFetch('/save/all');
  assert.equal(res.ok, true);
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(fetchImpl.calls[1].url, 'https://passave.org/api/v1/auth/refresh');
  // The retry must carry the NEW access token, not the one that just 401'd.
  assert.equal(fetchImpl.calls[2].init.headers.Authorization, 'Bearer access.2');
});

test('apiFetch: a second 401 after refresh signs out instead of looping', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([
    { status: 401, body: { code: 'TOKEN_EXPIRED' } },
    { status: 200, body: { success: true, token: 'access.2', refreshToken: 'refresh.2', expiresIn: 900 } },
    { status: 401, body: { code: 'TOKEN_EXPIRED' } },
  ]);
  const { manager } = build({ storage, fetch: fetchImpl });

  const res = await manager.apiFetch('/save/all');
  assert.equal(res.reason, 'signed_out');
  assert.equal(fetchImpl.calls.length, 3, 'a fourth call would be the start of a refresh loop');
  assert.equal('auth' in storage.dump(), false);
});

test('apiFetch: TOKEN_INVALID wipes without attempting a refresh', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([{ status: 401, body: { code: 'TOKEN_INVALID' } }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  const res = await manager.apiFetch('/save/all');
  assert.equal(res.reason, 'signed_out');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal('auth' in storage.dump(), false);
});

test('apiFetch: 403 INSUFFICIENT_PERMISSIONS keeps the user signed in', async () => {
  const storage = fakeStorage(signedIn);
  const { manager } = build({
    storage,
    fetch: fakeFetch([{ status: 403, body: { code: 'INSUFFICIENT_PERMISSIONS', message: 'Verify your email' } }]),
  });

  const res = await manager.apiFetch('/save/all');
  assert.equal(res.reason, 'permission');
  assert.equal(res.body.message, 'Verify your email');
  assert.equal(storage.dump().auth.accessToken, 'access.1');
});

test('apiFetch: 429 keeps the user signed in', async () => {
  const storage = fakeStorage(signedIn);
  const { manager } = build({
    storage,
    fetch: fakeFetch([{ status: 429, body: { success: false } }]),
  });

  const res = await manager.apiFetch('/save/all');
  assert.equal(res.reason, 'network_unavailable');
  assert.equal(storage.dump().auth.accessToken, 'access.1');
});

test('apiFetch: an expired access token refreshes before spending a request', async () => {
  const storage = fakeStorage({
    auth: { accessToken: 'access.1', refreshToken: 'refresh.1', expiresAt: 999_999, legacy: false },
  });
  const fetchImpl = fakeFetch([
    { status: 200, body: { success: true, token: 'access.2', refreshToken: 'refresh.2', expiresIn: 900 } },
    { status: 200, body: { success: true, saves: [] } },
  ]);
  const { manager } = build({ storage, fetch: fetchImpl });

  await manager.apiFetch('/save/all');
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].url, 'https://passave.org/api/v1/auth/refresh');
});

test('apiFetch: legacy mode 401s straight to signed out, no refresh call', async () => {
  const storage = fakeStorage({ token: 'old.jwt.value' });
  const fetchImpl = fakeFetch([{ status: 401, body: { code: 'TOKEN_EXPIRED' } }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  const res = await manager.apiFetch('/save/all');
  assert.equal(res.reason, 'signed_out');
  assert.equal(fetchImpl.calls.length, 1);
  // The dead legacy token must not survive to fake a signed-in popup.
  assert.equal('auth' in storage.dump(), false);
});

test('apiFetch: no stored session reports signed out without a request', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: {} }]);
  const { manager } = build({ fetch: fetchImpl });

  const res = await manager.apiFetch('/save/all');
  assert.equal(res.reason, 'signed_out');
  assert.equal(fetchImpl.calls.length, 0);
});

test('apiFetch: a dead network is reported as network, not as a token failure', async () => {
  const storage = fakeStorage(signedIn);
  const { manager } = build({ storage, fetch: fakeFetch([{ throws: true }]) });

  const res = await manager.apiFetch('/save/all');
  assert.equal(res.reason, 'network');
  assert.equal(storage.dump().auth.accessToken, 'access.1');
});

test('apiFetch: passes method and body through for writes', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([{ status: 200, body: { success: true } }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  await manager.apiFetch('/save/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'GitHub' }),
  });

  const call = fetchImpl.calls[0];
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.headers.Authorization, 'Bearer access.1');
  assert.equal(JSON.parse(call.init.body).name, 'GitHub');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/session-manager.test.js`
Expected: FAIL — `manager.apiFetch is not a function`

- [ ] **Step 3: Write the implementation**

In `lib/session-manager.js`, add after `refreshTokens`:

```js
    function fail(res, reason) {
      return {
        ok: false,
        status: (res && res.status) || 0,
        body: (res && res.body) || null,
        reason,
      };
    }

    /**
     * The only way anything in this extension talks to an authenticated
     * endpoint. `path` is relative to apiBase, e.g. '/save/all'.
     */
    async function apiFetch(path, init) {
      const deviceUuid = await getDeviceUuid();

      const send = async (record) => {
        const res = await fetchImpl(
          apiBase + path,
          Object.assign({ credentials: 'omit' }, init, {
            headers: buildHeaders(record, deviceUuid, (init && init.headers) || null),
          }),
        );
        return {
          ok: res.ok,
          status: res.status,
          body: await readJson(res),
          headers: res.headers,
        };
      };

      let record = await getAuthRecord();
      if (!record) return fail(null, 'signed_out');

      // Pre-flight: a token we already know has expired buys nothing but a
      // guaranteed 401. The 401 remains the authority — this is a shortcut, so
      // clock skew can cost a round trip but can never decide auth.
      if (core.isAccessTokenExpired(record, now()) && record.refreshToken) {
        const outcome = await refreshTokens();
        if (outcome === 'signout') {
          // Idempotent: doRefresh may have cleared already, but a legacy record
          // reaches 'signout' without ever touching storage.
          await clearAuthRecord();
          return fail(null, 'signed_out');
        }
        if (outcome !== 'ok') return fail(null, 'network_unavailable');
        record = await getAuthRecord();
        if (!record) return fail(null, 'signed_out');
      }

      let res;
      try {
        res = await send(record);
      } catch {
        return fail(null, 'network');
      }
      if (res.ok) return { ok: true, status: res.status, body: res.body };

      const action = core.classifyApiFailure(res);

      if (action === core.SIGNOUT) {
        await clearAuthRecord();
        return fail(res, 'signed_out');
      }
      if (action === core.PERMISSION) return fail(res, 'permission');
      if (action === core.BACKOFF) return fail(res, 'network_unavailable');
      if (action !== core.REFRESH) return fail(res, 'http');

      const outcome = await refreshTokens();
      if (outcome === 'signout') {
        // Idempotent, and the only path that clears a legacy record: a pre-
        // cutover session has no refresh token, so doRefresh returns early
        // without touching storage. Leaving it behind would show the popup a
        // signed-in state backed by a dead token on every reopen.
        await clearAuthRecord();
        return fail(res, 'signed_out');
      }
      if (outcome !== 'ok') return fail(res, 'network_unavailable');

      const refreshed = await getAuthRecord();
      if (!refreshed) return fail(res, 'signed_out');

      try {
        res = await send(refreshed);
      } catch {
        return fail(null, 'network');
      }
      if (res.ok) return { ok: true, status: res.status, body: res.body };

      // Exactly one retry. A token minted seconds ago that still comes back
      // unauthorized is not going to be fixed by refreshing again — treating it
      // as refreshable is precisely how an infinite refresh loop starts.
      const second = core.classifyApiFailure(res);
      if (second === core.REFRESH || second === core.SIGNOUT) {
        await clearAuthRecord();
        return fail(res, 'signed_out');
      }
      if (second === core.PERMISSION) return fail(res, 'permission');
      if (second === core.BACKOFF) return fail(res, 'network_unavailable');
      return fail(res, 'http');
    }
```

Add `apiFetch` to the returned object:

```js
    return {
      getDeviceUuid,
      getAuthRecord,
      setAuthRecord,
      clearAuthRecord,
      buildHeaders,
      refreshTokens,
      apiFetch,
    };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/session-manager.test.js`
Expected: PASS, 29 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/session-manager.js tests/session-manager.test.js
git commit -m "feat(auth): apiFetch honouring the 401 code contract with a single retry"
```

---

### Task 6: `login`, `signOut`, `getAuthState`

**Files:**
- Modify: `lib/session-manager.js`
- Test: `tests/session-manager.test.js` (append)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `login({ email, password, otp }) -> Promise<{ success: true, username: string } | { success: false, message: string }>`
  - `signOut() -> Promise<{ success: true }>`
  - `getAuthState() -> Promise<{ signedIn: boolean, username: string|null }>`

- [ ] **Step 1: Write the failing test**

Append to `tests/session-manager.test.js`:

```js
test('login: stores the pair and derives a username', async () => {
  const storage = fakeStorage();
  const fetchImpl = fakeFetch([
    { status: 200, body: { success: true, token: 'access.1', refreshToken: 'refresh.1', expiresIn: 900 } },
  ]);
  const { manager } = build({ storage, fetch: fetchImpl });

  const out = await manager.login({ email: 'jane@example.com', password: 'pw', otp: '123456' });
  assert.deepEqual(out, { success: true, username: 'jane' });

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://passave.org/api/v1/auth/login');
  assert.deepEqual(JSON.parse(call.init.body), {
    email: 'jane@example.com',
    password: 'pw',
    otp: '123456',
  });
  assert.equal(storage.dump().auth.refreshToken, 'refresh.1');
  assert.equal(storage.dump().username, 'jane');
});

test('login: a pre-cutover backend yields a legacy session and no refresh loop', async () => {
  const storage = fakeStorage();
  const { manager } = build({
    storage,
    fetch: fakeFetch([{ status: 200, body: { success: true, token: 'legacy.jwt' } }]),
  });

  assert.equal((await manager.login({ email: 'jane@example.com', password: 'pw', otp: '1' })).success, true);
  assert.equal(storage.dump().auth.legacy, true);
  assert.equal(storage.dump().auth.refreshToken, null);
});

test('login: surfaces the API message on failure and stores nothing', async () => {
  const storage = fakeStorage();
  const { manager } = build({
    storage,
    fetch: fakeFetch([{ status: 401, body: { success: false, message: 'Invalid OTP. Please try again or contact support.' } }]),
  });

  const out = await manager.login({ email: 'jane@example.com', password: 'pw', otp: '000000' });
  assert.equal(out.success, false);
  assert.equal(out.message, 'Invalid OTP. Please try again or contact support.');
  assert.equal('auth' in storage.dump(), false);
});

test('login: a dead network reports a network error, not a credential error', async () => {
  const { manager } = build({ fetch: fakeFetch([{ throws: true }]) });
  const out = await manager.login({ email: 'jane@example.com', password: 'pw', otp: '1' });
  assert.equal(out.success, false);
  assert.match(out.message, /connection/i);
});

test('login: clears a stale cooldown from a previous session', async () => {
  const storage = fakeStorage({ refreshCooldownUntil: 9_999_999 });
  const { manager } = build({
    storage,
    fetch: fakeFetch([{ status: 200, body: { success: true, token: 'a', refreshToken: 'r', expiresIn: 900 } }]),
  });

  await manager.login({ email: 'jane@example.com', password: 'pw', otp: '1' });
  assert.equal('refreshCooldownUntil' in storage.dump(), false);
});

test('signOut: revokes with the bearer header BEFORE clearing storage', async () => {
  const storage = fakeStorage(signedIn);
  const seen = [];
  const fetchImpl = async (url, init) => {
    // Read storage at request time: proving order, not just the header value.
    seen.push({ url, auth: init.headers.Authorization, stillStored: storage.dump().auth });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true }) };
  };
  const { manager } = build({ storage, fetch: fetchImpl });

  assert.deepEqual(await manager.signOut(), { success: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://passave.org/api/v1/auth/signout');
  assert.equal(seen[0].auth, 'Bearer access.1');
  assert.ok(seen[0].stillStored, 'clearing first would leave nothing to revoke with');
  assert.equal('auth' in storage.dump(), false);
});

test('signOut: clears locally even when the revoke call fails', async () => {
  const storage = fakeStorage(signedIn);
  const { manager } = build({ storage, fetch: fakeFetch([{ throws: true }]) });

  assert.deepEqual(await manager.signOut(), { success: true });
  assert.equal('auth' in storage.dump(), false);
});

test('signOut: with no stored session, skips the request', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: {} }]);
  const { manager } = build({ fetch: fetchImpl });

  await manager.signOut();
  assert.equal(fetchImpl.calls.length, 0);
});

test('getAuthState: reports the stored session', async () => {
  const { manager } = build({ storage: fakeStorage(signedIn) });
  assert.deepEqual(await manager.getAuthState(), { signedIn: true, username: 'jane' });

  const { manager: empty } = build();
  assert.deepEqual(await empty.getAuthState(), { signedIn: false, username: null });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/session-manager.test.js`
Expected: FAIL — `manager.login is not a function`

- [ ] **Step 3: Write the implementation**

In `lib/session-manager.js`, add after `apiFetch`:

```js
    async function login(credentials) {
      const c = credentials || {};
      const deviceUuid = await getDeviceUuid();

      let res;
      try {
        res = await postJson(
          '/auth/login',
          { email: c.email, password: c.password, otp: c.otp },
          null,
          deviceUuid,
        );
      } catch {
        return { success: false, message: 'Network error — check your connection.' };
      }

      if (!res.ok || !res.body || res.body.success !== true) {
        return {
          success: false,
          message:
            (res.body && res.body.message) || 'Login failed. Check your credentials.',
        };
      }

      const record = core.readAuthPayload(res.body, now());
      if (!record) {
        return {
          success: false,
          message: 'Authentication failed: No secure token received from server.',
        };
      }

      const username =
        (res.body.user && res.body.user.username) ||
        String(c.email || '').split('@')[0];

      await setAuthRecord(record);
      await storage.set({ [USERNAME_KEY]: username });
      // A fresh session is not bound by the previous one's rate-limit penalty.
      await storage.remove(COOLDOWN_KEY);

      return { success: true, username };
    }

    /**
     * Sign-out is best-effort server-side and unconditional locally.
     *
     * The Bearer header is the only channel that works here: the extension's
     * cookies are SameSite=Lax and a chrome-extension:// origin sends none of
     * them, so without the header the server would cheerfully 200 having
     * revoked nothing — leaving the refresh token redeemable for 30 days.
     * An expired access token is fine and is the normal case; the server
     * verifies it with ignoreExpiration, so it still names its session.
     */
    async function signOut() {
      const record = await getAuthRecord();

      if (record && record.accessToken) {
        const deviceUuid = await getDeviceUuid();
        try {
          await postJson('/auth/signout', {}, record, deviceUuid);
        } catch {
          // Best effort. A network failure must never strand the user in a
          // signed-in UI, so the local clear below happens regardless.
        }
      }

      await clearAuthRecord();
      return { success: true };
    }

    async function getAuthState() {
      const record = await getAuthRecord();
      const stored = await read([USERNAME_KEY]);
      return {
        signedIn: !!record,
        username: stored[USERNAME_KEY] || null,
      };
    }
```

Add all three to the returned object:

```js
    return {
      getDeviceUuid,
      getAuthRecord,
      setAuthRecord,
      clearAuthRecord,
      buildHeaders,
      refreshTokens,
      apiFetch,
      login,
      signOut,
      getAuthState,
    };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all suites, 38 session-manager tests plus the existing capture suites.

- [ ] **Step 5: Commit**

```bash
git add lib/session-manager.js tests/session-manager.test.js
git commit -m "feat(auth): login, server-side sign-out and auth state on the session manager"
```

---

### Task 7: Wire `background.js` to the session manager

**Files:**
- Modify: `background.js` (lines 6–23 imports/helpers, 26–51 `fetchDomainMatches`, 69–87 `handleCheckMatches`, 90–100 `handleCaptureSubmit`, 143–183 `handleSaveCredential`, 194–222 router)

**Interfaces:**
- Consumes: `PassaveSessionManager.createSessionManager` and every manager method from Tasks 2–6.
- Produces four new message types the popup will use in Task 8:
  - `{ type: 'AUTH_STATE' }` → `{ signedIn: boolean, username: string|null }`
  - `{ type: 'AUTH_LOGIN', credentials: { email, password, otp } }` → `{ success, username?, message? }`
  - `{ type: 'AUTH_LOGOUT' }` → `{ success: true }`
  - `{ type: 'VAULT_FETCH' }` → `{ success: boolean, saves: array, reason?: string }`

This task has no unit test of its own — it is wiring over code that Tasks 1–6 already cover. Step 5 is a manual smoke test.

- [ ] **Step 1: Replace the header block (lines 6–23)**

```js
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
```

`getToken()` is deleted — nothing may read the token directly any more.

- [ ] **Step 2: Replace `fetchDomainMatches` (lines 26–51)**

```js
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
```

- [ ] **Step 3: Update the three handlers that used `getToken`**

Replace `handleCheckMatches` (lines 69–87):

```js
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
```

Replace the opening of `handleCaptureSubmit` (lines 90–100):

```js
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
```

The rest of `handleCaptureSubmit` is unchanged.

Replace the body of `handleSaveCredential` from the token read to the end (lines 148–183):

```js
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
```

- [ ] **Step 4: Add the four popup handlers and register them**

Add above the message router:

```js
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
```

Add to the router, before its closing brace:

```js
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
```

- [ ] **Step 5: Verify by loading the extension**

```bash
npm test
```
Expected: PASS (nothing here is unit-tested, but nothing may regress).

Then load the unpacked extension at `chrome://extensions` and confirm in the service worker console:
- No `importScripts` or `ReferenceError` on startup.
- `await chrome.storage.local.get(null)` shows a `deviceUuid` after the first vault call.

- [ ] **Step 6: Commit**

```bash
git add background.js
git commit -m "feat(auth): route all worker traffic through the session manager"
```

---

### Task 8: Strip token handling out of `popup.js`

**Files:**
- Modify: `popup.js` (line 6 constant, 43–57 init, 183–229 login, 250–262 logout, 265–303 fetch)

**Interfaces:**
- Consumes: the four message types from Task 7.
- Produces: no exports. After this task, `popup.js` contains no `fetch(`, no `Authorization`, and no `chrome.storage.local` reference at all.

- [ ] **Step 1: Delete the API constant (line 6)**

Remove `const API = 'https://passave.org/api/v1';` — the popup no longer makes network calls.

- [ ] **Step 2: Replace the init block (lines 43–57)**

```js
document.addEventListener('DOMContentLoaded', async () => {
  setGreeting();
  await getCurrentTab();

  // Tokens live in the service worker. The popup only ever asks.
  const state = await chrome.runtime.sendMessage({ type: 'AUTH_STATE' });
  if (state && state.signedIn) {
    showVault(state.username);
    fetchSaves();
  } else {
    showLogin();
  }

  bindEvents();
});
```

- [ ] **Step 3: Replace `handleLogin` (lines 183–229)**

```js
async function handleLogin(e) {
  e.preventDefault();
  setLoginLoading(true);
  hideError();

  const email = loginEmail.value.trim();
  const password = loginPassword.value;
  const otp = loginOtp.value.trim();

  const result = await chrome.runtime.sendMessage({
    type: 'AUTH_LOGIN',
    credentials: { email, password, otp },
  });

  setLoginLoading(false);

  if (!result || !result.success) {
    showError((result && result.message) || 'Login failed. Check your credentials.');
    return;
  }

  showVault(result.username);
  fetchSaves();
}
```

- [ ] **Step 4: Replace `handleLogout` (lines 250–262)**

The logout button must reach the server before anything is cleared, so it goes
through the worker. `resetToLogin` is the UI half, reused when the worker
reports that the session is already gone.

```js
async function handleLogout() {
  await chrome.runtime.sendMessage({ type: 'AUTH_LOGOUT' });
  resetToLogin();
}

function resetToLogin() {
  allSaves = [];
  currentSave = null;
  loginForm.reset();
  closeDetail();

  // 🛡️ FIX: Hide banner if it was open during logout
  if (pageMatchBanner) pageMatchBanner.style.display = 'none';

  showLogin();
}
```

- [ ] **Step 5: Replace `fetchSaves` (lines 265–303)**

```js
async function fetchSaves() {
  savesList.innerHTML = `
    <div class="loading-state">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <p>Decrypting vault…</p>
    </div>`;

  const res = await chrome.runtime.sendMessage({ type: 'VAULT_FETCH' });

  if (!res || !res.success) {
    // Only a real token failure returns to the sign-in screen. A rate limit or
    // a dead network leaves a valid 30-day session in place — throwing it away
    // over a transient condition is the expensive mistake here.
    if (res && res.reason === 'signed_out') {
      showToast('Session ended — please sign in again.', 'error');
      resetToLogin();
      return;
    }

    const message =
      res && res.reason === 'network_unavailable'
        ? "Can't reach Passave right now — try again in a moment."
        : 'Could not reach vault — check your connection.';
    showToast(message, 'error');
    savesList.innerHTML = `
      <div class="empty-state">
        <p style="color: var(--danger)">${escapeHtml(message)}</p>
      </div>`;
    return;
  }

  allSaves = res.saves || [];
  vaultCount.textContent = allSaves.length;
  renderSaves(allSaves);
  checkPageMatch();
}
```

- [ ] **Step 6: Verify no token handling survives**

```bash
grep -n "fetch(\|Authorization\|storage.local\|const API" popup.js
```
Expected: **no output.**

- [ ] **Step 7: Manual smoke test**

Reload the unpacked extension, then:
- Open the popup signed out → sign-in screen appears.
- Sign in with a valid email / password / TOTP → vault renders.
- Close and reopen the popup → still signed in, no re-login.
- Click sign out → returns to sign-in, and `chrome.storage.local` retains `deviceUuid` but no `auth`.

- [ ] **Step 8: Commit**

```bash
git add popup.js
git commit -m "refactor(auth): popup delegates all auth and vault traffic to the worker"
```

---

### Task 9: Manifest bump and full verification

**Files:**
- Modify: `manifest.json:4`, `package.json:3`

- [ ] **Step 1: Bump both versions**

`manifest.json`: `"version": "2.5.1"` → `"version": "2.6.0"`
`package.json`: `"version": "2.2.3"` → `"version": "2.6.0"`

The manifest version is what ships as `X-App-Version` on every request, so it
is the field that identifies this build in the sessions list.

- [ ] **Step 2: Run the whole suite**

Run: `npm test`
Expected: PASS, every suite, zero failures. Paste the summary line into the commit body if anything looks surprising.

- [ ] **Step 3: Confirm no permissions crept in**

```bash
grep -n "permissions" manifest.json
```
Expected: exactly `"permissions": ["storage", "activeTab"]` and `"host_permissions": ["https://passave.org/*"]` — no `alarms`, no new hosts.

- [ ] **Step 4: End-to-end check against the deployed backend**

With the extension loaded and signed in, in the service worker console:

```js
// Should show the device id, an auth record with a refreshToken (post-cutover)
// or refreshToken:null (pre-cutover), and no bare `token` key.
await chrome.storage.local.get(null);
```

Then force the expired-token path:

```js
// Corrupt only the access token — the refresh token must recover the session.
const { auth } = await chrome.storage.local.get('auth');
await chrome.storage.local.set({ auth: { ...auth, accessToken: 'x.y.z' } });
```

Open the popup. Against a post-cutover backend the vault must still load
(one `/auth/refresh` in the network tab, then the retried `/save/all`), and
`auth.refreshToken` must differ from its previous value. Against a pre-cutover
backend the popup returns to the sign-in screen — that is the legacy path
behaving correctly.

- [ ] **Step 5: Commit**

```bash
git add manifest.json package.json
git commit -m "chore: bump to 2.6.0 for the refresh-token auth build"
```

---

## Deployment ordering (do not skip)

1. Ship this build to the Chrome Web Store. It is backward-compatible, so it
   runs correctly against the pre-cutover backend while review is pending.
2. Wait for it to be live and adopted. Store review is not schedulable, which is
   the entire reason the legacy path exists.
3. Only then deploy the backend session-management cutover.

If the backend deploys first, every current user gets a 15-minute token they
cannot refresh, and is logged out every 15 minutes.

**Precondition outside this repo:** the published extension's origin must appear
in `allowedOrigins` in the backend's `src/config/CorsConf.js`. The hardcoded dev
id there is `chrome-extension://ldbkbecjillnkgnilomogkfjjcabfpdl`; if the
published id differs, `CHROME_EXTENSION_ID` must be set in the backend
environment before cutover, or every request is rejected with 403 before
reaching a route handler.

**Expected at cutover:** every stored pre-cutover token becomes invalid the
moment the backend deploys, and each signed-in user hits one
`401 TOKEN_INVALID`. Task 5's handling returns them to the sign-in screen. This
is the designed behaviour, not an incident.
