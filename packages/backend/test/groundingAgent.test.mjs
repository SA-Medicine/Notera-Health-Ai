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
  const d2 = decide(parts, parts.map((p, i) => ({ n: i + 1, verdict: 'unclear', why: 'ambiguous' })), TX); assert.equal(d2.remove.length, 0, 'unclear never removes'); assert.equal(d2.flag.length, 0, 'unclear is traced, not flagged');
  const soft = [{ text: 'Improved', key: 'assessment', where: 'plan:x' }, { text: 'Hypothyroidism is present here', key: 'assessment', where: 'plan:x' }];
  const d3 = decide(soft, soft.map((_, i) => ({ n: i + 1, verdict: 'unsupported', why: 'not said' })), TX); assert.equal(d3.remove.length, 0, 'a soft line (no number, no name, not an exam) is flagged at most'); assert.ok(d3.flag.length >= 1);
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

test('a doubtful line whose words are all in the recording is traced, not flagged', () => {
  const n = mk(); n.assessment_and_plan[0].treatment_planned = 'Continue Cipralex 10 mg daily'; const parts = collectParts(n);
  const d = decide(parts, parts.map((p, i) => ({ n: i + 1, verdict: /Cipralex/.test(p.text) ? 'unsupported' : 'supported', why: 'model doubt' })), TX);
  assert.equal(d.flag.length, 0); assert.equal(d.doubtful.length, 1); assert.equal(d.remove.length, 0);
});

import { secondLook, VERIFY_SYS } from '../src/orchestrator/groundingAgent.js';
test('the short answer format works and unlisted lines count as supported', () => {
  assert.equal(parseGround('{"doubtful":[{"n":2,"verdict":"unsupported"}]}').length, 1); assert.equal(parseGround('{"doubtful":[]}').length, 0); assert.equal(parseGround('nope'), null);
  const n = mk(); const parts = collectParts(n); const d = decide(parts, [{ n: 2, verdict: 'unsupported', why: 'x' }], TX); assert.equal(d.kept, parts.length - 1);
});
test('second look: a verified quote rescues the line, a missing or invented quote does not', async () => {
  const tx = 'So you want me to freeze it? Yes please. We froze it today.'; const c = [{ idx: 0, text: 'Cryotherapy performed in clinic' }, { idx: 1, text: 'Biopsy taken' }];
  const llm = { generateContent: async (_s, u) => JSON.stringify(/Cryotherapy/.test(u.split('STATEMENT:')[1]) ? { found: true, quote: 'So you want me to freeze it? Yes please.' } : { found: true, quote: 'a made up sentence that is nowhere in it' }) };
  const r = await secondLook(llm, tx, c); assert.deepEqual(r.rescued.map((x) => x.text), ['Cryotherapy performed in clinic']); assert.deepEqual(r.confirmed.map((x) => x.text), ['Biopsy taken']);
  const bad = await secondLook({ generateContent: async () => { throw new Error('429'); } }, tx, c); assert.equal(bad.confirmed.length, 2, 'if the second look fails the first look stands'); assert.ok(VERIFY_SYS.length > 50);
});
test('the removal cap: when too many lines would go, none are removed and they are flagged', async () => {
  const n = { metadata: {}, subjective: { hpi_details: Array.from({ length: 10 }, (_, i) => `Invented symptom number ${i} xylophone`).join('\n') }, past_medical_history: {}, objective: {}, assessment_and_plan: [] };
  const llm = { generateContent: async (sys) => (sys === VERIFY_SYS ? JSON.stringify({ found: false, quote: '' }) : JSON.stringify({ doubtful: Array.from({ length: 10 }, (_, i) => ({ n: i + 1, verdict: 'unsupported', why: 'no' })) })) };
  const r = await groundNote(llm, n, 'The patient has a cough and fever.'); assert.equal(r.capped, true); assert.equal(r.removed.length, 0); assert.match(n.subjective.hpi_details, /Invented symptom number 3/); assert.equal(n.metadata.flags[0].type, 'check_against_recording');
});

import { hardMissing } from '../src/orchestrator/groundingAgent.js';
test('hard facts: a number or a name that is not in the recording, or an invented exam finding', () => {
  assert.equal(hardMissing({ text: 'Lyrica 75 mg once daily', key: 'treatment_planned' }, 'we talked about Lyrica and gabapentin'), 'number');
  assert.equal(hardMissing({ text: 'Prescribed Horizant at night', key: 'treatment_planned' }, 'we talked about Lyrica'), 'name');
  assert.equal(hardMissing({ text: 'Lungs clear to auscultation bilaterally', key: 'examination' }, 'let us talk about your cough'), 'exam');
  assert.equal(hardMissing({ text: 'Improved', key: 'assessment' }, 'anything'), '');
  assert.equal(hardMissing({ text: 'Continue Lyrica daily', key: 'treatment_planned' }, 'continue the Lyrica daily'), '');
});

test('spoken numbers: decimals, teens and tens, hundreds and digits that run together are not "missing"', () => {
  const TX2 = 'Potassium fifteen hundred milligrams. Your TSH is one point four four. Pressure one ten over sixty. Sodium one forty. Amylase forty nine.';
  for (const l of ['potassium 1500 mg', 'normal TSH at 1.44', 'BP 110/60', 'amylase 49']) assert.equal(hardMissing({ text: l, key: 'x' }, TX2), '', l);
  assert.equal(hardMissing({ text: 'Lyrica 75 mg', key: 'x' }, TX2), 'number');
});
