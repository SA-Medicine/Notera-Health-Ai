import test from 'node:test';
import assert from 'node:assert/strict';
import { planTidy } from '../src/orchestrator/planTidy.js';
import { parseMoves, applyMoves, candidates, planBlocks } from '../src/orchestrator/planOrganise.js';

const MD = `### Subjective
- increased appetite.
- Cough for 3 days. Worse at night.

### Assessment & Plan
1. **Weight management.**
   - increased appetite
   - Arrange blood test
   - arrange blood test.
   - Continue Wegovy 1 mg weekly
2. **Insomnia**
   - Return if no sleep for a week.
   - Continue Sleeping medication faxed to Rexall.
   - Follow up in 2 weeks
   - Arrange Blood pressure check
   - Differential diagnoses: Contact dermatitis
`;

test('plan tidy: title full stop, capitals, plain words lower-cased, repeats, warning lines last, one ending for every bullet', () => {
  const r = planTidy(MD);
  assert.equal(r.titles, 1); assert.equal(r.dupes, 1);
  assert.match(r.md, /- increased appetite\n- Cough for 3 days\. Worse at night\.\n\n### Assessment/);   // Subjective: one-sentence full stop removed, a two-sentence line untouched
  assert.match(r.md, /1\. \*\*Weight management\*\*\n   - Increased appetite\n   - Arrange blood test\n   - Continue Wegovy 1 mg weekly\n2\. \*\*Insomnia\*\*\n   - Continue sleeping medication faxed to Rexall\n   - Arrange blood pressure check\n   - Differential diagnoses: Contact dermatitis\n   - Return if no sleep for a week\n   - Follow up in 2 weeks\n$/);
  assert.equal(planTidy('### Subjective\n- a\n').md, '### Subjective\n- a\n');
  const toks = (s) => s.toLowerCase().replace(/[;.,]/g, '').split(/\s+/).filter((w) => w && w !== '-' && !/^\*|^\d+$/.test(w)).sort().join(' ');
  assert.equal(toks(planTidy(MD.replace(/\n   - arrange blood test\./, '')).md), toks(MD.replace(/\n   - arrange blood test\./, '')));
});

test('plan tidy: Objective gets capitals and a glued second finding on its own bullet, words kept', () => {
  const md = '### Objective\n- hemoglobin: fine\n- LDL 2.5 mmol/L (increased from 2.2). Abdominal wall ultrasound: hernias, largest 9.2 cm\n- BP 120/80 mmHg (clinic). Weight 185 lbs\n';
  const r = planTidy(md);
  assert.equal(r.md, '### Objective\n- Hemoglobin: fine\n- LDL 2.5 mmol/L (increased from 2.2).\n- Abdominal wall ultrasound: hernias, largest 9.2 cm\n- BP 120/80 mmHg (clinic). Weight 185 lbs\n');
  assert.equal(r.splitO, 1);
});

const PLAN = `### Assessment & Plan
1. **Hypertension**
   - Blood pressure well controlled
2. **Cholesterol**
   - LDL slightly high
   - Lifestyle measures
3. **Investigations**
   - Arrange blood pressure check
4. **Follow-up**
   - See in 1 month
`;
test('plan organiser: the model names the problem, code moves the line, a generic problem left empty is dropped and the rest renumbered, vetoes hold', () => {
  const c = candidates(PLAN); assert.equal(c.length, 4);
  const id = c[2].items[0].id;
  const p = parseMoves(JSON.stringify({ moves: [{ line: id, to: 1 }, { line: 'L99', to: 1 }, { line: c[0].items[0].id, to: 3 }, { line: c[3].items[0].id, to: 1 }, { line: c[1].items[0].id, to: 2 }] }), c);
  assert.equal(p.moves.length, 1); assert.equal(p.vetoed.length, 4);   // unknown line, generic target, follow-up, same problem
  const r = applyMoves(PLAN, p);
  assert.equal(r.moved, 1); assert.deepEqual(r.dropped, ['Investigations']);
  assert.match(r.md, /1\. \*\*Hypertension\*\*\n   - Blood pressure well controlled\n   - Arrange blood pressure check\n2\. \*\*Cholesterol\*\*\n   - LDL slightly high\n   - Lifestyle measures\n3\. \*\*Follow-up\*\*\n   - See in 1 month\n/);
  assert.equal(applyMoves(PLAN, null).md, PLAN);
  assert.equal(planBlocks('### Assessment & Plan\nSome free paragraph\n'), null);   // anything unexpected -> untouched
  // a specific problem never loses its only line
  const only = parseMoves(JSON.stringify({ moves: [{ line: c[0].items[0].id, to: 2 }] }), c); assert.equal(only.moves.length, 0);
});

test('plan organiser: a line leaving a specific problem needs a shared word with its new problem', () => {
  const md = '### Assessment & Plan\n1. **Head injury**\n   - Ice packs\n   - See an optometrist for the watery eye\n2. **Dog bite**\n   - Wound healing\n   - Clean daily\n3. **Follow-up**\n   - 1 month\n';
  const c = candidates(md);
  assert.equal(parseMoves(JSON.stringify({ moves: [{ line: c[0].items[1].id, to: 2 }] }), c).moves.length, 0);
});

test('plan tidy: the writer\'s own "(Note: ...)" remark is removed from a bullet', () => {
  const r = planTidy('### Past Medical History\n- Bowel burst in 2012 (9 surgeries total). (Note: concise synthesis of reported history)\n- Fine (note the dose)\n');
  assert.equal(r.md, '### Past Medical History\n- Bowel burst in 2012 (9 surgeries total)\n- Fine (note the dose)\n'); assert.equal(r.notes, 1);
});
