'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPendingStore } = require('../lib/pending-store');

// Stand-in for chrome.storage.session: promise-based, survives the lifetime of
// any number of store instances built over it — which is exactly the property
// the real bug hinged on.
function fakeArea(initial) {
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

const pending = { nonce: 'n1', action: 'update', domain: 'github.com', password: 'secret' };

test('put then get returns the pending capture, timestamped', async () => {
  const store = createPendingStore(fakeArea(), { now: () => 1234 });
  await store.put(7, pending);
  assert.deepEqual(await store.get(7), Object.assign({ createdAt: 1234 }, pending));
});

test('a pending capture survives a service worker restart', async () => {
  const area = fakeArea();
  await createPendingStore(area).put(7, pending);

  // Chrome evicts the idle worker; every module-level variable is gone and the
  // next event builds a brand new store over the same session storage.
  const afterRestart = createPendingStore(area);
  const recovered = await afterRestart.get(7);
  assert.equal(recovered.nonce, 'n1');
  assert.equal(recovered.password, 'secret');
});

test('get is scoped to the tab that captured', async () => {
  const store = createPendingStore(fakeArea());
  await store.put(7, pending);
  assert.equal(await store.get(8), null);
});

test('get expires a capture older than the TTL', async () => {
  let now = 1000;
  const store = createPendingStore(fakeArea(), { ttlMs: 500, now: () => now });
  await store.put(7, pending);
  now = 1400;
  assert.notEqual(await store.get(7), null);
  now = 1600;
  assert.equal(await store.get(7), null);
});

test('get refuses a capture belonging to another domain', async () => {
  const store = createPendingStore(fakeArea());
  await store.put(7, pending);
  assert.equal(await store.get(7, { domain: 'evil.com' }), null);
  assert.notEqual(await store.get(7, { domain: 'www.github.com' }), null);
});

test('remove drops the capture and its plaintext password', async () => {
  const area = fakeArea();
  const store = createPendingStore(area);
  await store.put(7, pending);
  await store.remove(7);
  assert.equal(await store.get(7), null);
  assert.deepEqual(area.dump(), {});
});

test('put prunes expired captures left behind by closed tabs', async () => {
  let now = 1000;
  const area = fakeArea();
  const store = createPendingStore(area, { ttlMs: 500, now: () => now });
  await store.put(7, pending);
  now = 5000;
  await store.put(9, pending);
  assert.deepEqual(Object.keys(area.dump()), ['pending:9']);
});

test('put leaves unrelated session keys alone', async () => {
  const area = fakeArea({ someOtherFeature: 'keep me' });
  const store = createPendingStore(area);
  await store.put(7, pending);
  await store.remove(7);
  assert.deepEqual(area.dump(), { someOtherFeature: 'keep me' });
});
