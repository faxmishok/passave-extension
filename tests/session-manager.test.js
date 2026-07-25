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
});
