'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../lib/capture-core');

test('classifyIdentifierField: email by value shape', () => {
  assert.equal(core.classifyIdentifierField({ type: 'text', value: 'jane@x.com' }), 'email');
  assert.equal(core.classifyIdentifierField({ type: 'email', value: 'jane@x.com' }), 'email');
});

test('classifyIdentifierField: phone by tel type or digits', () => {
  assert.equal(core.classifyIdentifierField({ type: 'tel', value: '555 123 4567' }), 'registered_number');
  assert.equal(core.classifyIdentifierField({ type: 'text', value: '+1 (555) 123-4567' }), 'registered_number');
});

test('classifyIdentifierField: username otherwise', () => {
  assert.equal(core.classifyIdentifierField({ type: 'text', value: 'jane_doe' }), 'username');
});

test('classifyIdentifiers: username + email form', () => {
  const out = core.classifyIdentifiers([
    { type: 'text', value: 'jane_doe' },
    { type: 'email', value: 'jane@x.com' },
  ]);
  assert.deepEqual(out, { username: 'jane_doe', email: 'jane@x.com', registered_number: '' });
});

test('classifyIdentifiers: email-only form fills username with full email', () => {
  const out = core.classifyIdentifiers([{ type: 'email', value: 'jane@x.com' }]);
  assert.deepEqual(out, { username: 'jane@x.com', email: 'jane@x.com', registered_number: '' });
});

test('classifyIdentifiers: skips empty values', () => {
  const out = core.classifyIdentifiers([
    { type: 'text', value: '' },
    { type: 'text', value: 'jane_doe' },
  ]);
  assert.equal(out.username, 'jane_doe');
});

test('detectScenario: single password field is login', () => {
  assert.deepEqual(core.detectScenario(['hunter2']), { scenario: 'login', password: 'hunter2' });
});

test('detectScenario: two equal fields is signup', () => {
  assert.deepEqual(core.detectScenario(['hunter2', 'hunter2']), { scenario: 'signup', password: 'hunter2' });
});

test('detectScenario: current + new is change-password (new is last)', () => {
  assert.deepEqual(core.detectScenario(['oldpw', 'newpw']), { scenario: 'change-password', password: 'newpw' });
});

test('detectScenario: current + new + confirm uses the repeated new password', () => {
  assert.deepEqual(core.detectScenario(['oldpw', 'newpw', 'newpw']), { scenario: 'change-password', password: 'newpw' });
});

test('detectScenario: no non-empty passwords yields null', () => {
  assert.deepEqual(core.detectScenario(['', '']), { scenario: 'login', password: null });
});

test('detectScenario: two fields with one empty is change-password', () => {
  assert.deepEqual(core.detectScenario(['pw1', '']), { scenario: 'change-password', password: 'pw1' });
});

const ids = (username, email) => ({ username, email, registered_number: '' });

test('resolveCaptureAction: no vault match saves new', () => {
  const r = core.resolveCaptureAction({
    domain: 'example.com', identifiers: ids('jane', 'jane@x.com'),
    password: 'pw', matches: [], ignoredSites: [],
  });
  assert.deepEqual(r, { action: 'save-new', saveId: null, reason: 'not-in-vault' });
});

test('resolveCaptureAction: same identifier + changed password updates', () => {
  const r = core.resolveCaptureAction({
    domain: 'example.com', identifiers: ids('jane', 'jane@x.com'), password: 'newpw',
    matches: [{ _id: 'abc', username: 'jane', email: 'jane@x.com', password_secret: 'oldpw' }],
    ignoredSites: [],
  });
  assert.deepEqual(r, { action: 'update', saveId: 'abc', reason: 'password-changed' });
});

test('resolveCaptureAction: same identifier + same password is suppressed', () => {
  const r = core.resolveCaptureAction({
    domain: 'example.com', identifiers: ids('jane', 'jane@x.com'), password: 'samepw',
    matches: [{ _id: 'abc', username: 'jane', email: 'jane@x.com', password_secret: 'samepw' }],
    ignoredSites: [],
  });
  assert.equal(r.action, 'suppress');
  assert.equal(r.reason, 'already-saved');
});

test('resolveCaptureAction: different identifier on known site saves new account', () => {
  const r = core.resolveCaptureAction({
    domain: 'example.com', identifiers: ids('bob', 'bob@x.com'), password: 'pw',
    matches: [{ _id: 'abc', username: 'jane', email: 'jane@x.com', password_secret: 'oldpw' }],
    ignoredSites: [],
  });
  assert.deepEqual(r, { action: 'save-new', saveId: null, reason: 'new-account' });
});

test('resolveCaptureAction: ignored site suppressed', () => {
  const r = core.resolveCaptureAction({
    domain: 'example.com', identifiers: ids('jane', 'jane@x.com'), password: 'pw',
    matches: [], ignoredSites: ['example.com'],
  });
  assert.equal(r.action, 'suppress');
  assert.equal(r.reason, 'ignored');
});

test('resolveCaptureAction: ignored site matches across www variant', () => {
  const r = core.resolveCaptureAction({
    domain: 'www.example.com', identifiers: ids('jane', 'jane@x.com'), password: 'pw',
    matches: [], ignoredSites: ['example.com'],
  });
  assert.equal(r.action, 'suppress');
  assert.equal(r.reason, 'ignored');
});

test('resolveCaptureAction: passave.org is always suppressed', () => {
  const r = core.resolveCaptureAction({
    domain: 'passave.org', identifiers: ids('jane', 'jane@x.com'), password: 'pw',
    matches: [], ignoredSites: [],
  });
  assert.equal(r.reason, 'self-domain');
});

test('resolveCaptureAction: no password suppressed', () => {
  const r = core.resolveCaptureAction({
    domain: 'example.com', identifiers: ids('jane', ''), password: null,
    matches: [], ignoredSites: [],
  });
  assert.equal(r.reason, 'no-password');
});

test('deriveName: registrable label, capitalized', () => {
  assert.equal(core.deriveName('github.com'), 'Github');
  assert.equal(core.deriveName('www.github.com'), 'Github');
  assert.equal(core.deriveName('mail.google.com'), 'Google');
});

test('deriveName: empty falls back to Credential', () => {
  assert.equal(core.deriveName(''), 'Credential');
});

// ─── buildSaveBody ────────────────────────────────────────────
// An update must change the password and nothing else the user did not touch.
// Sending the captured page's identifiers back wholesale overwrote vault
// fields with '' (email/registered_number) or with a domain-derived name.

const updatePending = {
  action: 'update',
  saveId: 'abc123',
  name: 'Github',
  identifiers: { username: 'jane_doe', email: '', registered_number: '' },
  password: 'new-secret',
  loginURL: 'https://github.com/settings/password',
};

test('buildSaveBody: update sends only the password when nothing was edited', () => {
  const body = core.buildSaveBody(updatePending, {
    name: 'Github',
    username: 'jane_doe',
    email: '',
  });
  assert.deepEqual(body, { password_secret: 'new-secret' });
});

test('buildSaveBody: update never sends empty strings that would wipe vault fields', () => {
  const body = core.buildSaveBody(updatePending, { name: '', username: '', email: '' });
  assert.equal('email' in body, false);
  assert.equal('registered_number' in body, false);
  assert.equal('username' in body, false);
});

test('buildSaveBody: update never moves the stored loginURL', () => {
  const body = core.buildSaveBody(updatePending, {});
  assert.equal('loginURL' in body, false);
});

test('buildSaveBody: update sends only the fields the user actually edited', () => {
  const body = core.buildSaveBody(updatePending, {
    name: 'Work GitHub',
    username: 'jane_doe',
    email: 'jane@work.com',
  });
  assert.deepEqual(body, {
    password_secret: 'new-secret',
    name: 'Work GitHub',
    email: 'jane@work.com',
  });
});

test('buildSaveBody: save-new sends every non-empty field plus the loginURL', () => {
  const body = core.buildSaveBody(
    {
      action: 'save-new',
      name: 'Github',
      identifiers: { username: 'jane@x.com', email: 'jane@x.com', registered_number: '' },
      password: 'secret',
      loginURL: 'https://github.com/join',
    },
    { name: 'Github', username: 'jane@x.com', email: 'jane@x.com' },
  );
  assert.deepEqual(body, {
    password_secret: 'secret',
    name: 'Github',
    username: 'jane@x.com',
    email: 'jane@x.com',
    loginURL: 'https://github.com/join',
  });
});

test('buildSaveBody: trims surrounding whitespace from edits', () => {
  const body = core.buildSaveBody(updatePending, { username: '  jane_new  ' });
  assert.equal(body.username, 'jane_new');
});

// ─── classifier: numeric usernames are not phone numbers ──────

test('classifyIdentifierField: bare digit run is a username, not a phone', () => {
  assert.equal(core.classifyIdentifierField({ type: 'text', value: '12345678' }), 'username');
});

test('classifyIdentifierField: phone hint in the field name wins', () => {
  assert.equal(
    core.classifyIdentifierField({ type: 'text', name: 'mobile_phone', value: '12345678' }),
    'registered_number',
  );
});

test('classifyIdentifierField: punctuated number is still a phone', () => {
  assert.equal(core.classifyIdentifierField({ type: 'text', value: '+1 555 123 4567' }), 'registered_number');
});

// ─── ignore list normalization ────────────────────────────────

test('addIgnoredSite: normalizes and dedupes legacy www entries', () => {
  const next = core.addIgnoredSite(['www.github.com', 'Example.com'], 'github.com');
  assert.deepEqual(next, ['github.com', 'example.com']);
});

test('addIgnoredSite: appends a genuinely new domain', () => {
  const next = core.addIgnoredSite(['github.com'], 'www.Example.com');
  assert.deepEqual(next, ['github.com', 'example.com']);
});
