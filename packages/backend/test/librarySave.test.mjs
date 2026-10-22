import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// The save route and the history list, exercised against a fake pool (no database): who may save, what is written, how `checks` is counted.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake';
const { _setPool } = await import('../src/db/pool.js');
const calls = [];
let owner = { clinician_id: 'u1' }; let feedbackRow = null; let listRows = [];
_setPool({ query: async (sql, params) => {
  calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  if (/SELECT clinician_id FROM clinical.consults/.test(sql)) return { rows: owner ? [owner] : [] };
  if (/FROM clinical.drafts WHERE consult_id=\$1 AND rendered_note IS NOT NULL/.test(sql)) return { rows: [{ draft_id: 'DRAFT-1', rendered_note: '### Subjective\n- Acid reflux\n- Non-smoker' }] };
  if (/SELECT edits FROM clinical.feedback/.test(sql)) return { rows: feedbackRow ? [{ edits: feedbackRow }] : [] };
  if (/FROM clinical.consults c/.test(sql)) return { rows: listRows };
  return { rows: [] };
} });
const { mountLibrary } = await import('../src/library/libraryRoutes.js');

const app = express(); let user = { id: 'u1', role: 'doctor' };
mountLibrary(app, (req, _res, next) => { req.user = user; next(); });
const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
const put = (id, body) => fetch(`${base}/api/library/consults/${id}/note`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('the clinician\'s edited note is saved as a DRAFT final with the corrections and the diff', async () => {
  calls.length = 0;
  const r = await put('c1', { renderedNote: '### Subjective\n- Acid reflux', corrections: [{ action: 'removed', flagType: 'check_against_recording', flagMessage: '"Non-smoker" - not said', before: 'Non-smoker' }, { action: 'bogus' }] });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, saved: true, corrections: 1 });
  const fin = calls.find((c) => /INSERT INTO clinical.finals/.test(c.sql)); assert.ok(fin); assert.match(fin.sql, /'DRAFT'::clinical.note_status/); assert.equal(fin.params[0], 'f_c1'); assert.equal(fin.params[2], 'DRAFT-1');
  assert.equal(JSON.parse(fin.params[3]).rendered, '### Subjective\n- Acid reflux');
  const fb = calls.find((c) => /INSERT INTO clinical.feedback/.test(c.sql)); assert.equal(fb.params[0], 'fb_c1');
  const edits = JSON.parse(fb.params[5]); assert.equal(edits.events.length, 1); assert.deepEqual(edits.diff.removed, ['Non-smoker']);
});
test('later saves append to the stored corrections', async () => {
  feedbackRow = { events: [{ action: 'kept', flagMessage: 'A' }] }; calls.length = 0;
  await put('c1', { renderedNote: 'x', corrections: [{ action: 'edited', flagMessage: 'B' }] });
  assert.equal(JSON.parse(calls.find((c) => /INSERT INTO clinical.feedback/.test(c.sql)).params[5]).events.length, 2); feedbackRow = null;
});
test('only the owner (or an admin) may save, an empty note is refused', async () => {
  user = { id: 'u2', role: 'doctor' }; assert.equal((await put('c1', { renderedNote: 'x' })).status, 403);
  user = { id: 'a1', role: 'admin' }; assert.equal((await put('c1', { renderedNote: 'x' })).status, 200);
  user = { id: 'u1', role: 'doctor' }; assert.equal((await put('c1', { renderedNote: '   ' })).status, 400);
  owner = null; assert.equal((await put('nope', { renderedNote: 'x' })).status, 404); owner = { clinician_id: 'u1' };
});
test('the history list counts only the flags the clinician has not resolved', async () => {
  listRows = [{ consult_id: 'c1', title: 'T', flags_json: [{ severity: 'warning', message: 'A' }, { severity: 'warning', message: 'B' }, { severity: 'info', message: 'C' }], edits_json: { events: [{ flagMessage: 'A', action: 'kept' }] } },
    { consult_id: 'c2', title: 'U', flags_json: null, edits_json: null }];
  const r = await (await fetch(`${base}/api/library/consults`)).json();
  assert.equal(r.consults[0].checks, 1); assert.equal(r.consults[1].checks, 0); assert.ok(!('flags_json' in r.consults[0]) && !('edits_json' in r.consults[0]));
});
