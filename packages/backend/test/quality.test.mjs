import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake';
const { summarise } = await import('../src/admin/quality.js');

test('per-day production numbers from the quality data stored with each note', () => {
  const rows = [
    { consult_id: 'c1', created_at: '2026-10-24T10:00:00Z', title: 'Hip', flags: [{ severity: 'warning' }, { severity: 'info' }], q: { ledger: { required: 20, placed: 2, forced: 1, stillMissing: 0 }, drugs: { unknown: 1, doseChecks: 0 }, timings: { total: 40000 }, mode: 'v2' } },
    { consult_id: 'c2', created_at: '2026-10-24T11:00:00Z', title: 'BP', flags: [], q: { ledger: { required: 10, placed: 0, forced: 0, stillMissing: 1 }, drugs: { unknown: 0, doseChecks: 0 }, timings: { total: 20000 } } },
    { consult_id: 'c3', created_at: '2026-10-23T09:00:00Z', title: 'Old', flags: [{ severity: 'warning' }], q: null },
  ];
  const s = summarise(rows);
  assert.equal(s.days[0].day, '2026-10-24'); assert.equal(s.days[0].notes, 2); assert.equal(s.days[0].avgSeconds, 30); assert.equal(s.days[0].toCheckPerNote, 0.5); assert.equal(s.days[0].notesWithDrugIssues, 1); assert.equal(s.days[0].factsAdded, 3); assert.equal(s.days[0].factsMissing, 1);
  assert.equal(s.days[1].notes, 1); assert.equal(s.recent[2].mode, 'older pipeline'); assert.equal(s.totals.notes, 3); assert.equal(s.totals.avgSeconds, 30);
});
