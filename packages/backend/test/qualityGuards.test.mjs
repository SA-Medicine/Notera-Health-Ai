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
