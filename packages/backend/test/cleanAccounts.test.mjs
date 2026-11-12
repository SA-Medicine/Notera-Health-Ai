import test from 'node:test';
import assert from 'node:assert/strict';
import { isCleanNoteClinician, keepCriticalFlags, _resetCleanCache } from '../src/orchestrator/cleanAccounts.js';

test('clean-note accounts: only the listed emails, matched ignoring case; empty list or unknown clinician means nobody; a failed lookup means not clean', async () => {
  _resetCleanCache(); delete process.env.CLEAN_NOTE_EMAILS;
  const lookup = async (id) => ({ email: id === 'u1' ? 'Seema.Aggarwal@agilepartners-ai.com' : 'other@x.com' });
  assert.equal(await isCleanNoteClinician('u1', { lookup }), false);   // list empty: nobody
  process.env.CLEAN_NOTE_EMAILS = ' seema.aggarwal@agilepartners-ai.com , b@y.com ';
  assert.equal(await isCleanNoteClinician('u1', { lookup }), true);
  assert.equal(await isCleanNoteClinician('u2', { lookup }), false);
  assert.equal(await isCleanNoteClinician('unknown', { lookup }), false);
  _resetCleanCache(); assert.equal(await isCleanNoteClinician('u3', { lookup: async () => { throw new Error('db down'); } }), false);
  delete process.env.CLEAN_NOTE_EMAILS; _resetCleanCache();
});

test('clean-note accounts keep only the two flags that say the whole note is unusable', () => {
  const flags = [{ type: 'plan_unclear' }, { type: 'empty_encounter' }, { type: 'drug_review' }, { type: 'input_not_consultation' }, { type: 'condition_not_said' }];
  assert.deepEqual(keepCriticalFlags(flags).map((f) => f.type), ['empty_encounter', 'input_not_consultation']);
  assert.deepEqual(keepCriticalFlags(undefined), []);
});
