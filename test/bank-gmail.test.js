'use strict';
const test = require('node:test');
const assert = require('node:assert');
const bank = require('../bank-gmail');

test('bank Gmail only asks for read-only Gmail', () => {
  assert.deepStrictEqual(bank.SCOPES, ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']);
});

test('bank query always stays limited to bank senders', () => {
  const q = bank.bankQuery('newer_than:3d from:evil.com OR (anything)');
  assert.ok(q.startsWith('from:(bca.co.id OR '));
  assert.ok(!/evil\.com/.test(q));
  assert.ok(!/[()]/.test(q.slice(q.indexOf(')') + 1)));
});

test('authorization url uses login hint for the approved mailbox only', () => {
  process.env.GOOGLE_CLIENT_ID = 'x'; process.env.GOOGLE_CLIENT_SECRET = 'y'; process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = 'z';
  bank.init('/tmp/bank-gmail-test');
  const url = new URL(bank.buildAuthorizationUrl('state123'));
  assert.strictEqual(url.searchParams.get('login_hint'), 'harfiyanafni@gmail.com');
  assert.strictEqual(url.searchParams.get('scope'), bank.SCOPES.join(' '));
});
