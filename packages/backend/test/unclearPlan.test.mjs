import test from 'node:test';
import assert from 'node:assert/strict';
import { unclearPlan, whyUnclear, planLines } from '../src/orchestrator/unclearPlan.js';

test('the lines from the owner review are flagged', () => {
  for (const l of ["For the or once a day and you're taking at bedtime and you avoid the sets", 'Can you suck on the ice cubes?', 'x-rays of the the', 'Outpatient colonoscopy follow-up with', 'Let me check your pancreas just in case']) assert.ok(whyUnclear(l), l);
});
test('normal plan lines are not flagged', () => {
  for (const l of ['Continue Metformin 500 mg twice daily', 'Increase your water intake to 2 litres daily', 'Avoid NSAIDs and eating at bedtime', 'That Mounjaro is preferred over Wegovy', 'Other: Repeat bloodwork in 3 months', 'If patient wants to get pregnant, she should start thinking about it', 'Referral to Dr. Kova', 'Follow-up in a week or so', 'Monitor for signs of hernia strangulation']) assert.equal(whyUnclear(l), '', l);
});
test('only plan lines are read, a follow-up item is skipped, flags only and capped', () => {
  const md = '### Subjective\n- Can you hear me?\n\n### Assessment & Plan\n1. **Reflux**\n   - Can you take it at night?\n   - Prilosec 20 mg daily\n2. **Follow-up**\n   - And then\n';
  assert.equal(planLines(md).length, 3);
  const u = unclearPlan(md); assert.equal(u.flags.length, 1); assert.equal(u.flags[0].type, 'plan_unclear'); assert.match(u.flags[0].message, /Reflux/);
});

test('spoken lines from the doctor are flagged too', () => {
  for (const l of ['beautiful blood pressure 120 over 80. That is perfect.', 'I would stay the same', "I'd like to see you in a month"]) assert.ok(whyUnclear(l), l);
  assert.equal(whyUnclear('Continue current dose of Ramipril'), '');
});
