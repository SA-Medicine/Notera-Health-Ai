import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, layout, aggregate, labelOf, overlap } from '../lab/formatMetrics.js';

const GOLD = `Subjective:\n\nPresenting Complaint:\n\n- Follow-up\n\nObjective:\n\n- BP: 120/70\n\nAssessment & Plan:\n\n1. Haematuria\n- Diagnosis: Haematuria\n- Investigations planned: Renal ultrasound, urine culture\n- Treatment planned: Increase water intake\n- Advised to avoid caffeine\n\n2. Low B12\n- Treatment planned: B12 supplements\n- Follow-up: July\n`;
const OURS = `### Subjective\n**Presenting Complaint:**\n- Follow-up\n\n### Objective\n- BP: 120/70\n\n### Assessment & Plan\n1. **Hematuria and urinary symptoms**\n   - Investigations planned: Renal ultrasound\n   - Investigations planned: Urine culture\n   - Treatment planned: Increase water intake\n   - Treatment planned: B12 supplements\n`;

test('labels are recognised', () => { assert.equal(labelOf('Treatment planned: x'), 'Treatment planned'); assert.equal(labelOf('Advised to avoid caffeine'), 'Counselling'); assert.equal(labelOf('Follow-up: July'), 'Follow-up'); assert.equal(labelOf('Renal ultrasound'), null); });
test('markdown and gold plain layouts parse to the same shape', () => { assert.equal(layout(GOLD).problems, 2); assert.equal(layout(OURS).problems, 1); assert.equal(layout(GOLD).bulletsPerProblem, 3); });
test('repeated labels, missing problems and missing advice/follow-up lines are flagged', () => {
  const r = formatReport(OURS, GOLD);
  assert.equal(r.ours.repeatedLabels, 2); assert.equal(r.gold.repeatedLabels, 0);
  assert.ok(r.missing_gold_problems.some((t) => /B12/.test(t)), 'the separate B12 problem is missing');
  assert.ok(r.flags.some((f) => /repeated label/.test(f))); assert.ok(r.flags.some((f) => /fewer A&P problems/.test(f))); assert.ok(r.flags.some((f) => /follow-up/.test(f)));
  assert.equal(r.gold.counsellingLines, 1); assert.equal(r.ours.counsellingLines, 0);
});
test('a note that matches the gold layout has no flags', () => { const r = formatReport(GOLD, GOLD); assert.deepEqual(r.flags, []); assert.equal(r.missing_gold_problems.length, 0); });
test('spelling variants match (haemorrhoids = hemorrhoids, vitamin B12 = B12)', () => { assert.ok(overlap('Haemorrhoids', 'Hemorrhoids') >= 0.99); assert.ok(overlap('Low B12', 'Vitamin B12 deficiency') >= 0.5); });
test('aggregate gives means and coverage', () => { const a = aggregate([formatReport(OURS, GOLD), formatReport(GOLD, GOLD)]); assert.equal(a.notes, 2); assert.equal(a.notes_with_repeated_labels, 1); assert.ok(a.gold_problem_coverage > 0 && a.gold_problem_coverage < 1); });

test('a sentence that starts with a label word is not a repeated label', () => {
  const md = ['### Assessment & Plan', '1. **Esophageal mass**', '   - Referral to the thoracic team is being arranged', '   - Referrals: Thoracic surgery', '   - Treatment planned: Continue PPI'].join('\n');
  assert.equal(layout(md).repeatedLabels, 0);
  const bad = ['### Assessment & Plan', '1. **X**', '   - Referrals: A', '   - Referrals: B'].join('\n'); assert.equal(layout(bad).repeatedLabels, 1);
});
