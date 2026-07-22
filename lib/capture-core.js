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

  function classifyIdentifierField(field) {
    const value = (field && field.value ? String(field.value) : '').trim();
    if (EMAIL_RE.test(value)) return 'email';
    const digits = value.replace(/\D/g, '');
    const phoneShaped = digits.length >= 7 && /^[+()\d][\d\s()+-]*$/.test(value);
    if (field && field.type === 'tel') return 'registered_number';
    if (phoneShaped) return 'registered_number';
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
    if (domain.replace(/^www\./i, '') === 'passave.org') {
      return { action: 'suppress', saveId: null, reason: 'self-domain' };
    }
    const bareDomain = domain.replace(/^www\./i, '');
    if (ignoredSites.some((d) => String(d).replace(/^www\./i, '') === bareDomain)) {
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

  function deriveName(domain) {
    if (!domain) return 'Credential';
    const host = String(domain).replace(/^www\./i, '');
    const parts = host.split('.');
    const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (!label) return 'Credential';
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  return {
    EMAIL_RE,
    classifyIdentifierField,
    classifyIdentifiers,
    detectScenario,
    resolveCaptureAction,
    deriveName,
  };
});
