'use strict';
/**
 * PASSAVE — pending-store.js
 * Storage for a capture that is waiting on the user's answer.
 *
 * This deliberately does NOT live in a module-level Map. Chrome evicts an idle
 * MV3 service worker after ~30 seconds, and reading the prompt is idle time —
 * nothing the user does in the pill (expanding Edit, typing a name) sends the
 * worker a message. A Map therefore vanished out from under the prompt and
 * every answer after that came back "stale". chrome.storage.session is
 * memory-backed, cleared when the browser closes, and unreadable from content
 * scripts by default, so it holds the plaintext password under the same trust
 * boundary while surviving worker restarts.
 */
(function (root, factory) {
  const core =
    typeof module !== 'undefined' && module.exports
      ? require('./capture-core')
      : root.PassaveCaptureCore;
  const api = factory(core);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PassavePendingStore = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function (core) {
  const KEY_PREFIX = 'pending:';
  const DEFAULT_TTL_MS = 5 * 60 * 1000;

  function createPendingStore(area, options) {
    const opts = options || {};
    const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
    const now = opts.now || (() => Date.now());
    const key = (tabId) => KEY_PREFIX + tabId;

    function isFresh(pending) {
      return !!pending && now() - pending.createdAt < ttlMs;
    }

    // Tabs can close while a prompt is open, so sweep on write rather than
    // leaving plaintext passwords parked in session storage until shutdown.
    async function prune() {
      const all = await area.get(null);
      const dead = Object.keys(all).filter(
        (k) => k.startsWith(KEY_PREFIX) && !isFresh(all[k]),
      );
      if (dead.length) await area.remove(dead);
    }

    return {
      async put(tabId, pending) {
        await prune();
        await area.set({
          [key(tabId)]: Object.assign({ createdAt: now() }, pending),
        });
      },

      async get(tabId, filter) {
        if (tabId == null) return null;
        const stored = (await area.get(key(tabId)))[key(tabId)];
        if (!isFresh(stored)) {
          if (stored) await area.remove(key(tabId));
          return null;
        }
        const domain = filter && filter.domain;
        if (domain && core.normalizeDomain(domain) !== core.normalizeDomain(stored.domain)) {
          return null;
        }
        return stored;
      },

      async remove(tabId) {
        if (tabId == null) return;
        await area.remove(key(tabId));
      },

      prune,
    };
  }

  return { createPendingStore, KEY_PREFIX, DEFAULT_TTL_MS };
});
