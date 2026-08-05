// Tests for the gold tightener's parsing/mapping (LLM mocked). Run: node .../tightenNote.test.mjs
import { tightenNote, _buildNote, _safeParse } from './tightenNote.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.error('  ✗', n); } };

const draft = {
  schema_version: '2.0.0', note_type: 'consultation', specialty: 'general_primary_care',
  subjective: { reason_for_visit: 'Blood work review', hpi_details: '', aggravating_relieving_factors: '', symptom_progression: '', previous_episodes: '', functional_impact: '', associated_symptoms: '' },
  past_medical_history: { medical_surgical: 'Hypertension', social: '', family: '', exposure: '', immunisation: '', other: '' },
  objective: { vital_signs: 'BP 127/71', examination: '', completed_investigations: 'HbA1c 6.4%' },
  assessment_and_plan: [{ issue: 'Hyperkalaemia', diagnosis: '', assessment: 'Potassium elevated.', differential_diagnoses: [], investigations_planned: '', treatment_planned: 'Stop olmesartan', referrals: '' }],
  metadata: { flags: [], confidence: {} },
};

console.log('tightenNote · mapping (mock LLM returns corrected JSON)');
{
  const goldJson = {
    subjective: { reason_for_visit: 'Phone call to review blood results', hpi_details: 'Potassium elevated on labs' },
    past_medical_history: { medical_surgical: 'Hypertension - previously on candesartan then olmesartan' },
    objective: { completed_investigations: 'HbA1c 6.4% (borderline)\nPotassium 5.6 (elevated)\nB12 normal\nCholesterol normal' },
    assessment_and_plan: [{ issue: 'Hyperkalaemia', diagnosis: 'Elevated potassium secondary to olmesartan', treatment_planned: 'Stop olmesartan; start amlodipine 1 tab daily; prescription to Costco', investigations_planned: 'Repeat potassium in 2 weeks', referrals: '' }],
  };
  const llm = { generateContent: async () => '```json\n' + JSON.stringify(goldJson) + '\n```' };
  const out = await tightenNote(draft, { llm, transcript: 'she is on olmesartan, start amlodipine, send to Costco, repeat potassium in 2 weeks' });
  ok('recovers the missed amlodipine + Costco plan', /amlodipine 1 tab daily/.test(out.assessment_and_plan[0].treatment_planned) && /Costco/.test(out.assessment_and_plan[0].treatment_planned));
  ok('recovers normal labs', /B12 normal/.test(out.objective.completed_investigations) && /Cholesterol normal/.test(out.objective.completed_investigations));
  ok('preserves schema shape + metadata', out.schema_version === '2.0.0' && out.metadata === draft.metadata && Array.isArray(out.assessment_and_plan));
}

console.log('tightenNote · robustness (fallback to draft)');
{
  const llm = { generateContent: async () => 'sorry I cannot do that' };   // non-JSON
  const out = await tightenNote(draft, { llm, transcript: 'x' });
  ok('falls back to the draft on non-JSON', out === draft);
}
{
  const llm = { generateContent: async () => { throw new Error('429 rate limit'); } };
  const out = await tightenNote(draft, { llm, transcript: 'x' });
  ok('falls back to the draft on LLM error', out === draft);
}
{
  const llm = { generateContent: async () => '{"subjective":{},"assessment_and_plan":[]}' };  // hollow
  const out = await tightenNote(draft, { llm, transcript: 'x' });
  ok('keeps the draft if the result is empty', out === draft);
}

console.log('tightenNote · truncated JSON repair');
{
  const truncated = '{"subjective":{"reason_for_visit":"review"},"assessment_and_plan":[{"issue":"HTN","treatment_planned":"amlodipine';
  const p = _safeParse(truncated);
  ok('repairs a truncated JSON object', p && p.subjective.reason_for_visit === 'review');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
