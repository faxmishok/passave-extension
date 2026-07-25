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
  // 'signout' is an invariant: credentials must be gone, even on the
  // no-refresh-token path where clearAuthRecord() has nothing new to do.
  assert.equal('auth' in storage.dump(), false);
});

test('refreshTokens: an unusable 200 body wipes, since signout must mean cleared', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([{ status: 200, body: { success: true } }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  assert.equal(await manager.refreshTokens(), 'signout');
  assert.equal('auth' in storage.dump(), false);
});

test('refreshTokens: a network failure resolves unavailable and leaves tokens alone', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([{ throws: true }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  assert.equal(await manager.refreshTokens(), 'unavailable');
  assert.deepEqual(storage.dump().auth, signedIn.auth);
});

test('refreshTokens: a 5xx resolves unavailable and leaves tokens alone', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([{ status: 500, body: { message: 'boom' } }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  assert.equal(await manager.refreshTokens(), 'unavailable');
  assert.deepEqual(storage.dump().auth, signedIn.auth);
  // Retrying a 5xx risks re-presenting a refresh token that already rotated
  // server-side before the response was lost — only a 429 is safe to retry.
  assert.equal(fetchImpl.calls.length, 1);
});

test('refreshTokens: a 429 resolves unavailable and never wipes tokens', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([{ status: 429, body: { code: 'RATE_LIMITED' } }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  assert.equal(await manager.refreshTokens(), 'unavailable');
  assert.deepEqual(storage.dump().auth, signedIn.auth);
});

test('refreshTokens: the in-flight slot is released after a failed attempt', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([{ throws: true }, { throws: true }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  assert.equal(await manager.refreshTokens(), 'unavailable');
  assert.equal(await manager.refreshTokens(), 'unavailable');
  assert.equal(fetchImpl.calls.length, 2);
});

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

test('refreshTokens: a thrown fetch bails without retrying or parking a cooldown', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([{ throws: true }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  assert.equal(await manager.refreshTokens(), 'unavailable');
  assert.equal(storage.dump().auth.refreshToken, 'refresh.1');
  // A thrown fetch is the lost-response case: the request may have already
  // reached the server and rotated the token even though we never saw the
  // reply. Retrying would re-present a possibly spent token and read as
  // TOKEN_REUSED, so this gets exactly one attempt and no parked cooldown —
  // unlike a 429, which is guaranteed to predate any rotation.
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal('refreshCooldownUntil' in storage.dump(), false);
});

test('refreshTokens: an absurd Retry-After parks the 15-minute cap, not the raw value', async () => {
  const storage = fakeStorage(signedIn);
  const slept = [];
  const fetchImpl = fakeFetch([
    { status: 429, body: { success: false }, headers: { 'Retry-After': '86400' } },
  ]);
  const { manager } = build({
    storage,
    fetch: fetchImpl,
    sleep: async (ms) => slept.push(ms),
  });

  // A day-long Retry-After must not lock the user out for a day.
  assert.equal(await manager.refreshTokens(), 'unavailable');
  assert.deepEqual(slept, []);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(storage.dump().refreshCooldownUntil, 1_000_000 + 15 * 60 * 1000);
  assert.equal(storage.dump().auth.refreshToken, 'refresh.1');
});

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

test('apiFetch: an unrecognized failure status surfaces as reason "http" without wiping tokens', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([{ status: 500, body: { message: 'boom' } }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  const res = await manager.apiFetch('/save/all');
  assert.equal(res.reason, 'http');
  assert.equal(res.status, 500);
  assert.equal(storage.dump().auth.accessToken, 'access.1');
});

test('apiFetch: a caller-supplied credentials cannot defeat cookie suppression', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([{ status: 200, body: { success: true } }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  await manager.apiFetch('/save/all', { credentials: 'include' });

  assert.equal(fetchImpl.calls[0].init.credentials, 'omit');
});

test('apiFetch: a Headers instance for init.headers is not silently dropped', async () => {
  const storage = fakeStorage(signedIn);
  const fetchImpl = fakeFetch([{ status: 200, body: { success: true } }]);
  const { manager } = build({ storage, fetch: fetchImpl });

  await manager.apiFetch('/save/add', {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: 'GitHub' }),
  });

  const call = fetchImpl.calls[0];
  assert.equal(call.init.headers['content-type'] || call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.headers.Authorization, 'Bearer access.1');
});

test('apiFetch: a 401 that outlives another caller\'s rotation retries instead of refreshing again', async () => {
  // Simulates the race Task 7 will introduce: two concurrent apiFetch calls
  // both attempt with the same (about-to-expire) access token. One of them
  // drives the rotation to completion; the other's 401 is only handled
  // AFTER that rotation has already landed in storage. The stale one must
  // retry with the fresh token instead of starting a second rotation.
  const baseStorage = fakeStorage(signedIn);
  let resolveGate;
  const gate = new Promise((resolve) => {
    resolveGate = resolve;
  });
  // Wraps the real storage so the gate opens exactly when the rotated
  // token lands — not on a guessed delay — keeping the test deterministic
  // regardless of how the two calls actually interleave.
  const storage = Object.assign({}, baseStorage, {
    async set(items) {
      await baseStorage.set(items);
      if (items.auth && items.auth.accessToken === 'access.2') resolveGate();
    },
  });

  function fakeResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
    };
  }

  const calls = [];
  let staleAttempts = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const auth = init.headers.Authorization;
    if (url.endsWith('/save/all') && auth === 'Bearer access.1') {
      staleAttempts += 1;
      // Whichever of the two concurrent attempts arrives second is the
      // "stale" one: hold its 401 back until the other's rotation has
      // actually written the new token to storage.
      if (staleAttempts === 2) await gate;
      return fakeResponse(401, { code: 'TOKEN_EXPIRED' });
    }
    if (url.endsWith('/auth/refresh')) {
      return fakeResponse(200, {
        success: true,
        token: 'access.2',
        refreshToken: 'refresh.2',
        expiresIn: 900,
      });
    }
    if (url.endsWith('/save/all') && auth === 'Bearer access.2') {
      return fakeResponse(200, { success: true, saves: [] });
    }
    throw new Error(`unexpected fetch: ${url} ${auth}`);
  };

  const { manager } = build({ storage, fetch: fetchImpl });

  const [a, b] = await Promise.all([
    manager.apiFetch('/save/all'),
    manager.apiFetch('/save/all'),
  ]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const refreshCalls = calls.filter((c) => c.url.endsWith('/auth/refresh'));
  assert.equal(refreshCalls.length, 1, 'the stale 401 must not trigger a second rotation');
});

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
