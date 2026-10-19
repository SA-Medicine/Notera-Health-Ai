import test from 'node:test';
import assert from 'node:assert/strict';
import { storyPass } from '../src/orchestrator/generateNoteV2.js';
import { noteToMarkdown } from '../src/orchestrator/renderMarkdown.js';

const transcript = 'Patient has left knee pain for 3 weeks, worse on stairs. Denies fever. Taking naproxen 500 mg twice daily. Lives with her husband.';
const mkNote = () => ({
  subjective: { reason_for_visit: 'Left knee pain', hpi_details: 'Pain\nLeft knee\n3 weeks', aggravating_relieving_factors: 'Worse on stairs\nNaproxen 500 mg twice daily', symptom_progression: '', previous_episodes: '', functional_impact: '', associated_symptoms: 'Denies fever' },
  past_medical_history: { social: 'Lives with husband' }, objective: {}, assessment_and_plan: [], metadata: {},
});
const llm = (o) => ({ generateContent: async () => JSON.stringify(o) });
const good = {
  subjective: { reason_for_visit: 'Presents with left knee pain for 3 weeks.', hpi_details: 'The pain has been present for 3 weeks and is worse on stairs. She takes naproxen 500 mg twice daily.', aggravating_relieving_factors: '', symptom_progression: '', previous_episodes: '', functional_impact: '', associated_symptoms: 'She denies fever.' },
  past_medical_history: { social: 'Lives with her husband.' },
};

test('storyPass applies a faithful narrative', async () => {
  const r = await storyPass(llm(good), mkNote(), transcript, () => {}, {});
  assert.ok(r.out, 'applied: ' + r.why);
});
test('storyPass rejects a changed dose, lost facts and LLM errors', async () => {
  const bad = { ...good, subjective: { ...good.subjective, hpi_details: 'The pain has been present for 3 weeks and is worse on stairs. She takes naproxen 750 mg twice daily.' } };
  assert.equal((await storyPass(llm(bad), mkNote(), transcript, () => {}, {})).out, null, 'changed dose');
  const lost = { ...good, subjective: { ...good.subjective, hpi_details: 'Knee pain.' } };
  assert.equal((await storyPass(llm(lost), mkNote(), transcript, () => {}, {})).out, null, 'dropped facts');
  assert.equal((await storyPass({ generateContent: async () => { throw new Error('boom'); } }, mkNote(), transcript, () => {}, {})).out, null, 'LLM error keeps the draft');
});
test('a narrative Subjective renders as paragraphs, not bullets', () => {
  const md = noteToMarkdown({ ...mkNote(), subjective: good.subjective, metadata: { subjective_style: 'narrative' } });
  assert.ok(md.includes('Presents with left knee pain for 3 weeks.\n\nThe pain has been present'), md);
  assert.ok(!/^- Presents/m.test(md));
  const plain = noteToMarkdown(mkNote());
  assert.ok(/^- Left knee pain/m.test(plain), 'without the story agent the Subjective is unchanged');
});
