import test from 'node:test';
import assert from 'node:assert/strict';
import { conditionGuard } from '../src/orchestrator/conditionGuard.js';
import { whyUnclear, unclearPlan } from '../src/orchestrator/unclearPlan.js';
import { groupRuns } from '../src/orchestrator/groupRuns.js';
import { sweepStuckConsults } from '../src/ops/stuckConsults.js';

const mkNote = () => ({ past_medical_history: { medical_surgical: 'Hypertension\nAsthma\nFracture 2015' }, assessment_and_plan: [{ issue: 'Hypertension' }] });

test('condition guard, flags-only: nothing is removed or renamed, unsaid conditions are flagged, brand names count as proof', () => {
  const n = mkNote();
  const r = conditionGuard(n, 'He says the blood pressure was 140 over 90 today.', () => {}, { flagOnly: true });
  assert.equal(n.past_medical_history.medical_surgical, 'Hypertension\nAsthma\nFracture 2015');   // untouched
  assert.equal(n.assessment_and_plan[0].issue, 'Hypertension');
  assert.deepEqual(r.pmhFlagged.sort(), ['Asthma', 'Hypertension']);
  assert.ok(n.metadata.flags.some((f) => f.field === 'past_medical_history' && /Hypertension/.test(f.message)));
  // Atacand Plus (candesartan) and a puffer prove hypertension and asthma
  const n2 = mkNote(); const r2 = conditionGuard(n2, 'Continue Atacand Plus. Use the puffer when needed.', () => {}, { flagOnly: true });
  assert.deepEqual(r2.pmhFlagged, []); assert.equal(r2.titlesFlagged.length, 0);
  // the old removing mode is unchanged
  const n3 = mkNote(); conditionGuard(n3, 'blood pressure was 140 over 90', () => {});
  assert.ok(!/Hypertension/.test(n3.past_medical_history.medical_surgical));
});

test('unclear plan: a bare medicine phrase is flagged, real plan lines are not', () => {
  for (const l of ['Sleeping pills', 'Cortisone cream', 'Figure supplement', 'Vitamin D supplement']) assert.match(whyUnclear(l), /medicine with no action/, l);
  for (const l of ['Start sleeping pills', 'Continue cortisone cream twice daily', 'Prescription printed', 'Atacand Plus', 'Physiotherapy referral', 'Current medication regimen', 'Declined sleeping pills']) assert.equal(whyUnclear(l), '', l);
  const md = '### Assessment & Plan\n1. **Insomnia**\n   - Sleeping pills\n   - Sleep hygiene advice\n';
  const u = unclearPlan(md); assert.equal(u.flags.length, 1); assert.match(u.flags[0].message, /Sleeping pills/);
});

test('past medical history: lifestyle lines become one Social line, nothing else moves or changes', () => {
  const md = '### Past Medical History\n- Works as a teacher (grade 4, 5), children\n- Attends yoga regularly\n- Sister: diagnosed with ADHD\n- Medications: CBD 2 mg\n\n### Objective\n- Deferred';
  const r = groupRuns(md);
  assert.equal(r.socialGrouped, 1);
  assert.equal(r.md, '### Past Medical History\n- Social: works as a teacher (grade 4, 5), children; attends yoga regularly\n- Sister: diagnosed with ADHD\n- Medications: CBD 2 mg\n\n### Objective\n- Deferred');
  const one = '### Past Medical History\n- Works as a teacher\n- Hypertension\n'; assert.equal(groupRuns(one).md, one);   // a single lifestyle line is left alone
});

test('stuck consult sweep: only consults older than the limit are closed, with a ready/error choice made in SQL; the call passes the minutes', async () => {
  const seen = [];
  const run = async (sql, args) => { seen.push({ sql, args }); return [{ id: 'C1', status: 'error' }, { id: 'C2', status: 'ready' }]; };
  const done = await sweepStuckConsults({ afterMin: 45, run });
  assert.deepEqual(done, [{ id: 'C1', status: 'error' }, { id: 'C2', status: 'ready' }]);
  assert.deepEqual(seen[0].args, [45]);
  assert.match(seen[0].sql, /status = 'processing'/); assert.match(seen[0].sql, /'ready' ELSE 'error'/); assert.doesNotMatch(seen[0].sql, /DELETE/i);
});
