import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceTemplate, fixMisplacement, drugPlausibility, checkInput } from '../src/orchestrator/postGuards.js';

const mk = () => ({ metadata: {}, subjective: { hpi_details: 'Cough 3 days' }, past_medical_history: { other: 'Current medications: ramipril 5 mg\nFather had MI' }, objective: { vital_signs: 'BP 130/80', physical_exam: 'Reports chest tightness\nDenies fever\nLungs clear on auscultation' },
  assessment_and_plan: [{ issue: 'Cough', treatment_planned: 'Amoxicillin 500 mg' }, { issue: 'Follow-up', treatment_planned: 'Review in 2 weeks' }] });

test('enforceTemplate keeps the Medications line, drops a duplicate Current-medications line, folds the follow-up problem', () => {
  const n = mk(); n.past_medical_history.other += '\nMedications: ramipril 5 mg'; const r = enforceTemplate(n);
  assert.equal(r.medLinesRemoved, 1); assert.equal(n.past_medical_history.other, 'Father had MI\nMedications: ramipril 5 mg');
  const alone = mk(); enforceTemplate(alone); assert.match(alone.past_medical_history.other, /Current medications/, 'a lone medication line is kept');
  assert.equal(n.assessment_and_plan.length, 1); assert.match(n.assessment_and_plan[0].treatment_planned, /Follow-up: Review in 2 weeks/);
  const only = { metadata: {}, past_medical_history: {}, assessment_and_plan: [{ issue: 'Follow-up', treatment_planned: 'x' }] };
  enforceTemplate(only); assert.equal(only.assessment_and_plan.length, 1, 'a lone Follow-up problem is kept');
});
test('fixMisplacement moves reported symptoms, keeps exam findings', () => {
  const n = mk(); const r = fixMisplacement(n);
  assert.equal(r.moved.length, 2); assert.match(n.subjective.hpi_details, /Reports chest tightness/); assert.equal(n.objective.physical_exam, 'Lungs clear on auscultation');
});
test('drugPlausibility flags a drug without any indication, never edits', () => {
  const n = mk(); n.assessment_and_plan[0].treatment_planned = 'Metformin 500 mg';
  const r = drugPlausibility(n, 'Patient has a cough for three days'); assert.equal(r.flagged[0].drug, 'metformin'); assert.equal(n.metadata.flags[0].type, 'drug_indication_unclear');
  const m = mk(); m.assessment_and_plan[0].treatment_planned = 'Metformin 500 mg'; assert.equal(drugPlausibility(m, 'Her A1c is high, diabetes').flagged.length, 0);
});
test('checkInput accepts a consultation and flags a schedule', () => {
  assert.equal(checkInput('Doctor: How are you feeling? Patient: I have had pain in my knee for three weeks and I take naproxen. ' + 'okay yes no '.repeat(10)).ok, true);
  const sched = Array.from({ length: 10 }, (_, i) => `${8 + i}:00 Ward round bay ${i} MRI list`).join('\n') + '\nTheatre list for Monday and clinics for Tuesday on level four of the east building';
  assert.equal(checkInput(sched).reason, 'schedule_or_list'); assert.equal(checkInput('hello there').reason, 'too_short');
});

import { tidyPlan, sweepEmptyStatements } from '../src/orchestrator/postGuards.js';
test('tidyPlan removes repeated and bare plan items and a repeated drug in the Medications line', () => {
  const n = { metadata: {}, past_medical_history: { other: 'Medications: Synthroid 88 mcg, metoprolol bid, Senna prn, senna' },
    assessment_and_plan: [{ issue: 'Abdominal pain', investigations_planned: 'Ultrasound abdomen via Belle River\nultrasound for abdomen and pelvis', treatment_planned: 'Follow-up: January; Rtc' }, { issue: 'Hypothyroidism', investigations_planned: 'Repeat blood test', treatment_planned: 'Restart Synthroid 88 mcg daily' }] };
  const r = tidyPlan(n);
  assert.equal(n.assessment_and_plan[0].investigations_planned, 'Ultrasound abdomen via Belle River');
  assert.equal(n.assessment_and_plan[0].treatment_planned, 'Follow-up: January');
  assert.equal(n.past_medical_history.other, 'Medications: Synthroid 88 mcg, metoprolol bid, Senna prn'); assert.ok(r.dropped >= 3);
});
test('sweepEmptyStatements removes "not mentioned" lines but keeps real denials', () => {
  const n = { metadata: {}, subjective: { hpi_details: 'Denies nausea\nFamily history: none mentioned' }, past_medical_history: { other: 'Preventive care: none mentioned.' }, objective: {} };
  sweepEmptyStatements(n); assert.equal(n.subjective.hpi_details, 'Denies nausea'); assert.equal(n.past_medical_history.other, '');
});

import { dropCoveredFragments, dedupeObjective } from '../src/orchestrator/postGuards.js';
test('old fragments covered by the topics are dropped; uncovered ones stay', () => {
  const n = { metadata: {}, subjective: { reason_for_visit: 'Presenting Complaint:\nAbdominal pain', hpi_details: 'Abdominal Pain:\nWorse after eating, not fatty foods\nDenies nausea or fever', aggravating_relieving_factors: 'Abdominal pain: worse after eating\nBetter when lying flat', associated_symptoms: 'Abdominal pain: denies nausea, fever' } };
  dropCoveredFragments(n); assert.equal(n.subjective.aggravating_relieving_factors, 'Better when lying flat'); assert.equal(n.subjective.associated_symptoms, '');
});
test('a result stated twice in Objective is kept once, in the fuller form', () => {
  const n = { metadata: {}, objective: { completed_investigations: 'MIBI scan (11 Apr 2025): normal perfusion study, no evidence of blockage or heart attack\nMibi test: normal perfusion study (April 11th)\nChest X-ray: normal' } };
  dedupeObjective(n); assert.equal(n.objective.completed_investigations, 'MIBI scan (11 Apr 2025): normal perfusion study, no evidence of blockage or heart attack\nChest X-ray: normal');
});
