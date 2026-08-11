// Tests for the cross-section condenser. Run: node packages/backend/src/orchestrator/condenseNote.test.mjs
import { condenseNote } from './condenseNote.js';
import { noteToMarkdown } from './renderMarkdown.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.error('  ✗', n); } };

function note(over = {}) {
  return {
    subjective: { reason_for_visit: '', hpi_details: '', associated_symptoms: '', ...(over.subjective || {}) },
    past_medical_history: { medical_surgical: '', ...(over.pmh || {}) },
    objective: { vital_signs: '', examination: '', completed_investigations: '', ...(over.objective || {}) },
    assessment_and_plan: over.ap || [],
  };
}

console.log('condenseNote · A&P redundancy');
{
  const n = note({
    subjective: { hpi_details: 'The patient has persistent severe iron deficiency anemia that is not improving despite taking daily oral iron and her stomach medications.' },
    ap: [{
      issue: 'Iron deficiency anemia',
      diagnosis: 'Iron deficiency anemia secondary to gastric ulcer',
      assessment: 'The patient has persistent severe iron deficiency anemia that is not improving despite taking daily oral iron and her stomach medications. Plan to resend bloodwork and arrange specialist review.',
      investigations_planned: '', treatment_planned: '', referrals: '',
    }],
  });
  const r = condenseNote(n, {}, () => {});
  ok('drops the A&P sentence that repeats the Subjective detail', !/persistent severe iron deficiency anemia that is not improving/i.test(n.assessment_and_plan[0].assessment));
  ok('keeps the unique A&P plan sentence', /resend bloodwork/i.test(n.assessment_and_plan[0].assessment));
  ok('reports what it removed', r.removed >= 1);
}
{
  // nothing redundant → untouched
  const n = note({ subjective: { hpi_details: 'Cough for three days.' }, ap: [{ issue: 'URTI', assessment: 'Likely viral. Advise fluids and rest.', investigations_planned: '', treatment_planned: '', referrals: '' }] });
  const r = condenseNote(n, {}, () => {});
  ok('leaves non-redundant A&P alone', /Likely viral/.test(n.assessment_and_plan[0].assessment) && /fluids and rest/.test(n.assessment_and_plan[0].assessment) && r.removed === 0);
}

console.log('condenseNote · within-section (Subjective timeline) de-dup');
{
  const n = note({
    subjective: {
      hpi_details: 'Leg weakness and body shakiness started on Monday. Lightheadedness occurred on Tuesday at the bank.',
      symptom_progression: 'Leg weakness and body shakiness started on Monday.',   // restated
      functional_impact: 'Lightheadedness occurred on Tuesday at the bank.',        // restated
    },
  });
  const r = condenseNote(n, {}, () => {});
  ok('drops the restated timeline sentences', n.subjective.symptom_progression.trim() === '' && n.subjective.functional_impact.trim() === '');
  ok('keeps the first (hpi) statement', /Leg weakness and body shakiness started on Monday/.test(n.subjective.hpi_details));
  ok('reports intra-section removals', r.withinRemoved >= 2);
}

console.log('condenseNote · Objective de-dup');
{
  const n = note({ objective: { examination: 'Hemoglobin 88 g/L low', completed_investigations: 'Hemoglobin 88 g/L (low)' } });
  const r = condenseNote(n, {}, () => {});
  ok('removes an exam line duplicated in investigations', n.objective.examination.trim() === '' && r.deduped >= 1);
  ok('keeps the investigation copy', /Hemoglobin 88/.test(n.objective.completed_investigations));
}

console.log('render · A&P stays bulleted after condensing');
{
  const n = note({
    subjective: { hpi_details: 'Severe anemia not improving on oral iron.' },
    ap: [{ issue: 'Anemia', diagnosis: 'Iron deficiency anemia', assessment: 'Severe anemia not improving on oral iron. Resend bloodwork to specialist.', investigations_planned: '', treatment_planned: 'Continue iron', referrals: '' }],
  });
  condenseNote(n, {}, () => {});
  const md = noteToMarkdown(n);
  ok('A&P renders as a numbered issue with sub-bullets', /1\. \*\*Anemia\*\*/.test(md) && /- Treatment: Continue iron/.test(md));
  ok('the redundant sentence is gone from the render', !/Severe anemia not improving on oral iron/.test(md.split('Assessment & Plan')[1] || ''));
}

console.log('condenseNote · pertinent negatives survive the Subjective merge');
{
  const n = note({
    subjective: {
      hpi_details: 'She has chest pain, shortness of breath, palpitations and a pounding sensation on exertion.',
      associated_symptoms: 'No chest pain, shortness of breath, palpitations, or pounding sensation at rest.', // negative — must survive
    },
  });
  const r = condenseNote(n, {}, () => {});
  ok('keeps the pertinent negative even though the topic appears in the HPI above', /No chest pain/i.test(n.subjective.associated_symptoms));
}
{
  // a NON-negative restatement is still dropped (dedup still works)
  const n = note({
    subjective: {
      hpi_details: 'Leg weakness and body shakiness began on Monday morning at home.',
      symptom_progression: 'Leg weakness and body shakiness began on Monday morning at home.',
    },
  });
  const r = condenseNote(n, {}, () => {});
  ok('still drops a non-negative duplicate sentence', n.subjective.symptom_progression.trim() === '' && r.withinRemoved >= 1);
}

console.log('render · merged Subjective + dissolved Objective (no Key/Exam Findings header)');
{
  const n = note({
    subjective: { reason_for_visit: 'Weakness and fatigue.', hpi_details: 'Feeling weak since Monday.', associated_symptoms: 'No fever noted at any point.' },
    objective: { vital_signs: 'BP 130/80.', examination: 'Gait normal.', completed_investigations: 'CBC pending.' },
  });
  const md = noteToMarkdown(n);
  ok('Subjective is merged — no separate "Presenting Complaints" header', !/Presenting Complaints/i.test(md) && /### Subjective/.test(md));
  ok('Objective dissolves the Key/Exam Findings subsection', !/Exam Findings/i.test(md) && !/Key Findings/i.test(md) && /### Objective/.test(md));
  ok('Vitals stay labelled and findings render as dissolved bullets', /\*\*Vital Signs\*\*/.test(md) && /- Gait normal/.test(md) && /- CBC pending/.test(md));
  ok('Associated Symptoms remains its own sub-block', /\*\*Associated Symptoms\*\*/.test(md) && /No fever/i.test(md));
}

console.log('render · A&P title uses the disease name, not a placeholder number');
{
  const n = note({ ap: [
    { issue: '1', diagnosis: 'Diverticulitis', assessment: 'Recurrent flare.', investigations_planned: '', treatment_planned: 'Two antibiotics bid.', referrals: '' },
    { issue: 'Issue 2', diagnosis: 'Iron deficiency anaemia', assessment: '', investigations_planned: '', treatment_planned: 'Oral iron.', referrals: '' },
  ] });
  const md = noteToMarkdown(n);
  ok('numeric placeholder issue "1" → titled by the diagnosis', /1\. \*\*Diverticulitis\*\*/.test(md) && !/1\. \*\*1\*\*/.test(md));
  ok('"Issue 2" placeholder → titled by the diagnosis', /2\. \*\*Iron deficiency anaemia\*\*/.test(md));
}
{
  // a real issue name is kept as-is
  const n = note({ ap: [{ issue: 'Left knee quadriceps tendon injury', diagnosis: '', assessment: 'Partial tear.', investigations_planned: '', treatment_planned: 'RICE.', referrals: '' }] });
  const md = noteToMarkdown(n);
  ok('keeps a genuine issue name', /1\. \*\*Left knee quadriceps tendon injury\*\*/.test(md));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
