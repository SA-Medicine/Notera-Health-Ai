import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMeds, codeDiagnoses } from '../src/orchestrator/refNames.js';
import { fixMisplacement } from '../src/orchestrator/postGuards.js';

// A tiny fake of the two NIH services (exact lookups only), so no network is needed.
const fakeFetch = async (url) => {
  const u = String(url); const ok = (j) => ({ ok: true, json: async () => j });
  if (u.includes('rxcui.json')) { const n = decodeURIComponent(u.match(/name=([^&]+)/)[1]).toLowerCase(); const ids = { synthroid: '224920', metoprolol: '221124' }; return ok({ idGroup: { rxnormId: ids[n] ? [ids[n]] : [] } }); }
  if (u.includes('/related.json')) return ok({ relatedGroup: { conceptGroup: u.includes('224920') ? [{ tty: 'BN', conceptProperties: [{ name: 'Synthroid' }] }, { tty: 'IN', conceptProperties: [{ name: 'levothyroxine' }] }] : [{ tty: 'BN', conceptProperties: [{ name: 'Toprol' }] }, { tty: 'IN', conceptProperties: [{ name: 'metoprolol' }] }] } });
  if (u.includes('icd10cm')) { const t = decodeURIComponent(u.match(/terms=([^&]+)/)[1]).toLowerCase(); return ok(t.includes('hypothyroid') ? [1, ['E03.9'], null, [['E03.9', 'Hypothyroidism, unspecified']]] : [0, [], null, []]); }
  throw new Error('unexpected ' + u);
};

test('a spoken brand gets its generic in brackets; a generic and an unknown name are left alone', async () => {
  const note = { metadata: {}, past_medical_history: { other: 'Medications: Synthroid 88 mcg daily, metoprolol twice daily, Crindia 10 mg' }, assessment_and_plan: [{ issue: 'Hypothyroidism', treatment_planned: 'Restart Synthroid 88 mcg daily; Synthroid after bloods' }] };
  const r = await describeMeds(note, ['Synthroid', 'metoprolol', 'Crindia'], { fetchImpl: fakeFetch });
  assert.deepEqual(r, [{ spoken: 'Synthroid', generic: 'levothyroxine' }]);
  assert.match(note.past_medical_history.other, /Synthroid \(levothyroxine\) 88 mcg daily, metoprolol twice daily, Crindia 10 mg/);
  assert.equal((note.assessment_and_plan[0].treatment_planned.match(/levothyroxine/g) || []).length, 1, 'annotated once per field');
});
test('a stated diagnosis gets an ICD-10 code; an unknown one is flagged; the wording never changes', async () => {
  const note = { metadata: {}, assessment_and_plan: [{ issue: 'Hypothyroidism', diagnosis: 'Hypothyroidism' }, { issue: 'x', diagnosis: 'Zzyzx syndrome' }, { issue: 'Pain', diagnosis: '' }] };
  await codeDiagnoses(note, { fetchImpl: fakeFetch });
  assert.equal(note.metadata.problem_codes[0].icd10, 'E03.9'); assert.equal(note.assessment_and_plan[0].diagnosis, 'Hypothyroidism');
  assert.equal(note.metadata.flags[0].type, 'diagnosis_not_in_reference');
});
test('an unreachable reference leaves the note unchanged', async () => {
  const note = { metadata: {}, past_medical_history: { other: 'Medications: Ozempic 1 mg' }, assessment_and_plan: [{ issue: 'a', diagnosis: 'Hypertension' }] };
  const down = async () => { throw new Error('offline'); };
  await describeMeds(note, ['Ozempic'], { fetchImpl: down }); await codeDiagnoses(note, { fetchImpl: down });
  assert.equal(note.past_medical_history.other, 'Medications: Ozempic 1 mg'); assert.equal(note.metadata.flags, undefined);
});
test('a vital sign without a number moves to the history', () => {
  const n = { metadata: {}, subjective: { hpi_details: 'Cough' }, objective: { vital_signs: 'Blood pressure stable per history\nBP 130/80' } };
  fixMisplacement(n); assert.equal(n.objective.vital_signs, 'BP 130/80'); assert.match(n.subjective.hpi_details, /Blood pressure stable per history/);
});
