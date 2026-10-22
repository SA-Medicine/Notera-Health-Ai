import test from 'node:test';
import assert from 'node:assert/strict';
import { collectParts, decide, applyRemovals, wordSupport, groundNote, parseGround } from '../src/orchestrator/groundingAgent.js';

const TX = 'Your A1C is five point nine, better than last time. We continue Cipralex ten milligrams daily. The ultrasound is on June third. We gave you the tetanus shot at the last visit.';
const mk = () => ({ metadata: {}, subjective: { hpi_details: 'Cough for 2 weeks\nTook Dexilant daily' }, past_medical_history: {}, objective: { completed_investigations: 'A1C 5.9%' },
  assessment_and_plan: [{ issue: 'Mood', assessment: '', treatment_planned: 'Continue Cipralex 10 mg daily; start Dexilant 60 mg daily', investigations_planned: 'Ultrasound June 3rd', referrals: '' }] });

test('key words: numbers count, spoken numbers match', () => {
  assert.ok(wordSupport('A1C 5.9%', TX) >= 0.99); assert.ok(wordSupport('Cipralex 10 mg daily', TX) >= 0.6); assert.ok(wordSupport('start Dexilant 60 mg daily', TX) < 0.5);
});
test('parts are the note lines; plan fields are split on semicolons; headings and the Medications line are skipped', () => {
  const n = mk(); n.subjective.hpi_details = 'Cough:\nCough for 2 weeks'; n.past_medical_history.other = 'Medications: Cipralex 10 mg';
  const t = collectParts(n).map((p) => p.text); assert.ok(t.includes('Cough for 2 weeks') && t.includes('start Dexilant 60 mg daily') && !t.includes('Cough:') && !t.some((x) => x.startsWith('Medications')));
});
test('only unsupported lines whose words are missing are removed; doubtful ones are flagged; supported are kept', () => {
  const n = mk(); const parts = collectParts(n);
  const verdicts = parts.map((p, i) => ({ n: i + 1, verdict: /Dexilant/.test(p.text) ? 'unsupported' : /tetanus/.test(p.text) ? 'unclear' : 'supported', why: 'not said' }));
  const d = decide(parts, verdicts, TX); assert.equal(d.remove.length, 2, 'both Dexilant lines'); assert.equal(d.flag.length, 0);
  const d2 = decide(parts, parts.map((p, i) => ({ n: i + 1, verdict: 'unclear', why: 'ambiguous' })), TX); assert.ok(d2.flag.length > 0);
});
test('removal edits the note field by whole parts and keeps the rest', () => {
  const n = mk(); const parts = collectParts(n); const d = decide(parts, parts.map((p, i) => ({ n: i + 1, verdict: /Dexilant/.test(p.text) ? 'unsupported' : 'supported' })), TX);
  assert.equal(applyRemovals(parts, d.remove), 2); assert.equal(n.assessment_and_plan[0].treatment_planned, 'Continue Cipralex 10 mg daily'); assert.equal(n.subjective.hpi_details, 'Cough for 2 weeks');
});
test('the stage writes flags, never throws on bad model output, and leaves the note alone then', async () => {
  const n = mk(); const llm = { generateContent: async () => JSON.stringify({ lines: collectParts(n).map((p, i) => ({ n: i + 1, verdict: /Dexilant/.test(p.text) ? 'unsupported' : 'supported', why: 'drug not said' })) }) };
  const r = await groundNote(llm, n, TX); assert.equal(r.removed.length, 2); assert.equal(n.metadata.flags[0].type, 'removed_unsupported');
  const m = mk(); const before = JSON.stringify(m); const r2 = await groundNote({ generateContent: async () => 'oops' }, m, TX); assert.equal(JSON.stringify(m), before); assert.equal(r2.error, 'unparseable');
  assert.deepEqual(parseGround('{"lines":[{"n":1,"verdict":"supported"}]}').length, 1);
});
