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
