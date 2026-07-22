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
