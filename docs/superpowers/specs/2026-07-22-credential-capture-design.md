# Passave Extension — Credential Capture Design

**Date:** 2026-07-22
**Status:** Approved design, ready for implementation planning

## Problem

The Passave browser extension is currently autofill-only. It reads credentials
from the vault and injects them into login fields, but it never writes back.
Users must manually add or update credentials in the web/mobile vault.

This feature adds **credential capture**: when a user signs up, logs into a site
not yet in their vault, or changes a password, the extension prompts them to save
or update that credential and calls the existing backend API.

Tracked in `TODO`:
- New account / login → prompt "Add to Passave?" → `POST /api/v1/save/add`
- Password change → prompt "Update password in Passave?" → `PUT /api/v1/save/:id`

## Scope

v1 handles **all three scenarios explicitly**, each with tailored prompt copy:
1. **Signup** — new account creation (password + confirm-password).
2. **Login (not yet saved)** — successful sign-in on a site absent from the vault.
3. **Change-password** — updating an existing credential's password.

Out of scope for v1: multi-step/SPA wizard flows that split identifier and
password across separate pages (best-effort only), passkey/WebAuthn capture,
TOTP secret capture, and bulk import.

## Backend context (already exists — no backend changes)

The API the extension already authenticates against exposes everything needed:

- `GET  /api/v1/save/all` — used today for autofill matching.
- `POST /api/v1/save/add` — `createSave`. Body: `name, username, email,
  password_secret, registered_number, loginURL, category`. Server encrypts
  `password_secret` and runs a breach check.
- `PUT  /api/v1/save/:id` — `updateSave`. Same body, all fields optional; only
  provided fields are updated. Changing `password_secret` resets breach state.

**Encryption is server-side.** The content script sends the plaintext password
over HTTPS; the server encrypts it. No client-side crypto is required.

**Save model constraints (drive the design):**
- `name` — **required**.
- `username` — **required**.
- `email` — optional.
- `password_secret` — **required**.
- `registered_number` — optional (phone).

## Architecture

### The core problem: submit navigates away

A form submit almost always navigates to a new page, destroying the content
script that observed the password. The pill therefore cannot reliably be shown
on the submitting page. We use the standard password-manager pattern:
**capture → persist → prompt on next load.**

Flow:

1. **Capture (content.js).** On `submit` — plus an SPA fallback listening for
   clicks on submit-like buttons and Enter keydowns — read all relevant field
   values *before* navigation and send a `CAPTURE_SUBMIT` message to background.
2. **Classify & decide (background.js).** Determine the scenario, look the
   candidate up against the vault and the ignore-list, and if worth prompting,
   store a **pending capture** in the service worker keyed by `tabId`. The
   password lives only in service-worker memory — never in `chrome.storage`.
3. **Prompt on next load (content.js).** The existing `CHECK_MATCHES` message
   sent on `window.load` returns an additional `pendingCapture` field. If
   present, content.js renders the **capture pill**.
4. **Staleness guard.** A pending capture is dropped once shown, once acted on,
   or when the tab performs a second navigation without consuming it.

### Component responsibilities

- **content.js**
  - `captureForm(form)` — snapshot non-hidden inputs, classify fields, detect
    scenario, build the capture payload.
  - Submit + SPA-fallback listeners.
  - `injectCapturePill(pendingCapture)` — reuse existing floating-pill styling,
    scenario-specific copy, primary action + "Edit" disclosure + dismiss menu.
  - Existing autofill logic is untouched except for reading `pendingCapture`
    off the `CHECK_MATCHES` response.
- **background.js**
  - Pending-capture store: `Map<tabId, pendingCapture>` in memory.
  - New message handlers: `CAPTURE_SUBMIT`, `SAVE_CREDENTIAL`,
    `UPDATE_CREDENTIAL`, `IGNORE_SITE`.
  - Reuse existing domain-matching (from `CHECK_MATCHES`) for update-vs-new.
  - Ignore-list read/write in `chrome.storage.local`.
- **Pure helpers** (testable, no DOM/network): field classifier, scenario
  detector, match resolver, name derivation.

## Scenario detection

Password field count decides the scenario:

| Password fields | Values | Scenario |
|---|---|---|
| 1 | — | Login (candidate save-new if not in vault) |
| 2 | equal | Signup → "Save to Passave?" |
| 2–3 | not all equal | Change-password → "Update password in Passave?" |

For change-password, the new password is the confirmed/repeated non-empty value
(the value appearing in the last two fields when they match), not the "current
password" field.

## Identifier classification (the username/email dilemma)

Classify each non-password identifier field by **value shape first, attributes
second** (email has an unmistakable shape):

1. Value matches email regex (`x@y.z`) → `email`.
2. Field `type="tel"` or value is phone-shaped → `registered_number`.
3. Otherwise → `username`.

Reconcile against the required-`username` rule:
- Form had a username field → use it.
- Form had **only** an email → **the full email fills both `email` and
  `username`** (decided: full email, not local-part).

`name` is derived from the registrable domain (e.g. `github.com` → "GitHub") and
is editable in the pill before saving.

## Match lookup: update vs. new

`background.js` reuses the existing domain match logic. On `CAPTURE_SUBMIT`:

| Condition | Action |
|---|---|
| No domain match | **Save-new** → `POST /save/add` |
| Domain match, same identifier, different password | **Update** → `PUT /save/:id` (matched save id) |
| Domain match, same identifier, same password | **Suppress** (no-op) |
| Domain match, different identifier | **Save-new** (second account on that site) |
| Site in ignore-list | **Suppress** |

## UI

Reuse the exact floating-pill styling from `injectFloatingUI` (dark card, purple
accent, `passavePop` animation) to match the existing design system.

- **Copy per scenario:** "Save to Passave?" (signup / login-not-saved) /
  "Update password in Passave?" (change-password).
- **Primary button:** Save / Update.
- **Edit disclosure:** small "Edit" reveals editable `name`, `username`, `email`
  fields pre-filled from detection (one-click by default, editable when needed).
- **Dismiss menu:** "Dismiss" (this time) and "Never for this site" (persistent).
- **Success/error state:** reuse the existing "Autofilled!" style confirmation
  ("Saved!" / "Updated!"), with a failure fallback message.

## Messages & storage

New runtime messages:
- `CAPTURE_SUBMIT` — content → background; carries captured payload + domain.
- `SAVE_CREDENTIAL` — content → background; triggers `POST /save/add`.
- `UPDATE_CREDENTIAL` — content → background; triggers `PUT /save/:id`.
- `IGNORE_SITE` — content → background; appends domain to ignore-list.

Storage:
- `chrome.storage.local.ignoredSites` — array of ignored domains.
- Pending captures — in-memory `Map` in the service worker only (never persisted;
  contains plaintext password until consumed).

## Permissions

No new permissions. `storage` and the `<all_urls>` content script already cover
capture, storage, and the ignore-list. `host_permissions` for `passave.org`
already covers the API calls.

## Security & privacy considerations

- Plaintext passwords exist only transiently: in the DOM (already), in the
  submit-capture payload, and in the service-worker pending-capture map. Never
  written to `chrome.storage` or logged.
- Pending captures are cleared aggressively (on show, on action, on second
  navigation) to avoid a lingering plaintext secret.
- Ignore-list stores domains only, no credentials.
- Suppress prompts on `passave.org` itself to avoid capturing the vault's own
  master login.

## Testing

- **Unit (pure helpers):** classifier and scenario/match resolvers against
  synthetic form snapshots — email-only, username+email, signup double-pw,
  change-pw triple-pw, phone/`tel`, domain-match update vs. second-account.
- **Manual E2E:** a real signup page, a real login page for a not-yet-saved
  site, and a change-password flow; verify pill copy, edit, save/update round-trip
  to the vault, and "Never for this site" suppression.

## Open questions / deferred

- SPA flows that split identifier and password across pages: best-effort in v1;
  revisit if real sites break.
- Debounce/dedupe rapid double submits (retry after validation error): handle via
  the staleness guard; refine if it double-prompts in practice.
