import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityGuards, cleanSpeech, diagnosisSupport } from '../src/orchestrator/qualityGuards.js';
import { classify } from '../src/orchestrator/adviceLines.js';

const TX = 'Your B twelve is low so start a supplement. Your blood pressure is fine. You have hypertension and we continue candesartan. Ultrasound of your kidneys on June 3rd.';
const mk = (o) => ({ assessment_and_plan: [{ issue: 'x', diagnosis: '', investigations_planned: '', treatment_planned: '', referrals: '', ...o }] });

test('a diagnosis the clinician never said is cleared, the title stays', () => {
  const n = mk({ issue: 'Low B12', diagnosis: 'Vitamin B12 deficiency' }); const r = qualityGuards(n, TX);
  assert.equal(n.assessment_and_plan[0].diagnosis, ''); assert.equal(n.assessment_and_plan[0].issue, 'Low B12'); assert.deepEqual(r.dxCleared, ['Vitamin B12 deficiency']);
});
test('a diagnosis that is in the transcript is kept', () => { const n = mk({ issue: 'Hypertension', diagnosis: 'Hypertension' }); qualityGuards(n, TX); assert.equal(n.assessment_and_plan[0].diagnosis, 'Hypertension'); });
test('a cleared diagnosis becomes the title when the title was empty', () => { const n = mk({ issue: '', diagnosis: 'Nephrolithiasis' }); qualityGuards(n, TX); assert.equal(n.assessment_and_plan[0].issue, 'Nephrolithiasis'); assert.equal(n.assessment_and_plan[0].diagnosis, ''); });
test('spoken words are removed from the plan and "your" becomes "the"', () => {
  assert.deepEqual(cleanSpeech('Cipro (ciprofloxacin), the antibiotics; And you did that for seven days'), { text: 'Cipro (ciprofloxacin), the antibiotics', removed: 1 });
  assert.equal(cleanSpeech('Ultrasound of your kidneys').text, 'Ultrasound of the kidneys');
  const n = mk({ investigations_planned: 'Ultrasound of your kidneys\nI will order the labs' }); const r = qualityGuards(n, TX); assert.equal(n.assessment_and_plan[0].investigations_planned, 'Ultrasound of the kidneys'); assert.equal(r.speechRemoved, 1);
});
test('support score', () => { assert.ok(diagnosisSupport('Hypertension', new Set(['hyperten']) ) >= 0.6); assert.ok(diagnosisSupport('Vitamin B12 deficiency', new Set(['suppl'])) < 0.6); });
test('a recommended supplement is a treatment, not advice', () => { assert.equal(classify('Recommended starting B12 supplements'), 'treat'); assert.equal(classify('Advised to rest'), 'advice'); });

import { fixLaterality, sidesFor } from '../src/orchestrator/qualityGuards.js';
test('a wrong side is corrected when the transcript names only one side for that part', () => {
  const tx = "What other symptoms do you have in the left eye? Nothing? How often have you been using the Visine in that eye?";
  const note = { subjective: { reason_for_visit: 'Right eye redness since last week\nRight eye: looks a little red' }, objective: {}, past_medical_history: {}, assessment_and_plan: [{ issue: 'Right eye redness and itchiness', treatment_planned: 'Stop Visine in the right eye' }] };
  const fixes = fixLaterality(note, tx);
  assert.equal(fixes.length, 4); assert.match(note.subjective.reason_for_visit, /^Left eye redness/); assert.equal(note.assessment_and_plan[0].issue, 'Left eye redness and itchiness'); assert.match(note.assessment_and_plan[0].treatment_planned, /left eye/);
});
test('both sides in the transcript, or a correct note, are left alone', () => {
  const both = 'Pain in the left knee and some swelling in the right knee.';
  const n1 = { subjective: { x: 'Right knee swelling' }, assessment_and_plan: [] }; assert.equal(fixLaterality(n1, both).length, 0); assert.equal(n1.subjective.x, 'Right knee swelling');
  const n2 = { subjective: { x: 'Left eye redness' }, assessment_and_plan: [] }; assert.equal(fixLaterality(n2, 'left eye is red').length, 0);
  assert.deepEqual([...sidesFor('my left eye and my right ear', 'eye')], ['left']);
});
test('qualifier words do not count against a diagnosis', () => {
  const n = mk({ issue: 'Cataracts', diagnosis: 'Bilateral cataracts' }); qualityGuards(n, 'You have cataracts and surgery is planned.'); assert.equal(n.assessment_and_plan[0].diagnosis, 'Bilateral cataracts');
});
