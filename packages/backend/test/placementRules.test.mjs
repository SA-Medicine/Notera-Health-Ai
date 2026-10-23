import test from 'node:test';
import assert from 'node:assert/strict';
import { fixPlacementV2 } from '../src/orchestrator/placementRules.js';

const prob = (o) => ({ issue: 'Hypertension', diagnosis: '', assessment: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: '', referrals: '', ...o });

test('a vital sign with a number written as a treatment moves to Objective; real treatment and targets stay', () => {
  const n = { objective: {}, assessment_and_plan: [prob({ treatment_planned: 'Blood pressure 150/80 mmHg; Continue amlodipine 5 mg daily; Home BP target 130/80' })] };
  const r = fixPlacementV2(n); assert.equal(r.vitals, 1); assert.equal(n.objective.vital_signs, 'Blood pressure 150/80 mmHg');
  assert.equal(n.assessment_and_plan[0].treatment_planned, 'Continue amlodipine 5 mg daily; Home BP target 130/80');
});
test('a vaccine given in the visit, written as an examination finding, becomes an item of the Immunisation problem; nothing is lost', () => {
  const n = { objective: { examination: 'Lungs clear\nMMR vaccine administered to left arm (Lot Z011165, expiry July 2027)' }, assessment_and_plan: [prob({ issue: 'Cough' })] };
  const r = fixPlacementV2(n); assert.equal(r.given, 1); assert.equal(n.objective.examination, 'Lungs clear');
  const im = n.assessment_and_plan.find((p) => p.issue === 'Immunisation'); assert.match(im.treatment_planned, /MMR vaccine administered to left arm \(Lot Z011165/);
  const again = { objective: { completed_investigations: 'Flu vaccine administered' }, assessment_and_plan: [prob({ issue: 'Influenza vaccination' })] }; fixPlacementV2(again); assert.equal(again.assessment_and_plan.length, 1);
});
test('a long history text under Referrals that names no referral is cut; a real referral is kept', () => {
  const n = { assessment_and_plan: [prob({ referrals: 'The right shoulder pain has improved and is less severe compared to the last visit; she still cannot lift the arm above shoulder height and wakes at night with it. '.repeat(2) }), prob({ issue: 'Bunion', referrals: 'Foot surgeon for bunion assessment' })] };
  const r = fixPlacementV2(n); assert.equal(r.referralsCut, 1); assert.equal(n.assessment_and_plan[0].referrals, ''); assert.equal(n.assessment_and_plan[1].referrals, 'Foot surgeon for bunion assessment');
});
test('an empty or partial note is safe', () => { assert.deepEqual(fixPlacementV2({}), { vitals: 0, given: 0, referralsCut: 0 }); });
