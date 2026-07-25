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
    readAuthPayload,
    isAccessTokenExpired,
    classifyApiFailure,
    classifyRefreshFailure,
    nextBackoffDelay,
  };
});
