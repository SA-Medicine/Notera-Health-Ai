import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeNote } from '../src/orchestrator/dedupeNote.js';
import { tidyPlan } from '../src/orchestrator/postGuards.js';
import { condenseNote } from '../src/orchestrator/condenseNote.js';

const note = () => ({ metadata: {}, subjective: { reason_for_visit: 'Medication review', hpi_details: 'Takes Tylenol 1 to 2 tablets every 4 hours for hip pain\nTakes Tylenol 1 to 2 tablets every 4 hours for hip pain', symptom_progression: 'Takes Naproxen but it does little' }, past_medical_history: {}, objective: {}, assessment_and_plan: [] });

test('free flow: only an identical Subjective line is dropped; a paraphrase stays', () => {
  const n = note(); const logs = []; dedupeNote(n, { log: (l) => logs.push(l), freeFlow: true });
  assert.equal(n.subjective.hpi_details.split('\n').length, 1, 'the identical line is removed once'); assert.match(n.subjective.symptom_progression, /Naproxen/);
  assert.ok(logs.some((l) => /identical Subjective line/.test(l)));
});
test('free flow: plan items are dropped only when identical; a similar item with another drug stays', () => {
  const n = { assessment_and_plan: [{ issue: 'Pain', treatment_planned: 'Start Lyrica 75 mg twice daily; Start Lyrica 75 mg twice daily; Start Lyrica 150 mg twice daily' }] };
  tidyPlan(n, () => {}, { exact: true }); assert.equal(n.assessment_and_plan[0].treatment_planned, 'Start Lyrica 75 mg twice daily; Start Lyrica 150 mg twice daily');
});
test('free flow: the condenser keeps plan lines that read like the history above', () => {
  const mk = () => ({ subjective: { hpi_details: 'Wants a prescription for a knee brace for the other knee' }, past_medical_history: {}, objective: {}, assessment_and_plan: [{ issue: 'Knee', treatment_planned: 'Prescription for a knee brace for the other knee' }] });
  const a = mk(); condenseNote(a, { freeFlow: true }); assert.match(a.assessment_and_plan[0].treatment_planned, /knee brace/);
});
