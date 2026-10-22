import test from 'node:test';
import assert from 'node:assert/strict';
import { conditionSaid, conditionGuard } from '../src/orchestrator/conditionGuard.js';

const SUGAR = 'Your sugars are not bad, six point one, so it is fine. Your LDL cholesterol is one point four, good. We continue the candesartan.';
const mk = () => ({ metadata: {}, past_medical_history: { medical_surgical: 'Diabetes\nHypercholesterolemia\nHypertension\nKidney stone\nSurgery in 2020' }, assessment_and_plan: [{ issue: 'Diabetes and cholesterol management' }, { issue: 'Hematuria' }, { issue: 'Hypertension' }] });

test('a condition inferred from a result is not "said"; a drug that proves it is', () => {
  assert.equal(conditionSaid('Diabetes', SUGAR), false); assert.equal(conditionSaid('Hypercholesterolemia', SUGAR), false);
  assert.equal(conditionSaid('Hypertension', SUGAR), true, 'candesartan is only given for blood pressure');
  assert.equal(conditionSaid('Diabetes', 'you take metformin twice a day'), true); assert.equal(conditionSaid('Diabetes', 'your diabetes is controlled'), true);
  assert.equal(conditionSaid('Hypothyroidism', 'on levothyroxine 100'), true); assert.equal(conditionSaid('Kidney stone', 'you had a kidney stone before'), true);
});
test('unsaid conditions leave Past Medical History; said ones and non-condition lines stay', () => {
  const n = mk(); const r = conditionGuard(n, SUGAR + ' You had a kidney stone before.');
  assert.deepEqual(r.pmhRemoved, ['Diabetes', 'Hypercholesterolemia']); assert.equal(n.past_medical_history.medical_surgical, 'Hypertension\nKidney stone\nSurgery in 2020');
});
test('a problem title keeps only the supported part; nothing supported keeps the title and flags it', () => {
  const n = mk(); const r = conditionGuard(n, 'Your sugar is fine. Your cholesterol is on the statin, high cholesterol, we continue.');
  assert.equal(n.assessment_and_plan[0].issue, 'Blood sugar and cholesterol management', 'sugar was discussed, so the title names the measurement'); assert.equal(r.titlesChanged.length, 1);
  const m = mk(); const r2 = conditionGuard(m, 'The weather is nice today and you look well.'); assert.equal(m.assessment_and_plan[0].issue, 'Diabetes and cholesterol management'); assert.deepEqual(r2.titlesFlagged, ['Diabetes and cholesterol management', 'Hypertension']); assert.equal(m.metadata.flags[0].type, 'condition_not_said');
  assert.equal(m.assessment_and_plan[1].issue, 'Hematuria'); assert.equal(m.assessment_and_plan[2].issue, 'Hypertension');
});

test('everyday wording for the same thing counts: arthritis = osteoarthritis, kidney stones = nephrolithiasis, lymph nodes = lymphadenopathy', () => {
  assert.equal(conditionSaid('Bilateral knee osteoarthritis', 'your knees, the arthritis in both knees is mild'), true);
  assert.equal(conditionSaid('Nephrolithiasis - resolved/inactive', 'you had kidney stones years ago'), true);
  assert.equal(conditionSaid('History of lymphadenopathy, now resolved', 'the lymph nodes in your neck went down'), true);
  assert.equal(conditionSaid('Borderline diabetes mellitus', 'your sugar is okay'), false);
});

test('only the inferred diseases are removed from PMH: an unsaid surgery or other history stays for the grounding agent', () => {
  const lines = ['Hypertension', 'History of total abdominal hysterectomy', 'Sacroiliitis', 'Borderline diabetes'];
  const n = { metadata: {}, past_medical_history: { medical_surgical: lines.join('\n') }, assessment_and_plan: [] };
  const r = conditionGuard(n, 'We talked about your back pain today.');
  assert.deepEqual(r.pmhRemoved, ['Hypertension', 'Borderline diabetes']); assert.equal(n.past_medical_history.medical_surgical, ['History of total abdominal hysterectomy', 'Sacroiliitis'].join('\n'));
});

test('whole-word title repair, cholesterol management counts as said, a condition line with a short note is still checked', () => {
  const n = { metadata: {}, past_medical_history: { medical_surgical: 'Hypercholesterolemia - managed via Lifestyle Rx program' }, assessment_and_plan: [{ issue: 'Prediabetes' }] };
  conditionGuard(n, 'The cholesterol management would be through the lifestyle program. Your sugar is okay.');
  assert.equal(n.past_medical_history.medical_surgical, 'Hypercholesterolemia - managed via Lifestyle Rx program', 'cholesterol management was said'); assert.equal(n.assessment_and_plan[0].issue, 'Blood sugar');
  const m = { metadata: {}, past_medical_history: { medical_surgical: 'Hypertension - on lifestyle program for now' }, assessment_and_plan: [] }; conditionGuard(m, 'We talked about your back.'); assert.equal(m.past_medical_history.medical_surgical, '');
});

import { qualityGuards } from '../src/orchestrator/qualityGuards.js';
test('the condition guard can be switched off for a fair comparison, the other quality guards keep running', () => {
  const mkNote = () => ({ metadata: {}, past_medical_history: { medical_surgical: 'Diabetes' }, assessment_and_plan: [{ issue: 'Diabetes', diagnosis: '', investigations_planned: '', treatment_planned: 'Review', referrals: '' }] });
  const on = mkNote(); qualityGuards(on, 'We talked about your back.', () => {}); assert.equal(on.past_medical_history.medical_surgical, '');
  const off = mkNote(); qualityGuards(off, 'We talked about your back.', () => {}, { conditions: false }); assert.equal(off.past_medical_history.medical_surgical, 'Diabetes');
});
