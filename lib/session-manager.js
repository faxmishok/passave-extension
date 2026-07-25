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
  const MAX_REFRESH_ATTEMPTS = 4;
  // An MV3 worker is evicted after ~30s idle and a pending timer does not hold
  // it open, so anything longer than this is not a wait this context can serve.
  const MAX_SLEEP_MS = 10000;
  const MAX_COOLDOWN_MS = 60000;
  // A server-supplied Retry-After is honoured, but not unconditionally: it is
  // attacker- and misconfiguration-reachable input, and an unbounded park
  // (e.g. Retry-After: 86400) would lock a user out for a day over one bad
  // header. Fifteen minutes is comfortably longer than any legitimate 429
  // window observed from the limiter and short enough that a wrong value
  // self-heals on the next open of the extension.
  const MAX_PARKED_COOLDOWN_MS = 15 * 60 * 1000;

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
     * Refresh with bounded backoff. Resolves 'ok' | 'signout' | 'unavailable'
     * and never rejects: every caller treats the outcome as data, so a thrown
     * error can never leak past the single-flight slot and strand other
     * awaiters.
     *
     * The whole body is wrapped: chrome.storage.local can reject in practice
     * (quota exceeded, extension context invalidated mid-write), and a storage
     * failure is a transient condition, not proof the refresh token is bad —
     * it must resolve 'unavailable', never 'signout'.
     *
     * 'signout' is an invariant, not just an outcome: every path that returns
     * it has also called clearAuthRecord() (which is idempotent, so calling it
     * when there was nothing to clear is harmless).
     *
     * A 429 here says nothing about the tokens — the limiter buckets per IP, so
     * an office behind one egress address can be limited by other people's
     * traffic. Its message even reads "please sign in again"; that is
     * misleading and is ignored in favour of the status code. Signing out
     * would discard a still-valid 30-day credential over a transient
     * condition, so a 429 is retried with backoff instead, up to
     * MAX_REFRESH_ATTEMPTS. A wait too long for this worker to sleep through
     * is parked in storage (capped at MAX_PARKED_COOLDOWN_MS) as a cooldown
     * that a later worker instance honours instead of re-hammering a limited
     * IP.
     *
     * Retrying is restricted to 429: the rate limiter's rejection is
     * guaranteed to have been generated before the handler ran, so the
     * refresh token presented in this attempt cannot already have rotated
     * server-side. A 5xx or any other failure carries no such guarantee — the
     * request may have reached the handler and rotated the token even though
     * the response was lost — so, exactly like a thrown fetch, it gets a
     * single attempt rather than re-presenting a token that may already be
     * spent and reading as TOKEN_REUSED.
     */
    async function doRefresh() {
      try {
        const record = await getAuthRecord();
        if (!record || !record.refreshToken) {
          await clearAuthRecord();
          return 'signout';
        }

        const cooldown = (await read([COOLDOWN_KEY]))[COOLDOWN_KEY];
        if (typeof cooldown === 'number' && now() < cooldown) return 'unavailable';

        const deviceUuid = await getDeviceUuid();

        for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt++) {
          // Re-read every attempt: a rotation may have landed server-side even
          // though the response was lost, and retrying with a stale token is
          // exactly what reads as reuse.
          const current = await getAuthRecord();
          if (!current || !current.refreshToken) {
            await clearAuthRecord();
            return 'signout';
          }

          let res;
          try {
            res = await postJson(
              '/auth/refresh',
              { refreshToken: current.refreshToken },
              null,
              deviceUuid,
            );
          } catch {
            // A thrown fetch — offline, DNS failure, a proxy that never
            // answers — carries no status and no Retry-After to size a wait
            // from. Bail rather than spend the attempt budget on it blind.
            return 'unavailable';
          }

          if (res.ok) {
            const next = core.readAuthPayload(res.body, now());
            if (!next) {
              await clearAuthRecord();
              return 'signout';
            }
            // Both values, unconditionally. The refresh token rotated
            // server-side the moment it was presented; keeping the old one is
            // never correct.
            await setAuthRecord(next);
            await storage.remove(COOLDOWN_KEY);
            return 'ok';
          }

          if (core.classifyRefreshFailure(res) === core.SIGNOUT) {
            await clearAuthRecord();
            return 'signout';
          }

          // Only a 429 is safe to retry — see the doc comment above. Any
          // other non-signout failure (5xx, a proxy error page, ...) gets a
          // single attempt, exactly like a thrown fetch.
          if (res.status !== 429) return 'unavailable';

          const delay = core.nextBackoffDelay({
            attempt,
            retryAfter: retryAfterSeconds(res.headers),
            random,
          });

          // Too long to wait inside a worker that may be killed mid-sleep.
          // Park it in storage instead — the next wake-up, in whatever worker
          // instance, honours it rather than re-hammering a limited IP. The
          // park itself is capped: a server-supplied Retry-After is input we
          // don't control, and an unbounded park could lock a user out for
          // however long a bad or hostile value says.
          if (delay > MAX_SLEEP_MS) {
            const parked = Math.min(delay, MAX_PARKED_COOLDOWN_MS);
            await storage.set({ [COOLDOWN_KEY]: now() + parked });
            return 'unavailable';
          }

          // Nothing follows the final attempt, so waiting before it would
          // only hold the worker open for no reason.
          if (attempt === MAX_REFRESH_ATTEMPTS - 1) break;

          await sleep(delay);
        }

        await storage.set({ [COOLDOWN_KEY]: now() + MAX_COOLDOWN_MS });
        return 'unavailable';
      } catch {
        return 'unavailable';
      }
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
    MAX_REFRESH_ATTEMPTS,
    MAX_SLEEP_MS,
    MAX_COOLDOWN_MS,
    MAX_PARKED_COOLDOWN_MS,
  };
});
