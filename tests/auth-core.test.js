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
