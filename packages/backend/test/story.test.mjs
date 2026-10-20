import test from 'node:test';
import assert from 'node:assert/strict';
import { storyPass } from '../src/orchestrator/generateNoteV2.js';
import { noteToMarkdown } from '../src/orchestrator/renderMarkdown.js';

const transcript = 'Patient has left knee pain for 3 weeks, worse on stairs. Denies fever. Taking naproxen 500 mg twice daily. Lives with her husband. Takes ramipril 5 mg daily for blood pressure.';
const mkNote = () => ({
  subjective: { reason_for_visit: 'Left knee pain', hpi_details: 'Pain\nLeft knee\n3 weeks', aggravating_relieving_factors: 'Worse on stairs\nNaproxen 500 mg twice daily', symptom_progression: '', previous_episodes: '', functional_impact: '', associated_symptoms: 'Denies fever' },
  past_medical_history: { social: 'Lives with husband', other: 'Medications: ramipril 5 mg daily' }, objective: {}, assessment_and_plan: [], metadata: {},
});
const llm = (o) => ({ generateContent: async () => JSON.stringify(o) });
const good = {
  subjective: { reason_for_visit: 'Presenting Complaint:\n- Left knee pain for 3 weeks', hpi_details: 'Knee Pain:\n- Pain in the left knee for 3 weeks, worse on stairs\n- Taking naproxen 500 mg twice daily\n- Denies fever', aggravating_relieving_factors: '', symptom_progression: '', previous_episodes: '', functional_impact: '', associated_symptoms: '' },
  past_medical_history: { social: 'Lives with her husband', other: 'Medications: ramipril 5 mg daily' },
};

test('storyPass applies topic headings + bullets (headings are not counted as new words)', async () => {
  const r = await storyPass(llm(good), mkNote(), transcript, () => {}, {});
  assert.ok(r.out, 'applied: ' + r.why);
});
test('storyPass rejects a changed dose, lost facts and LLM errors', async () => {
  const bad = { ...good, subjective: { ...good.subjective, hpi_details: 'Knee Pain:\n- Pain in the left knee for 3 weeks, worse on stairs\n- Taking naproxen 750 mg twice daily\n- Denies fever' } };
  assert.equal((await storyPass(llm(bad), mkNote(), transcript, () => {}, {})).out, null, 'changed dose');
  const lost = { ...good, subjective: { ...good.subjective, hpi_details: 'Knee Pain:\n- Knee pain' } };
  assert.equal((await storyPass(llm(lost), mkNote(), transcript, () => {}, {})).out, null, 'dropped facts');
  assert.equal((await storyPass({ generateContent: async () => { throw new Error('boom'); } }, mkNote(), transcript, () => {}, {})).out, null, 'LLM error keeps the draft');
});
test('topics render as bold headings with bullets; without the story agent nothing changes', () => {
  const md = noteToMarkdown({ ...mkNote(), subjective: good.subjective, metadata: { subjective_style: 'topics' } });
  assert.ok(md.includes('**Presenting Complaint:**\n- Left knee pain for 3 weeks\n\n**Knee Pain:**\n- Pain in the left knee'), md);
  const plain = noteToMarkdown(mkNote());
  assert.ok(/^- Left knee pain/m.test(plain), 'plain Subjective unchanged');
});
