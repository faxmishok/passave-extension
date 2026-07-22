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
