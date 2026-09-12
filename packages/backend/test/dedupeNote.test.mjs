// The final no-duplicates pass. Covers the reported bug (long transcripts restate the
// same Assessment point in different words) and the safety properties that keep it from
// deleting clinical information.
import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeNote } from '../src/orchestrator/dedupeNote.js';
import { semanticDedupeNote } from '../src/orchestrator/semanticDedupe.js';

const issue = (o = {}) => ({
  issue: '', diagnosis: '', assessment: '', differential_diagnoses: [],
  investigations_planned: '', treatment_planned: '', referrals: '', ...o,
});

const note = (o = {}) => ({
  subjective: { reason_for_visit: '', hpi_details: '', aggravating_relieving_factors: '', symptom_progression: '', previous_episodes: '', functional_impact: '', associated_symptoms: '' },
  past_medical_history: { medical_surgical: '', social: '', family: '', exposure: '', immunisation: '', other: '' },
  objective: { vital_signs: '', examination: '', completed_investigations: '' },
  assessment_and_plan: [],
  metadata: { flags: [] },
  ...o,
});

test('two A&P entries for one condition are merged, keeping both plans', () => {
  const n = note({
    assessment_and_plan: [
      issue({ issue: 'Hypertension', diagnosis: 'Essential hypertension', investigations_planned: 'Repeat BP in 2 weeks.' }),
      issue({ issue: 'Elevated blood pressure', investigations_planned: 'Renal function and electrolytes.' }),
    ],
  });
  dedupeNote(n);
  assert.equal(n.assessment_and_plan.length, 1);
  // The surviving entry keeps the proper diagnosis as its heading, not the reworded one.
  assert.equal(n.assessment_and_plan[0].issue, 'Hypertension');
  assert.match(n.assessment_and_plan[0].investigations_planned, /Repeat BP in 2 weeks/);
  assert.match(n.assessment_and_plan[0].investigations_planned, /Renal function/);
});

test('a merge retitles to the strictly more specific diagnosis', () => {
  const n = note({
    assessment_and_plan: [
      issue({ issue: 'Anaemia', assessment: 'Not responding to oral iron.' }),
      issue({ issue: 'Iron deficiency anaemia', treatment_planned: 'Switch to IV iron.' }),
    ],
  });
  dedupeNote(n);
  assert.equal(n.assessment_and_plan.length, 1);
  assert.equal(n.assessment_and_plan[0].issue, 'Iron deficiency anaemia');
});

test('genuinely different problems are never merged', () => {
  const n = note({
    assessment_and_plan: [
      issue({ issue: 'Left knee pain', assessment: 'Likely osteoarthritis.', treatment_planned: 'Paracetamol as needed.' }),
      issue({ issue: 'Right knee pain', assessment: 'Likely osteoarthritis.', treatment_planned: 'Paracetamol as needed.' }),
      issue({ issue: 'Type 1 diabetes mellitus', assessment: 'Stable.' }),
      issue({ issue: 'Type 2 diabetes mellitus', assessment: 'Stable.' }),
    ],
  });
  dedupeNote(n);
  assert.equal(n.assessment_and_plan.length, 4);
  // Identical lines under DIFFERENT problems must survive — they are separate findings,
  // and dropping them would leave a bare numbered heading.
  for (const p of n.assessment_and_plan) assert.ok(p.assessment.trim(), `"${p.issue}" lost its assessment`);
});

test('a point repeated under the same problem is removed once', () => {
  const n = note({
    assessment_and_plan: [
      issue({
        issue: 'Hypertension',
        assessment: 'BP remains above target on current therapy.\nBP remains above target on current therapy.',
        treatment_planned: 'Increase amlodipine to 10 mg daily.\nIncrease amlodipine to 10mg daily.',
      }),
    ],
  });
  dedupeNote(n);
  const p = n.assessment_and_plan[0];
  assert.equal(p.assessment.split('\n').length, 1);
  assert.equal(p.treatment_planned.split('\n').length, 1);
});

test('a plan action echoed in the assessment stays only in the plan', () => {
  const n = note({
    assessment_and_plan: [
      issue({
        issue: 'Hypertension',
        assessment: 'Increase amlodipine to 10 mg daily.',
        treatment_planned: 'Increase amlodipine to 10 mg daily.',
      }),
    ],
  });
  dedupeNote(n);
  const p = n.assessment_and_plan[0];
  assert.equal(p.assessment.trim(), '');
  assert.match(p.treatment_planned, /Increase amlodipine/);
});

test('a follow-up repeated under every problem collapses to one', () => {
  const n = note({
    assessment_and_plan: [
      issue({ issue: 'Hypertension', assessment: 'At target.', treatment_planned: 'Continue ramipril.\nRTC in 2 weeks.' }),
      issue({ issue: 'Hyperlipidaemia', assessment: 'Lipids improved.', treatment_planned: 'Continue atorvastatin.\nReturn to clinic in 2 weeks.' }),
      issue({ issue: 'Insomnia', assessment: 'Sleep hygiene discussed.', treatment_planned: 'Advise sleep hygiene.\nRTC in 2 weeks.' }),
    ],
  });
  dedupeNote(n);
  const mentions = n.assessment_and_plan.filter((p) => /2 weeks/.test(p.treatment_planned)).length;
  assert.equal(mentions, 1);
  // Each problem keeps its own distinct treatment.
  assert.match(n.assessment_and_plan[0].treatment_planned, /ramipril/);
  assert.match(n.assessment_and_plan[1].treatment_planned, /atorvastatin/);
  assert.match(n.assessment_and_plan[2].treatment_planned, /sleep hygiene/i);
});

test('the Assessment does not retell Subjective detail, but keeps plan actions', () => {
  const n = note({
    subjective: { reason_for_visit: '', hpi_details: 'Headaches for three weeks, worse in the mornings.', aggravating_relieving_factors: '', symptom_progression: '', previous_episodes: '', functional_impact: '', associated_symptoms: '' },
    assessment_and_plan: [
      issue({
        issue: 'Tension headache',
        assessment: 'Headaches for three weeks, worse in the mornings.\nConsistent with tension-type headache.',
        treatment_planned: 'Continue amitriptyline 10 mg at night.',
      }),
    ],
  });
  dedupeNote(n);
  const p = n.assessment_and_plan[0];
  assert.doesNotMatch(p.assessment, /three weeks/);
  assert.match(p.assessment, /tension-type/);
  assert.match(p.treatment_planned, /amitriptyline/);
});

test('paraphrases within a section are removed, pertinent negatives are not', () => {
  const n = note({
    subjective: {
      reason_for_visit: '', hpi_details: 'Headaches for three weeks.\nHeadaches present for the past three weeks.',
      aggravating_relieving_factors: '', symptom_progression: '', previous_episodes: '', functional_impact: '',
      associated_symptoms: 'No fever.\nNo visual changes.\nNo weight loss.',
    },
  });
  dedupeNote(n);
  assert.equal(n.subjective.hpi_details.split('\n').length, 1);
  assert.equal(n.subjective.associated_symptoms.split('\n').length, 3);
});

test('de-duplication never strips a problem down to a bare heading', () => {
  // Both entries carry the same single line; the first keeps it and the second, which
  // would otherwise be emptied, falls back to its own wording.
  const n = note({
    assessment_and_plan: [
      issue({ issue: 'Eczema of the hands', assessment: 'Responding to topical steroid.' }),
      issue({ issue: 'Eczema of the feet', assessment: 'Responding to topical steroid.' }),
    ],
  });
  dedupeNote(n);
  for (const p of n.assessment_and_plan) assert.ok(p.assessment.trim(), `"${p.issue}" was emptied`);
});

test('dedupeNote tolerates a missing or empty note', () => {
  assert.deepEqual(dedupeNote(null), { merges: 0, removed: 0 });
  const n = note();
  const r = dedupeNote(n);
  assert.equal(r.merges, 0);
  assert.equal(r.removed, 0);
});

// ── semantic pass ────────────────────────────────────────────────────────────
const stubLlm = (groups) => ({ generateContent: async () => JSON.stringify({ duplicate_groups: groups }) });

function paraphraseNote() {
  return note({
    past_medical_history: { medical_surgical: 'Hypertension diagnosed 2019.\nKnown hypertensive since 2019.', social: '', family: '', exposure: '', immunisation: '', other: '' },
    assessment_and_plan: [
      issue({
        issue: 'Hypertension',
        assessment: 'BP remains above target on current therapy.\nBlood pressure is still above target despite treatment.',
        investigations_planned: 'Repeat BP in 2 weeks.',
        treatment_planned: 'Increase amlodipine to 10 mg daily.',
      }),
      issue({ issue: 'Left knee pain', assessment: 'Likely osteoarthritis.', treatment_planned: 'Paracetamol as needed.' }),
      issue({ issue: 'Right knee pain', assessment: 'Likely osteoarthritis.', treatment_planned: 'Paracetamol as needed.' }),
    ],
  });
}

test('semantic pass removes paraphrases that share no wording', async () => {
  const n = paraphraseNote();
  // 1,2 = the PMH pair; 3,4 = the Assessment pair.
  const r = await semanticDedupeNote(n, { llm: stubLlm([[1, 2], [3, 4]]) });
  assert.equal(r.removed, 2);
  assert.equal(n.past_medical_history.medical_surgical.split('\n').length, 1);
  assert.equal(n.assessment_and_plan[0].assessment.split('\n').length, 1);
});

test('semantic pass rejects groups that cross sections or fields', async () => {
  const n = paraphraseNote();
  const before = JSON.stringify(n);
  // PMH line + Assessment line, and an Investigation + an Assessment.
  const r = await semanticDedupeNote(n, { llm: stubLlm([[1, 3], [5, 6]]) });
  assert.equal(r.removed, 0);
  assert.equal(JSON.stringify(n), before);
});

test('semantic pass rejects a group spanning two different problems', async () => {
  const n = paraphraseNote();
  const before = JSON.stringify(n);
  // 6 and 8 are "Likely osteoarthritis." under Left knee and Right knee.
  const r = await semanticDedupeNote(n, { llm: stubLlm([[6, 8]]) });
  assert.equal(r.removed, 0);
  assert.equal(JSON.stringify(n), before);
});

test('semantic pass ignores unknown ids, tiny groups and bad JSON', async () => {
  const n = paraphraseNote();
  const before = JSON.stringify(n);
  for (const llm of [stubLlm([[999, 1000], [3]]), { generateContent: async () => 'not json at all' }]) {
    const r = await semanticDedupeNote(n, { llm });
    assert.equal(r.removed, 0);
  }
  assert.equal(JSON.stringify(n), before);
});

test('semantic pass fails open when the LLM throws or is absent', async () => {
  const n = paraphraseNote();
  const before = JSON.stringify(n);
  const throwing = { generateContent: async () => { throw new Error('upstream 503'); } };
  assert.deepEqual(await semanticDedupeNote(n, { llm: throwing }), { removed: 0, groups: 0 });
  assert.deepEqual(await semanticDedupeNote(n, {}), { removed: 0, groups: 0 });
  assert.equal(JSON.stringify(n), before);
});

// ── Subjective bleed into the Plan ───────────────────────────────────────────
// Regression for what a live 7-minute consult actually produced: the tightener returns a
// plan field as ONE line of several sentences, and the renderer splits it into bullets
// later. condenseNote only split on newlines, so one action verb in that blob protected
// every bled history sentence beside it and the Plan rendered as restated history.
test('history bled into a single-line plan field is removed, orders are kept', async () => {
  const { condenseNote } = await import('../src/orchestrator/condenseNote.js');
  const { noteToMarkdown } = await import('../src/orchestrator/renderMarkdown.js');
  const n = note({
    subjective: { reason_for_visit: 'Follow-up for headaches and blood pressure.', hpi_details: 'Headaches ongoing for 3 weeks. Worst in the morning; ease by lunchtime.', aggravating_relieving_factors: '', symptom_progression: '', previous_episodes: '', functional_impact: '', associated_symptoms: '' },
    objective: { vital_signs: 'BP: 152/94 mmHg', examination: '', completed_investigations: '' },
    assessment_and_plan: [issue({
      issue: 'Hypertension',
      investigations_planned: 'Kidney function and electrolytes.',
      treatment_planned: [
        'Increase amlodipine to 10 mg once daily.',
        'Continue daily home blood pressure monitoring.',
        'Follow up in clinic in 2 weeks.',
        'Patient presents for 3-month review noting headaches have returned for approximately 3 weeks.',
        'Reports home BP has been sitting around 150/90 mmHg in the mornings.',
        'Adherent to amlodipine 5 mg daily.',
        'Paracetamol 1 g PRN.',
      ].join(' '),   // ONE line, several sentences — exactly what the tightener emits
    })],
  });
  condenseNote(n, {}, () => {});
  const plan = n.assessment_and_plan[0].treatment_planned;

  for (const gone of ['presents for 3-month review', 'Reports home BP', 'Adherent to amlodipine']) {
    assert.doesNotMatch(plan, new RegExp(gone, 'i'), `bled history survived in the Plan: ${gone}`);
  }
  // Every genuine order survives, including the one with no verb at all.
  for (const keep of ['Increase amlodipine to 10 mg', 'Continue daily home blood pressure', 'Follow up in clinic in 2 weeks', 'Paracetamol 1 g PRN']) {
    assert.match(plan, new RegExp(keep, 'i'), `order wrongly removed from the Plan: ${keep}`);
  }
  assert.match(noteToMarkdown(n), /Investigations: Kidney function and electrolytes/);
});

test('bled history is KEPT when the Subjective is empty', () => {
  // Then the plan field is the only record of it; removing it would lose the history.
  const n = note({
    assessment_and_plan: [issue({
      issue: 'Hypertension',
      treatment_planned: 'Increase amlodipine to 10 mg once daily. Reports home BP around 150/90 in the mornings.',
    })],
  });
  dedupeNote(n);
  assert.match(n.assessment_and_plan[0].treatment_planned, /Reports home BP/);
});

test('a line that adds a test, drug or value is never dropped as a duplicate', () => {
  // Regression from a live run: this was discarded as a duplicate of "Repeat HbA1c in 3
  // months", which silently removed the LFT and lipid-panel orders from the note.
  const n = note({
    assessment_and_plan: [
      issue({ issue: 'Type 2 diabetes mellitus', assessment: 'Suboptimal control.', investigations_planned: 'Repeat HbA1c in 3 months' }),
      issue({ issue: 'Hypercholesterolaemia', assessment: 'Elevated LDL.', investigations_planned: 'Liver function tests and repeat lipid panel in 3 months (combined with HbA1c test).' }),
    ],
  });
  dedupeNote(n);
  assert.match(n.assessment_and_plan[0].investigations_planned, /HbA1c/);
  assert.match(n.assessment_and_plan[1].investigations_planned, /liver function/i);
  assert.match(n.assessment_and_plan[1].investigations_planned, /lipid panel/i);
});

test('a genuine exact repeat is still removed even with the information guard', () => {
  const n = note({
    assessment_and_plan: [
      issue({ issue: 'Hypertension', assessment: 'At target.', treatment_planned: 'Continue ramipril 5 mg daily.\nContinue ramipril 5mg daily.' }),
    ],
  });
  dedupeNote(n);
  assert.equal(n.assessment_and_plan[0].treatment_planned.split('\n').length, 1);
});
