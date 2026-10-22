import test from 'node:test';
import assert from 'node:assert/strict';
import { joinParts, joinPlanLines, parts } from '../src/orchestrator/planJoin.js';
import { noteToMarkdown } from '../src/orchestrator/renderMarkdown.js';
import { layout } from '../lab/formatMetrics.js';

test('several lines become one, items separated by semicolons, trailing full stops dropped', () => {
  assert.equal(joinParts('Renal ultrasound June 3rd.\nUrine culture.\nPSA ($30 out of pocket).'), 'Renal ultrasound June 3rd; Urine culture; PSA ($30 out of pocket)');
  assert.equal(joinParts('Increase water intake'), 'Increase water intake', 'a single item is untouched');
  assert.equal(joinParts(''), '');
});
test('sentences inside one line are split like the renderer does, abbreviations are not', () => {
  assert.deepEqual(parts('Start the cream twice daily. Review in two weeks.'), ['Start the cream twice daily.', 'Review in two weeks.']);
  assert.deepEqual(parts('Referral to Dr. McLeod for cystoscopy'), ['Referral to Dr. McLeod for cystoscopy']);
});
test('exact repeats are dropped, nothing else is changed or reordered', () => {
  assert.equal(joinParts('Urine culture\nurine culture\nPSA'), 'Urine culture; PSA');
});
test('rendered output shows each label once per problem', () => {
  const note = { subjective: {}, objective: {}, assessment_and_plan: [{ issue: 'Haematuria', diagnosis: '', assessment: '', investigations_planned: 'Renal ultrasound.\nUrine culture.\nPSA.', treatment_planned: 'Increase water intake.\nAntibiotic refill.\nRTC July.', referrals: 'Dr. McLeod for cystoscopy' }] };
  const before = layout(noteToMarkdown(JSON.parse(JSON.stringify(note))));
  assert.equal(before.repeatedLabels, 4);
  assert.equal(joinPlanLines(note), 2);
  const md = noteToMarkdown(note); const after = layout(md);
  assert.equal(after.repeatedLabels, 0); assert.match(md, /Treatment planned: Increase water intake; Antibiotic refill; RTC July/); assert.match(md, /Investigations planned: Renal ultrasound; Urine culture; PSA/);
  assert.equal(after.problems, 1);
});

test('two diagnoses under one problem are joined into one Diagnosis line', () => {
  const dx = ['Iron deficiency anemia', 'Vitamin B12 deficiency'].join('\n');
  const note = { subjective: {}, objective: {}, assessment_and_plan: [{ issue: 'Anemia and B12 deficiency', diagnosis: dx, assessment: '', investigations_planned: '', treatment_planned: 'Iron', referrals: '' }] };
  assert.equal(joinPlanLines(note), 1); const md = noteToMarkdown(note); assert.match(md, /Diagnosis: Iron deficiency anemia; Vitamin B12 deficiency/); assert.equal(layout(md).repeatedLabels, 0);
});
