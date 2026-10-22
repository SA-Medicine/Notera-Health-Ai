import test from 'node:test';
import assert from 'node:assert/strict';
import { readLock } from '../spec/computeLock.mjs';
import { defaultWriterPrompt } from '../src/orchestrator/generateNoteV2.js';
import { SPEC, conformance as checkNote } from '../studio/conformance.js';
import { SPEC_VERSION } from '../src/orchestrator/specLock.js';

test('Style Spec v2 is the locked version and the lock covers the v5 prompt and the v2 code', () => {
  const lock = readLock(); assert.equal(lock.specVersion, '2.0.0'); assert.equal(SPEC_VERSION, '2.0.0'); assert.equal(SPEC.version, '2.0.0');
  for (const f of ['prompts/writer-v5.txt', 'src/orchestrator/planJoin.js', 'src/orchestrator/planSweep.js', 'src/orchestrator/qualityGuards.js', 'src/orchestrator/laterality.js', 'src/orchestrator/adviceLines.js', 'src/orchestrator/writerGuard.js', 'src/orchestrator/topicGroup.js', 'src/orchestrator/groundingAgent.js', 'src/orchestrator/conditionGuard.js']) assert.ok(lock.files[f], `${f} is fingerprinted`);
  assert.ok(!('prompts/writer-v4.txt' in lock.files), 'the archived v4 prompt is no longer the shipped one');
});
test('the shipped writer prompt is writer-v5 (doctor profile rules)', () => { const p = defaultWriterPrompt(); assert.match(p, /Canadian spelling/); assert.match(p, /in the order they were discussed/); assert.match(p, /Allergies: allergen - reaction/); });
test('the v2 rules exist and the note checker enforces the plan-line rules', () => {
  for (const id of ['A8', 'A9', 'A10', 'A11', 'P5', 'G2', 'G3']) assert.ok(SPEC.rules.some((r) => r.id === id), id);
  const good = '### Subjective\n**Presenting Complaint:**\n- Follow-up for anxiety\n\n### Assessment & Plan\n1. **Anxiety**\n   - Diagnosis: Anxiety\n   - Treatment planned: Continue Cipralex 10 mg daily; lorazepam prn\n   - Advice: Increase water intake\n   - Follow-up: 4 weeks';
  const bad = '### Subjective\n**Presenting Complaint:**\n- Follow-up for anxiety\n\n### Assessment & Plan\n1. **Anxiety**\n   - Treatment planned: Continue Cipralex\n   - Treatment planned: Advised to increase water intake; Rtc: 4 weeks';
  const ids = (md) => checkNote(md).failed.map((f) => f.rule);
  assert.deepEqual(ids(good).filter((i) => ['A8', 'A9', 'A10'].includes(i)), []);
  assert.deepEqual(ids(bad).filter((i) => ['A8', 'A9', 'A10'].includes(i)).sort(), ['A10', 'A8', 'A9']);
});
