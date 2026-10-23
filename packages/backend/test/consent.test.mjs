import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake';
const { TERMS_VERSION } = await import('../src/auth/quota.js');

test('the terms version is a date string the pages and the app agree on', () => {
  assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});
