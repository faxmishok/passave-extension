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

  return {
    EMAIL_RE,
    classifyIdentifierField,
    classifyIdentifiers,
  };
});
