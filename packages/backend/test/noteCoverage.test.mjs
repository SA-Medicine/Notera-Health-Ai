import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptCoverage, addSubjective, applyCoverage, coverNote } from '../src/orchestrator/noteCoverage.js';
import { noteToMarkdown } from '../src/orchestrator/renderMarkdown.js';

const TX = 'I take one or two Tylenol every four hours and sometimes at night too. Naproxen helps very little. The pain started last winter and I have no numbness today. Take the Lyrica with the Tylenol, that is fine. I had an x-ray two years ago that showed arthritis. Fax the prescription to the pharmacy at Wyandotte and Dawson.';
const note = () => ({
  metadata: { subjective_style: 'topics' },
  subjective: { reason_for_visit: 'Presenting Complaint:\n- Left hip pain', hpi_details: 'Left Hip Pain:\n- Present since last winter\nSleep:\n- Trazodone not effective' },
  past_medical_history: { medical_surgical: 'Recurrent shingles' },
  objective: { examination: 'Standing exam: pain localised to hip' },
  assessment_and_plan: [{ issue: 'Left hip pain', diagnosis: '', assessment: '', investigations_planned: '', treatment_planned: 'Start Lyrica 1 tablet twice daily', referrals: '' }],
});
const it = (o) => ({ section: 'subjective', topic: 'Left Hip Pain', text: 'Takes Tylenol at night as well, 1 to 2 every 4 hours', evidence: 'I take one or two Tylenol every four hours and sometimes at night too', ...o });

test('a missing fact with a real quote goes under its topic heading, not at the end', () => {
  const n = note(); addSubjective(n, 'Left Hip Pain', 'naproxen helps very little');
  assert.match(n.subjective.hpi_details, /Left Hip Pain:\n- Present since last winter\n- Naproxen helps very little\nSleep:/);
  const t = note(); addSubjective(t, 'Medication Use', 'takes Tylenol at night'); assert.match(t.subjective.hpi_details, /Sleep:\n- Trazodone not effective\nMedication Use:\n- Takes Tylenol at night$/);
});
test('items without a quote, repeats of what the note already says, unknown sections and the limit are dropped', () => {
  const why = (o) => acceptCoverage([o], note(), TX).dropped[0]?.why;
  assert.match(why(it({ evidence: 'the patient also has a long history of migraine headaches' })), /quote/);
  assert.match(why(it({ text: 'Present since last winter', evidence: 'The pain started last winter and I have no numbness today' })), /already/);
  assert.match(why(it({ section: 'diagnosis' })), /section/); assert.match(why(it({ text: 'x' })), /empty/);
  const many = Array.from({ length: 20 }, (_, i) => it({ text: `Fact number ${i} about naproxen use`, evidence: 'Naproxen helps very little' }));
  assert.ok(acceptCoverage(many, note(), TX).subj.length <= 12);
});
test('history, objective and plan facts are added to their own sections; plan items use the plan-completeness checks', () => {
  const n = note();
  const out = applyCoverage(n, { raw: JSON.stringify({ items: [
    it({ section: 'history', text: 'X-ray two years ago showed arthritis', evidence: 'I had an x-ray two years ago that showed arthritis' }),
    it({ section: 'plan', n: 1, field: 'advice', text: 'Lyrica can be taken with Tylenol', evidence: 'Take the Lyrica with the Tylenol, that is fine' }),
    it({ section: 'plan', n: 1, field: 'treatment', text: 'Start Lyrica 1 tablet twice daily', evidence: 'Take the Lyrica with the Tylenol, that is fine' }),
  ] }) }, TX);
  assert.match(n.past_medical_history.medical_surgical, /Recurrent shingles\nX-ray two years ago showed arthritis/);
  assert.match(n.assessment_and_plan[0].treatment_planned, /Advised lyrica can be taken with tylenol/i); assert.equal(out.plan, 1, 'the repeated treatment is not added twice');
  assert.match(noteToMarkdown(n), /X-ray two years ago showed arthritis/);
});
test('coverNote asks once, shows the model the note and the numbered plan, and never throws when the model fails', async () => {
  const asked = []; const llm = { generateContent: async (s, u) => { asked.push(u); return JSON.stringify({ items: [it()] }); } };
  const n = note(); const r = await coverNote(llm, n, TX);
  assert.equal(asked.length, 1); assert.match(asked[0], /NOTE:\n### Subjective/); assert.match(asked[0], /1\. Left hip pain/); assert.equal(r.added, 1);
  const bad = await coverNote({ generateContent: async () => { throw new Error('quota'); } }, note(), TX); assert.equal(bad.added, 0); assert.match(bad.error, /quota/);
});
