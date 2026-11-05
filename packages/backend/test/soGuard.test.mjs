// node --test test/soGuard.test.mjs   (Subjective / Objective guard: pure, deterministic, moves lines and never loses one)
import test from 'node:test';
import assert from 'node:assert/strict';
import { sideOf, findMoves, applyMoves, soGuard } from '../src/orchestrator/soGuard.js';

const NOTE = `### Subjective
**Presenting Complaint:**
- Follow-up for blood pressure and weight
**Blood Pressure:**
- Home blood pressure readings: 131/56, 123/51
- Abdomen: soft, non-tender, non-distended, no hernia on palpation
**Weight:**
- Lost 10 pounds since January

### Objective
**Vital Signs**
- BP 128/76 mmHg, pulse 72
- Did not take blood pressure pill for 18-20 days since returning
- Weight 185 lbs (patient reported)
**Examination**
- Chest clear to auscultation

### Assessment & Plan
1. **Hypertension**
   - Diagnosis: Hypertension
`;
const bullets = (md) => md.split('\n').filter((l) => /^\s*[-•*]\s+\S/.test(l)).map((l) => l.trim()).sort();

test('what the patient said or did goes to Subjective, what the doctor found goes to Objective', () => {
  const { moves, review } = findMoves(NOTE);
  assert.deepEqual(moves.map((m) => m.dir + ' ' + m.line.slice(0, 12)).sort(), ['O->S Did not take', 'O->S Weight 185 l', 'S->O Abdomen: sof'].sort());
  assert.equal(review.length, 0);
  const g = soGuard(NOTE);
  const sub = g.md.split('### Objective')[0], obj = g.md.split('### Objective')[1].split('### Assessment')[0];
  assert.match(sub, /Did not take blood pressure pill/); assert.match(sub, /Weight 185 lbs \(patient reported\)/); assert.doesNotMatch(sub, /Abdomen: soft/);
  assert.match(obj, /Abdomen: soft/); assert.doesNotMatch(obj, /Did not take/); assert.match(obj, /BP 128\/76/);
  assert.deepEqual(bullets(g.md), bullets(NOTE), 'the same lines, only in other sections');
});

test('the moved line lands under the topic it belongs to (the weight reading joins Weight, the pill joins Blood Pressure)', () => {
  const sub = soGuard(NOTE).md.split('### Objective')[0];
  const weight = sub.slice(sub.indexOf('**Weight:**')), bp = sub.slice(sub.indexOf('**Blood Pressure:**'), sub.indexOf('**Weight:**'));
  assert.match(weight, /Weight 185 lbs/); assert.match(bp, /Did not take blood pressure pill/);
});

test('lines that look like the wrong section but are not: nothing moves', () => {
  for (const [line, expect] of [
    ['Home blood pressure readings: 131/56, 123/51', 'patient'],
    ['no swelling', 'neutral'], ['no acute fractures seen', 'clinician'], ['Oral cavity: ulcers improved, granulation tissue present', 'neutral'],
    ['triglycerides 3.5 (high, improved from 3.6)', 'clinician'], ['Magnesium dose reduced from 1000 mg to 500 mg daily', 'neutral'],
    ['Awaiting biopsy results from Dr. Deck on November 20th', 'action'], ['Patient asked what the normal iron level is', 'patient'],
    ['Resolved, follow-up lung CT scan planned in 3 months.', 'neutral'], ['Gait improves after initiating ambulation', 'neutral'],
    ['Clinic weight 2 weeks ago was 140 pounds; today patient was 141 pounds on home scale.', 'patient'],
    ['Worsened with erythema and inflammation by Sunday', 'neutral'], ['Weight loss of 10 pounds since January', 'patient'],
    ['Cystoscopy with biopsy completed', 'neutral'], ['Has not been checking blood pressure at home', 'patient'],
  ]) assert.equal(sideOf(line), expect, line);
  const s = `### Subjective\n- Worsened with erythema and inflammation by Sunday\n- Previously diagnosed with uterine fibroid in 2018\n- Mother had ultrasound showing cysts\n### Objective\n- Chest clear\n`;
  assert.deepEqual(findMoves(s).moves, []);
});

test('the doctor\'s own actions in Subjective are listed for review, never moved', () => {
  const s = `### Subjective\n- Cough for 3 days\n- Asked if she outgrew the blood pressure pill\n- Blood pressure check.\n### Objective\n- Chest clear\n`;
  const { moves, review } = findMoves(s); assert.deepEqual(moves, []); assert.equal(review.length, 2); assert.equal(soGuard(s).md, s);
});

test('a section is never emptied, and a note without the sections is returned untouched', () => {
  const s = `### Subjective\n- Abdomen: soft, non-tender on palpation\n### Objective\n- Did not take the pill for 10 days\n`;
  const { moves } = findMoves(s); assert.equal(moves.length, 0, 'moving the only line would leave a section empty');
  assert.equal(soGuard('just some text').md, 'just some text'); assert.equal(soGuard('').md, '');
});

test('fails closed: if the moved note would not hold the same lines, nothing moves', () => {
  const bad = applyMoves(NOTE, [{ dir: 'O->S', idx: 9999, line: 'invented' }]); assert.equal(bad, NOTE);
});

test('a plan item that landed in Objective is listed for review and never moved', async () => {
  const { findMoves } = await import('../src/orchestrator/soGuard.js');
  const md = '### Subjective\n- Cough for 3 days\n\n### Objective\n- BP 120/80 mmHg\n- Reassess weight and dose in 1 month\n- Rule out ventral hernia\n- Chest clear\n';
  const r = findMoves(md);
  assert.equal(r.moves.length, 0);
  assert.deepEqual(r.review.map((x) => x.line), ['Reassess weight and dose in 1 month', 'Rule out ventral hernia']);
});
