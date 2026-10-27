import test from 'node:test';
import assert from 'node:assert/strict';
import { negationGuard, noteLines } from '../src/orchestrator/negationGuard.js';
import { applyGroundDelta } from '../src/orchestrator/groundDelta.js';

const TX = 'Doctor: Any fever? Patient: No. Doctor: Any wheezing? Patient: Nope, none. Doctor: Do you take metformin? Patient: I stopped metformin last year. Doctor: Do you want the flu shot? Patient: No thanks, I declined it last year too. Doctor: Chest is clear.';
test('a negated line the recording supports is not flagged; one it does not is flagged, nothing is changed', () => {
  const md = '### Subjective\n- No fever\n- Denies wheezing\n- Denies chest pain\n### Assessment & Plan\n1. **Cough**\n   - Treatment planned: Started: Metformin 500 mg twice daily';
  const r = negationGuard(md, TX); const msgs = r.flags.map((f) => f.message);
  assert.ok(!msgs.some((m) => /No fever|wheezing/.test(m)), 'spoken denials pass'); assert.ok(r.negated >= 2);
  assert.equal(noteLines(md).length, 4);
});
test('a late line that the grounding check removes is found again by its text; a reworded one is flagged instead', () => {
  const note = { metadata: {}, subjective: {}, objective: { examination: 'Abdomen: palpation performed to locate the area of pain\nChest clear' }, past_medical_history: {}, assessment_and_plan: [] };
  const r = applyGroundDelta(note, { checked: 2, remove: ['Abdomen: palpation performed to locate the area of pain', 'A line that is gone'], flag: [] });
  assert.equal(r.removed, 1); assert.equal(note.objective.examination, 'Chest clear'); assert.ok(note.metadata.flags.some((f) => /A line that is gone/.test(f.message) && f.severity === 'warning'));
});
