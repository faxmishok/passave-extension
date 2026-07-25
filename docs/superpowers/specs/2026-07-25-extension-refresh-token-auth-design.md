# Refresh-token auth for the Passave extension — design

Date: 2026-07-25
Source brief: `passave/docs/superpowers/prompts/2026-07-25-extension-refresh-token-migration.md`

## Problem

The backend is moving from one long-lived JWT per login to a pair: a 15-minute access
token and an opaque 30-day refresh token that rotates on every use. Sessions become
revocable; clients become responsible for refreshing.

The extension is not ready for this. It stores a single `token` in
`chrome.storage.local`, has no refresh path, and wipes that token on any 401 **or 403**
(`background.js:30`, `popup.js:281`). After the cutover, its users would be signed out
every 15 minutes.

Two contexts fetch independently today — the popup (`popup.js:273`) and the service
worker (`background.js:27`) — each reading the token itself. Post-migration that is a
refresh race: two contexts redeeming the same single-use refresh token, which the server
treats as reuse and answers by revoking the session.

## Scope

In scope: the auth migration only — token storage, refresh, the 401 contract, sign-out
revocation, device headers, back-compat with the pre-cutover backend.

Out of scope: the `/api/v1/sessions` management panel (§10 of the brief). It is a
separate feature with its own UI surface and does not block the backend cutover.

## Decision: stay on `/api/v1`

The brief prescribes the web `/auth/*` mount. The extension already lives entirely on
`/api/v1`, and `/api/v1/auth/*` exposes the same controllers
(`passave/src/config/RouteConf.js:22`):

| Call     | Endpoint used              | Controller                       |
| -------- | -------------------------- | -------------------------------- |
| Login    | `/api/v1/auth/login`       | `api/v1/authController.loginUser` |
| Refresh  | `/api/v1/auth/refresh`     | `refreshController.postRefresh`   |
| Sign-out | `/api/v1/auth/signout`     | `api/v1/authController.postSignOut` |
| Vault    | `/api/v1/save/*`           | guarded by `protectApi`           |

Both login paths funnel through `issueSession`, so both return `refreshToken` after the
cutover. Both refresh paths are appGate-bypassed (`appGate.js:12` bypasses paths under
`/auth`; appGate mounts at `/api/v1`, so the inner path `/auth/refresh` qualifies).

Why this mount rather than the brief's:

- `/api/v1` responses are JSON on **every** status code (`errorHandler.js`, `isApiRoute`).
  On the web mount, errors are JSON only when `Accept: application/json` is sent, and a
  successful `/auth/signout` returns an HTML page by design.
- Login stays exactly as it is today (`/api/v1/auth/login` with `otp`), so the migration
  touches no working credential path. The brief assumed `/auth/ext-login` with
  `secret_token`, which this extension has never used.
- One base URL, one error shape.

## Module layout

Follows the existing `lib/*` UMD + `node --test` pattern.

**`lib/auth-core.js`** — pure. No `fetch`, no `chrome`. Fully unit-testable:

- `readAuthPayload(json)` → `{ accessToken, refreshToken, expiresAt }` or `null`
- `isLegacyPayload(json)` → true when `refreshToken == null` (pre-cutover backend)
- `classifyApiFailure({ status, body })` → `refresh | signout | backoff | permission | other`
- `classifyRefreshFailure({ status, body })` → `signout | backoff`
- `nextBackoffDelay({ attempt, retryAfter, random })` → ms

**`lib/session-manager.js`** — orchestration with injected dependencies (`fetch`,
`storage`, `now`, `sleep`), so single-flight and backoff are testable under `node --test`
without a browser. Holds `refreshInFlight` at closure scope. Exposes `login`, `signOut`,
`apiFetch`, `getAuthState`.

**`background.js`** — wires the real dependencies, routes messages, and replaces its raw
`fetch` + `getToken()` calls (`background.js:26`, `:156`) with `manager.apiFetch()`.

**`popup.js`** — no token reads, no direct fetch. Removes `:47`, `:193`, `:220`, `:251`,
`:273` in favour of messages: `AUTH_LOGIN`, `AUTH_LOGOUT`, `AUTH_STATE`, `VAULT_FETCH`.

The service worker becomes the sole owner of tokens and the only context that fetches
authenticated endpoints. A refresh race is then structurally impossible rather than
merely avoided — there is only one module scope that can start one.

## Storage schema (`chrome.storage.local`)

| Key                    | Value                                                    | Notes                             |
| ---------------------- | -------------------------------------------------------- | --------------------------------- |
| `deviceUuid`           | `crypto.randomUUID()`                                    | written once, never rewritten     |
| `auth`                 | `{ accessToken, refreshToken, expiresAt, legacy }`       | `refreshToken: null` ⇒ legacy     |
| `refreshCooldownUntil` | epoch ms                                                 | 429 backoff, survives worker death |
| `username`             | unchanged                                                | popup greeting only               |

**Upgrade path.** Existing installs hold a bare `token` key. On first read, if `auth` is
absent and `token` is present, it is adopted as
`{ accessToken: token, refreshToken: null, legacy: true }`. A user who updates the
extension before the backend cutover therefore stays signed in and behaves exactly as
today.

`expiresAt` is derived from the response's `expiresIn` field, never hardcoded.

## Request path

Every authenticated call goes through `apiFetch`. Headers on every request:

| Header           | Value                                     |
| ---------------- | ----------------------------------------- |
| `Authorization`  | `Bearer <access token>`                   |
| `X-Device-UUID`  | persisted `deviceUuid`                    |
| `X-Device-Model` | `Chrome Extension`                        |
| `X-OS-Version`   | derived from `navigator.userAgent`        |
| `X-App-Version`  | `chrome.runtime.getManifest().version`    |
| `X-Platform`     | `extension`                               |

All are already in `CorsConf.js` `allowedHeaders`, so none is stripped by Chrome.
`X-Device-UUID` is always sent explicitly: a missing or malformed value makes the server
silently mint a fresh id per request, fragmenting this browser across many session rows.

Pre-flight: if `expiresAt` has passed, refresh before sending, saving a guaranteed-401
round trip. The 401 response remains the authority — clock skew never decides auth.

### The 401 contract

Keyed strictly on `body.code`, per `protectApi.js`:

| Condition                       | Action                                                        |
| ------------------------------- | ------------------------------------------------------------- |
| 401 `TOKEN_EXPIRED`             | `await refreshTokens()`, retry the original request **once**   |
| 401 `TOKEN_INVALID`             | wipe `auth`, broadcast signed-out. No retry.                   |
| 401 `TOKEN_MISSING`             | wipe `auth`, broadcast signed-out. No retry.                   |
| 403 `INSUFFICIENT_PERMISSIONS`  | surface to caller, **tokens untouched**                        |
| 429 (any endpoint)              | back off, **tokens untouched**                                 |

This corrects the current behaviour, which wipes on any 401 or 403.

In legacy mode `refreshTokens()` is a no-op resolving to `signout`, so a 401 degrades to
exactly today's behaviour and no refresh loop is ever armed.

Post-cutover, every stored pre-cutover token yields `TOKEN_INVALID` on its next request.
That is expected and handled as an ordinary sign-out, not an error state.

## Single-flight refresh

One module-level in-flight promise. Every caller that hits `TOKEN_EXPIRED` awaits it
rather than issuing its own `/refresh`.

On a 200, both tokens are replaced unconditionally — the refresh token rotates on every
use, and keeping the previous one is never correct.

`TOKEN_REUSED` from `/refresh` → wipe both tokens immediately, never retry. A plain
`TOKEN_INVALID` or a `400 TOKEN_MISSING` from `/refresh` gets the same client action.

## 429 backoff — deliberate departure from the brief

The brief asks for backoff over "several minutes". An MV3 service worker is evicted after
roughly 30 seconds of inactivity, and a pending `setTimeout` does not hold it open — the
reason `lib/pending-store.js` exists at all. A multi-minute in-worker sleep would simply
be terminated mid-wait.

Instead:

- In-worker backoff: 4 attempts at ~1s / 2s / 4s / 8s plus 0–1s jitter (≈15s total),
  which fits inside the worker's lifetime. A short `Retry-After` takes precedence.
- On exhaustion, persist `refreshCooldownUntil`. Any later wake-up — including a fresh
  worker instance — sees the cooldown and fails fast with `network_unavailable` instead
  of re-hammering a rate-limited IP.
- Tokens are never wiped on 429. The popup shows a "can't reach Passave right now"
  state; the next user action retries once the cooldown lapses.

This preserves the brief's intent (never sign out on 429; never let concurrent wake-ups
deepen it) with a mechanism that survives worker death. No `alarms` permission required.

The rate limit is per IP (`rateLimiter.js:96`), so a well-behaved client can be handed a
429 because of other people's traffic. The response message says "please sign in again";
it is misleading for a 429 and is ignored in favour of the status code.

## Sign-out

Moves into the background worker:

1. `POST /api/v1/auth/signout` with `Authorization: Bearer <access token>` — **before**
   clearing storage. Clear first and there is no token to send, so nothing is revoked and
   the refresh token stays redeemable for its full 30 days.
2. Clear `auth` unconditionally afterwards, including on network failure. A failed
   request must never strand the user in a signed-in UI.
3. `deviceUuid` deliberately survives, so a returning user reuses their session row
   rather than spawning a duplicate.

An expired access token is fine and is the normal case: the server verifies with
`ignoreExpiration`, so a stale token still names its session. The endpoint is
best-effort and always returns 200; a 200 is not proof of revocation.

## Tests

`node --test`, matching the existing suites.

`auth-core`:

- each 401 `code` maps to its documented action; 403 maps to `permission`; 429 to `backoff`
- legacy payload detection (`refreshToken` absent → legacy)
- `expiresAt` derived from `expiresIn`, not hardcoded
- backoff schedule shape, jitter bounds, and `Retry-After` precedence

`session-manager`, with fake fetch and storage:

- five concurrent `TOKEN_EXPIRED` calls issue **exactly one** `/refresh` request
- a successful refresh persists both new tokens
- the retry happens once, never in a loop
- `TOKEN_REUSED` wipes tokens and does not retry
- 429 does not wipe tokens and sets `refreshCooldownUntil`
- 403 does not wipe tokens
- legacy mode never calls `/refresh`
- sign-out sends the Bearer header before storage is cleared, and clears even when the
  request rejects

## Manifest

Version bump only. `host_permissions` already covers `https://passave.org/*`. No new
permissions.

## Deployment ordering

1. Ship this build to the Chrome Web Store. It is backward-compatible, so it runs fine
   against the pre-cutover backend while review is pending.
2. Wait for it to be live and adopted.
3. Only then deploy the backend session-management cutover.

If the backend deploys first, every current user gets a 15-minute token they cannot
refresh.

## Precondition outside this repo

The published extension's origin must be in `allowedOrigins` (`CorsConf.js:9`). The
hardcoded dev id there is `chrome-extension://ldbkbecjillnkgnilomogkfjjcabfpdl`; if the
published id differs, `CHROME_EXTENSION_ID` must be set in the backend environment before
cutover, or every request is rejected with 403 before reaching a route handler.
