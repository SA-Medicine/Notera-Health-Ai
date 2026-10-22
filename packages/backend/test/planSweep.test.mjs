import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptAdditions, parseSweep, sweepPlan } from '../src/orchestrator/planSweep.js';

const TX = 'So your cholesterol is a little high at 3.3 but within the green zone, just watch it. Also you are due for a mammogram after October. Take the tetanus shot today. Come back in July.';
const existing = [{ issue: 'Menopausal symptoms', treatment_planned: 'Continue vitamins' }];
const add = (o) => ({ title: 'Mildly elevated cholesterol', treatment_planned: 'Watch diet', evidence: 'your cholesterol is a little high at 3.3 but within the green zone', ...o });

test('a well-evidenced missing issue is added', () => {
  const r = acceptAdditions([add()], existing, TX); assert.equal(r.keep.length, 1); assert.equal(r.keep[0].issue, 'Mildly elevated cholesterol'); assert.equal(r.keep[0].diagnosis, '', 'no diagnosis is ever created');
});
test('a quote that is not in the transcript is dropped', () => {
  const r = acceptAdditions([add({ evidence: 'your cholesterol is dangerously high and needs medication' })], existing, TX); assert.equal(r.keep.length, 0); assert.match(r.dropped[0].why, /quote/);
});
test('an issue an existing problem already covers is dropped', () => {
  assert.equal(acceptAdditions([add({ title: 'Menopausal symptoms', evidence: 'you are due for a mammogram after October' })], existing, TX).keep.length, 0);
  const ex2 = [{ issue: 'Hyperlipidemia', treatment_planned: 'Cholesterol 3.3, watch diet' }];
  assert.equal(acceptAdditions([add()], ex2, TX).keep.length, 0, 'the plan lines already mention it');
});
test('follow-up, differentials and empty additions are dropped; the limit is 4', () => {
  assert.equal(acceptAdditions([add({ title: 'Follow-up in July', evidence: 'Come back in July' , treatment_planned: 'July' })], existing, TX).keep.length, 0);
  assert.equal(acceptAdditions([add({ title: 'Rule out thyroid disease' })], existing, TX).keep.length, 0);
  assert.equal(acceptAdditions([add({ treatment_planned: '' })], existing, TX).keep.length, 0);
  const many = ['Mammogram screening', 'Tetanus vaccination', 'Colon screening', 'Pap smear', 'Eye check'].map((t) => ({ title: t, treatment_planned: 'x', evidence: 'you are due for a mammogram after October' }));
  assert.ok(acceptAdditions(many, [], TX).keep.length <= 4);
});
test('bad model output means no additions, never an error', () => { assert.deepEqual(parseSweep('not json'), []); assert.deepEqual(parseSweep('{"additions":[]}'), []); assert.equal(parseSweep('```json\n{"additions":[{"title":"x"}]}\n```').length, 1); });
test('the stage appends to the plan, leaves existing problems untouched, and logs', async () => {
  const note = { assessment_and_plan: [{ issue: 'Menopausal symptoms', diagnosis: '', assessment: '', treatment_planned: 'Continue vitamins', investigations_planned: '', referrals: '', differential_diagnoses: [] }] };
  const before = JSON.stringify(note.assessment_and_plan[0]); const logs = [];
  const llm = { generateContent: async () => JSON.stringify({ additions: [add(), add({ title: 'Breast cancer screening', treatment_planned: '', investigations_planned: 'Mammogram after October', evidence: 'you are due for a mammogram after October' })] }) };
  const r = await sweepPlan(llm, note, TX, (l) => logs.push(l));
  assert.deepEqual(r.added, ['Mildly elevated cholesterol', 'Breast cancer screening']); assert.equal(note.assessment_and_plan.length, 3); assert.equal(JSON.stringify(note.assessment_and_plan[0]), before);
  assert.ok(logs[0].includes('[v2:sweep] 2 problem(s) added'));
});

test('tests, drugs, reviews and additions with no action are not issues', () => {
  const tx = 'We refilled the Zoloft today. Your hemoglobin looks fine. You are due for a mammogram after October.';
  const q = { evidence: 'You are due for a mammogram after October' };
  const note = { past_medical_history: { medications: 'Zoloft 50 mg daily' } };
  assert.equal(acceptAdditions([{ title: 'Hemoglobin', treatment_planned: 'x', ...q }], [], tx, note).keep.length, 0);
  assert.equal(acceptAdditions([{ title: 'Blood test results', treatment_planned: 'x', ...q }], [], tx, note).keep.length, 0);
  assert.equal(acceptAdditions([{ title: 'Zoloft', treatment_planned: 'refilled', ...q }], [], tx, note).keep.length, 0, 'a drug of the note is not an issue');
  assert.equal(acceptAdditions([{ title: 'Breast cancer screening', assessment: 'Due', ...q }], [], tx, note).keep.length, 0, 'an assessment alone, with no action, is not added');
  assert.equal(acceptAdditions([{ title: 'Breast cancer screening', investigations_planned: 'Mammogram after October', ...q }], [], tx, note).keep.length, 1);
});
