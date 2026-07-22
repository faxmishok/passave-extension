'use strict';
/**
 * PASSAVE — capture-core.js
 * Pure, framework-free decision logic for credential capture.
 * Loads as a browser global (self.PassaveCaptureCore) and as a Node module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PassaveCaptureCore = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const PHONE_HINT_RE = /phone|tel|mobile|cell/i;

  function normalizeDomain(domain) {
    return String(domain || '')
      .trim()
      .toLowerCase()
      .replace(/^www\./, '');
  }

  function clean(value) {
    return value === undefined || value === null ? '' : String(value).trim();
  }

  function classifyIdentifierField(field) {
    const value = clean(field && field.value);
    if (EMAIL_RE.test(value)) return 'email';
    if (field && field.type === 'tel') return 'registered_number';

    const hints = [field && field.name, field && field.id, field && field.placeholder, field && field.autocomplete]
      .filter(Boolean)
      .join(' ');
    if (PHONE_HINT_RE.test(hints)) return 'registered_number';

    // A bare run of digits is as likely to be a numeric username as a phone
    // number. Only claim it as a phone when it carries phone punctuation.
    const digits = value.replace(/\D/g, '');
    const punctuated = /[\s()+-]/.test(value) && /^[+(]?\d/.test(value);
    if (punctuated && digits.length >= 7 && digits.length <= 15) return 'registered_number';

    return 'username';
  }

  function classifyIdentifiers(fields) {
    const out = { username: '', email: '', registered_number: '' };
    for (const field of fields || []) {
      const value = (field && field.value ? String(field.value) : '').trim();
      if (!value) continue;
      const kind = classifyIdentifierField(field);
      if (!out[kind]) out[kind] = value;
    }
    if (!out.username && out.email) out.username = out.email;
    return out;
  }

  function detectScenario(passwordValues) {
    const values = passwordValues || [];
    const nonEmpty = values.filter((p) => p && p.length > 0);
    if (nonEmpty.length === 0) return { scenario: 'login', password: null };
    if (values.length === 1) return { scenario: 'login', password: values[0] };

    if (values.length === 2 && values[0] === values[1]) {
      return { scenario: 'signup', password: nonEmpty[0] };
    }

    const counts = {};
    for (const p of nonEmpty) counts[p] = (counts[p] || 0) + 1;
    const repeated = nonEmpty.find((p) => counts[p] >= 2);
    const newPassword = repeated || nonEmpty[nonEmpty.length - 1];
    return { scenario: 'change-password', password: newPassword };
  }

  function resolveCaptureAction(input) {
    const {
      domain = '',
      identifiers = {},
      password = null,
      matches = [],
      ignoredSites = [],
    } = input || {};

    if (!password) return { action: 'suppress', saveId: null, reason: 'no-password' };
    const bareDomain = normalizeDomain(domain);
    if (bareDomain === 'passave.org') {
      return { action: 'suppress', saveId: null, reason: 'self-domain' };
    }
    if (ignoredSites.some((d) => normalizeDomain(d) === bareDomain)) {
      return { action: 'suppress', saveId: null, reason: 'ignored' };
    }

    const idValues = [identifiers.username, identifiers.email]
      .filter(Boolean)
      .map((s) => s.toLowerCase());
    const sameId = matches.find((m) =>
      [m.username, m.email]
        .filter(Boolean)
        .some((v) => idValues.includes(String(v).toLowerCase())),
    );

    if (sameId) {
      if (sameId.password_secret === password) {
        return { action: 'suppress', saveId: null, reason: 'already-saved' };
      }
      return { action: 'update', saveId: sameId._id || sameId.id || null, reason: 'password-changed' };
    }

    return {
      action: 'save-new',
      saveId: null,
      reason: matches.length ? 'new-account' : 'not-in-vault',
    };
  }

  /**
   * The request body for POST /save/add or PUT /save/:id.
   *
   * An update is a password change, so it carries the password plus only the
   * fields the user actually retyped in the prompt. Echoing the captured
   * page's identifiers back wholesale would overwrite vault fields the page
   * never knew about — blanking a stored email, replacing a hand-picked entry
   * name with the domain, or moving loginURL to the password-change page.
   */
  function buildSaveBody(pending, edits) {
    const p = pending || {};
    const e = edits || {};
    const ids = p.identifiers || {};
    const body = { password_secret: p.password };

    if (p.action === 'update') {
      const defaults = { name: p.name, username: ids.username, email: ids.email };
      for (const field of ['name', 'username', 'email']) {
        const value = clean(e[field]);
        if (value && value !== clean(defaults[field])) body[field] = value;
      }
      return body;
    }

    const name = clean(e.name) || clean(p.name);
    const username = clean(e.username) || clean(ids.username);
    const email = clean(e.email) || clean(ids.email);
    const registeredNumber = clean(ids.registered_number);
    const loginURL = clean(p.loginURL);

    if (name) body.name = name;
    if (username) body.username = username;
    if (email) body.email = email;
    if (registeredNumber) body.registered_number = registeredNumber;
    if (loginURL) body.loginURL = loginURL;
    return body;
  }

  // Normalizes the whole list on write so legacy `www.`-prefixed entries
  // collapse into their bare form instead of shadowing the new one forever.
  function addIgnoredSite(ignoredSites, domain) {
    const next = [];
    for (const entry of (ignoredSites || []).concat([domain])) {
      const bare = normalizeDomain(entry);
      if (bare && !next.includes(bare)) next.push(bare);
    }
    return next;
  }

  function deriveName(domain) {
    if (!domain) return 'Credential';
    const host = normalizeDomain(domain);
    const parts = host.split('.');
    const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (!label) return 'Credential';
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  return {
    EMAIL_RE,
    normalizeDomain,
    classifyIdentifierField,
    classifyIdentifiers,
    detectScenario,
    resolveCaptureAction,
    buildSaveBody,
    addIgnoredSite,
    deriveName,
  };
});
