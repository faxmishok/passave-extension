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

    // THE single-flight slot. Module-scope per manager instance, which is
    // per service worker — not per call, not per tab.
    let refreshInFlight = null;

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

    return {
      getDeviceUuid,
      getAuthRecord,
      setAuthRecord,
      clearAuthRecord,
      buildHeaders,
      refreshTokens,
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
