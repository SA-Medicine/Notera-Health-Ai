import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanNote, collapseLoops, editorAccepts } from '../src/orchestrator/generateNoteV2.js';
import { emptyNote, emptyIssue } from '@notera/schema';

test('removes leaked reasoning, "none stated" filler and run-ons; keeps real facts', () => {
  const n = emptyNote({});
  n.past_medical_history.social = [
    'Busy working', 'Considering cutting back on work',
    'Lives in general location mentioned in transcript context',
    'Smoking: none stated', 'Alcohol: none stated',
    'Living situation: none stated outside of family mentions (son mentioned). All as per transcript context provided without additions or assumptions beyond what is literally mentioned.',
  ].join('\n');
  n.objective.vital_signs = [
    'Blood pressure: 142/85 at home (reported by patient)',
    "Clinician blood pressure/vitals: none specifically measured on-site in transcript besides patient self-report of 142/85; clinician noted their own reading was 132/80 in passing conversation context, but patient's reported blood pressure is 142/85 mmHg at home. Leave exact other vitals unstated as none are given in transcript text. Let's list patient's home blood pressure 142/85 mmHg as stated in transcript.",
    "Let's list patient's home blood pressure 142/85 mmHg as stated in transcript.",
    'BP 132/80 in clinic', 'BP 132/80 in clinic',
  ].join('\n');
  const i = emptyIssue(); i.issue = 'Hypertension'; i.diagnosis = 'Hypertension - controlled'; i.treatment_planned = 'Continue valsartan 160 mg; Continue amlodipine 2.5 mg';
  n.assessment_and_plan = [i];
  const removed = cleanNote(n);
  assert.ok(removed >= 6, `removed ${removed}`);
  const social = n.past_medical_history.social.split('\n');
  assert.deepEqual(social, ['Busy working', 'Considering cutting back on work']);
  const vit = n.objective.vital_signs;
  assert.ok(vit.includes('Blood pressure: 142/85 at home (reported by patient)'));
  assert.ok(vit.includes('BP 132/80 in clinic'));
  assert.equal((vit.match(/BP 132\/80 in clinic/g) || []).length, 1, 'exact duplicates collapse');
  assert.ok(!/Let's|transcript|unstated|none stated/i.test(vit));
  assert.equal(n.assessment_and_plan[0].treatment_planned, 'Continue valsartan 160 mg; Continue amlodipine 2.5 mg', 'real plan untouched');
});

test('splits "a; b" history lines, strips trailing ; and keeps plan lists intact', () => {
  const n = emptyNote({});
  n.subjective.hpi_details = 'Chest pain started 8 days ago;\nPain worse with deep breath; Shortness of breath worse with exertion;';
  const i = emptyIssue(); i.issue = 'X'; i.treatment_planned = 'Continue valsartan 160mg; Continue amlodipine 2.5mg'; n.assessment_and_plan = [i];
  cleanNote(n);
  assert.deepEqual(n.subjective.hpi_details.split('\n'), ['Chest pain started 8 days ago', 'Pain worse with deep breath', 'Shortness of breath worse with exertion']);
  assert.equal(n.assessment_and_plan[0].treatment_planned, 'Continue valsartan 160mg; Continue amlodipine 2.5mg');
});

test('collapseLoops removes model degeneration but keeps real text', () => {
  assert.equal(collapseLoops('Infant daughter the patient or the patient or the patient or the patient or the patient'), 'Infant daughter');
  assert.equal(collapseLoops('Current medications: methonamic acid, the patient, the patient'), 'Current medications: methonamic acid');
  assert.equal(collapseLoops('pain pain pain pain in the knee'), 'pain in the knee');
  assert.equal(collapseLoops('Denies fever; the patient reports no cough'), 'Denies fever; the patient reports no cough');
  assert.equal(collapseLoops('Continue the medication, the medication is tolerated'), 'Continue the medication, the medication is tolerated');
  assert.equal(collapseLoops('no no'), 'no no');
  assert.equal(collapseLoops('Metformin 500 mg twice daily'), 'Metformin 500 mg twice daily');
});

test('editorAccepts keeps safe edits and rejects loss or invention', () => {
  const transcript = 'Patient has knee pain for 3 weeks. Denies fever. Taking naproxen 500 mg twice daily. Referred to physiotherapy. Follow up in 3 months.';
  const draft = { subjective: { hpi_details: 'Knee pain for 3 weeks\nDenies fever' }, objective: { vital_signs: 'Naproxen 500 mg twice daily' }, assessment_and_plan: [{ issue: 'Knee pain', treatment_planned: 'Naproxen 500 mg twice daily', referrals: 'Physiotherapy' }, { issue: 'Follow-up', treatment_planned: 'Rtc: 3 months' }] };
  const moved = { subjective: { hpi_details: 'Knee pain for 3 weeks\nDenies fever\nTaking naproxen 500 mg twice daily' }, objective: { vital_signs: '' }, assessment_and_plan: draft.assessment_and_plan };
  assert.equal(editorAccepts(draft, moved, transcript).ok, true, 'moving a line between sections is accepted');
  assert.equal(editorAccepts(draft, { ...moved, assessment_and_plan: [] }, transcript).ok, false, 'dropping every problem is rejected');
  const invented = { ...moved, assessment_and_plan: [{ issue: 'Knee pain', treatment_planned: 'Naproxen 750 mg twice daily', referrals: 'Physiotherapy' }, draft.assessment_and_plan[1]] };
  assert.equal(editorAccepts(draft, invented, transcript).ok, false, 'a dose that is not in the transcript is rejected');
  const gutted = { subjective: { hpi_details: 'Knee pain' }, objective: {}, assessment_and_plan: [{ issue: 'Knee pain' }] };
  assert.equal(editorAccepts(draft, gutted, transcript).ok, false, 'losing most of the draft is rejected');
});
