import test from 'node:test';
import assert from 'node:assert/strict';
import { subjectiveLines, parsePlan, applyPlan, joinText, vetoReason, lowerFirst } from '../src/orchestrator/joinLines.js';

const MD = `### Subjective
- Weight check
- Medication refill
- Weight 190 lb, wants to lose 20 lb
- Itching and mild pain on the chest when dry
- Walking 10-12 miles daily during trip.
- Initially difficult.
- Improved by end of week.
- Temporarily relieved by moisturizing lotion
- Cut out sugary drinks
- No fever
- Denies nausea

### Past Medical History
- Hypertension
`;
const c = subjectiveLines(MD);
const RAW = JSON.stringify({
  topics: [
    { topic: 'Reasons for visit', ids: ['S1', 'S2'] },
    { topic: 'Weight', ids: ['S3', 'S5', 'S6', 'S7', 'S9'] },
    { topic: 'Rash', ids: ['S4', 'S8', 'S10', 'S11'] },
  ],
  join: [['S5', 'S6', 'S7'], ['S4', 'S8']],
});

test('lines are read with ids and only the Subjective', () => {
  assert.equal(c.length, 11); assert.equal(c[0].id, 'S1'); assert.equal(c[10].line, 'Denies nausea');
});
test('the plan puts the lines of one problem together, in their own order, topics in the order they first appear', () => {
  const p = parsePlan(RAW, c);
  assert.deepEqual(p.topics.map((t) => t.ids), [['S1', 'S2'], ['S3', 'S5', 'S6', 'S7', 'S9'], ['S4', 'S8', 'S10', 'S11']]);
  assert.equal(p.moved > 0, true);
  assert.equal(p.joins.length, 2);
  assert.equal(p.joins[0].to, 'Walking 10-12 miles daily during trip; initially difficult; improved by end of week.');
  assert.equal(p.joins[1].to, 'Itching and mild pain on the chest when dry; temporarily relieved by moisturizing lotion');
});
test('applying it: every word survives, one blank line between groups, no gap between two lone lines, the rest of the note is untouched', () => {
  const r = applyPlan(MD, parsePlan(RAW, c));
  assert.equal(r.ok, true); assert.equal(r.applied, 2);
  assert.match(r.md, /### Subjective\n- Weight check\n- Medication refill\n\n- Weight 190 lb, wants to lose 20 lb\n- Walking 10-12 miles daily during trip; initially difficult; improved by end of week\.\n- Cut out sugary drinks\n\n- Itching and mild pain on the chest when dry; temporarily relieved by moisturizing lotion\n- No fever\n- Denies nausea\n\n### Past Medical History\n- Hypertension/);
  const toks = (s) => s.toLowerCase().replace(/[;.,]/g, '').split(/\s+/).filter((w) => w && w !== '-').sort().join(' ');
  assert.equal(toks(r.md), toks(MD));
});
test('the veto: other topic, denial with a finding, dose or label line, label-only first line, size', () => {
  const p = parsePlan(JSON.stringify({ topics: [{ topic: 'a', ids: ['S1', 'S2', 'S3'] }, { topic: 'b', ids: ['S10', 'S11', 'S4'] }], join: [['S3', 'S10'], ['S1', 'S2'], ['S4', 'S10']] }), c);
  assert.ok(p.vetoed.length >= 1);
  assert.equal(vetoReason([{ line: 'Acne', idx: 1, group: 0 }, { line: 'Began two weeks ago', idx: 2, group: 0 }]), 'first line is only a label');
  assert.equal(vetoReason([{ line: 'Cough for 3 days', idx: 1, group: 0 }, { line: 'No fever', idx: 2, group: 0 }]), 'denial with a finding');
  assert.equal(vetoReason([{ line: 'Taking Lexapro 10 mg daily', idx: 1, group: 0 }, { line: 'Feels calmer', idx: 2, group: 0 }]), 'dose or label line');
  assert.equal(vetoReason([{ line: 'Pain on stairs', idx: 1, group: 0 }, { line: 'Worse at night', idx: 2, group: 1 }]), 'different topic');
  assert.equal(lowerFirst('Metformin 500 mg'), 'Metformin 500 mg'); assert.equal(lowerFirst('CT scan normal'), 'CT scan normal');
  assert.equal(lowerFirst('Appeared two weeks ago'), 'appeared two weeks ago'); assert.equal(joinText([{ line: 'No fever.' }, { line: 'Denies nausea' }]), 'No fever; denies nausea');
});
test('a forgotten line stays with the line before it, a bad answer changes nothing', () => {
  const p = parsePlan(JSON.stringify({ topics: [{ topic: 'a', ids: ['S1', 'S2'] }, { topic: 'b', ids: ['S3', 'S4', 'S9'] }], join: [] }), c);
  assert.equal(p.topics.flatMap((t) => t.ids).length, 11);
  assert.equal(parsePlan('not json', c), null); assert.equal(parsePlan('{"topics":[]}', c), null);
  assert.equal(applyPlan(MD, null).md, MD);
});
test('it finds the lines by text after earlier steps changed the note, and fails closed on a surprise', () => {
  const p = parsePlan(RAW, c);
  const dropped = MD.replace('- Cut out sugary drinks\n', '').replace('- Initially difficult.\n', '');
  const r = applyPlan(dropped, p);
  assert.equal(r.ok, true); assert.doesNotMatch(r.md, /sugary/);   // a join whose lines are no longer neighbours is skipped, the line that is gone stays gone
  const toks = (s) => s.toLowerCase().replace(/[;.,]/g, '').split(/\s+/).filter((w) => w && w !== '-').sort().join(' ');
  assert.equal(toks(r.md), toks(dropped));
  const odd = MD.replace('- Weight check', 'Some paragraph that is not a bullet');
  assert.equal(applyPlan(odd, p).md, odd);
  const added = MD.replace('- No fever\n', '- No fever\n- A line the plan never saw\n');
  assert.match(applyPlan(added, p).md, /No fever\n- A line the plan never saw\n- Denies nausea/);
});
