// Unit tests for the deterministic upgrade guardrails. Run: node packages/backend/src/validation/upgrades.test.mjs
import { routeMedicationToPlan, validateTemporalStatus, flagSuspiciousValues, isBlankEncounter, applyUpgradeGuardrails, verifyPharmacyBinding, flagNonPatientContext, adminRefillFailsafe, looksLikeBenchmarkingPrompt, flagUngroundedNumbers, multiSystemFallback, enforceDateGrounding, groundNamedReferences, stripRepetition } from './upgrades.js';
import { reconcileMedications, normalizeMedications, _clearCache } from '../services/rxnorm.js';
import { noteToMarkdown } from '../orchestrator/renderMarkdown.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.error('  ✗', name); } };
const logs = () => { const a = []; return { sink: (l) => a.push(l), all: a }; };

function baseNote(over = {}) {
  return {
    subjective: { history_of_presenting_illness: '', past_medical_history: '', ...(over.subjective || {}) },
    objective: { vital_signs: '', completed_investigations: '', ...(over.objective || {}) },
    assessment_and_plan: over.assessment_and_plan || [{ issue: 'ADHD', diagnosis: 'ADHD', assessment: '', investigations_planned: '', treatment_planned: '', referrals: '' }],
    metadata: { flags: [] },
  };
}

console.log('A · section-router');
{
  const n = baseNote({ objective: { completed_investigations: 'Started ADD medication at 30 mg daily for 4 weeks, then increase to 40 mg\nHemoglobin 88 g/L' } });
  const L = logs();
  routeMedicationToPlan(n, L.sink);
  ok('moves medication titration line to Plan', /30 mg daily/.test(n.assessment_and_plan[0].treatment_planned));
  ok('leaves the lab value in Objective', /Hemoglobin 88/.test(n.objective.completed_investigations));
  ok('does NOT leave the med line in Objective', !/30 mg daily/.test(n.objective.completed_investigations));
  ok('logged the move', L.all.some((l) => l.includes('section-router') && l.includes('treatment_planned')));
}
{
  // routes to the best-matching problem by word overlap
  const n = baseNote({
    subjective: { history_of_presenting_illness: 'Increase Zepbound to 7.5 mg weekly' },
    assessment_and_plan: [
      { issue: 'Hypertension', diagnosis: '', treatment_planned: '', investigations_planned: '', referrals: '' },
      { issue: 'Obesity — Zepbound', diagnosis: '', treatment_planned: '', investigations_planned: '', referrals: '' },
    ],
  });
  routeMedicationToPlan(n, () => {});
  ok('routes to the Zepbound problem, not the first', /Zepbound to 7.5/.test(n.assessment_and_plan[1].treatment_planned) && !n.assessment_and_plan[0].treatment_planned);
}
{
  // does not move a plain symptom line
  const n = baseNote({ subjective: { history_of_presenting_illness: 'Reports stomach cramps for 3 days' } });
  routeMedicationToPlan(n, () => {});
  ok('leaves non-medication subjective content alone', /stomach cramps/.test(n.subjective.history_of_presenting_illness));
}

console.log('G · temporal-validator');
{
  const n = baseNote({ objective: { completed_investigations: 'Repeat pelvic ultrasound in 2 weeks - normal findings' } });
  const L = logs();
  validateTemporalStatus(n, L.sink);
  ok('removes fabricated future result from Objective', !/normal findings/.test(n.objective.completed_investigations) && !/pelvic ultrasound/.test(n.objective.completed_investigations));
  ok('relocates it to investigations_planned without the status', /pelvic ultrasound in 2 weeks/.test(n.assessment_and_plan[0].investigations_planned) && !/normal/.test(n.assessment_and_plan[0].investigations_planned));
  ok('logged the temporal fix', L.all.some((l) => l.includes('temporal-validator') && l.toLowerCase().includes('future')));
}
{
  // a genuinely completed normal result stays put
  const n = baseNote({ objective: { completed_investigations: 'Chest x-ray normal' } });
  validateTemporalStatus(n, () => {});
  ok('keeps a genuinely completed result in Objective', /Chest x-ray normal/.test(n.objective.completed_investigations));
}

console.log('D1 · value-flagger');
{
  const n = baseNote({ assessment_and_plan: [{ issue: 'ADHD', treatment_planned: 'ADD medication 30 Brian in the morning', investigations_planned: '', referrals: '' }] });
  const { flags } = flagSuspiciousValues(n, () => {});
  ok('flags "30 Brian" as a suspicious dose', flags.length === 1 && flags[0].type === 'suspicious_medication_value');
}
{
  const n = baseNote({ assessment_and_plan: [{ issue: 'DM', treatment_planned: 'Metformin 500 mg twice daily', investigations_planned: '', referrals: '' }] });
  const { flags } = flagSuspiciousValues(n, () => {});
  ok('does NOT flag a normal dose with a unit', flags.length === 0);
}

console.log('B · blank-encounter');
{
  ok('empty graph → blank', isBlankEncounter({ graph: { clinical_entities: [] } }) === true);
  ok('graph with entities → not blank', isBlankEncounter({ graph: { clinical_entities: [{ display_text: 'cough' }] } }) === false);
  ok('phatic-only transcript (no graph) → blank', isBlankEncounter({ transcript: 'Hello, how are you doing? Thanks, goodbye.' }) === true);
  ok('clinical transcript (no graph) → not blank', isBlankEncounter({ transcript: 'Patient reports chest pain and cough for three days with fever.' }) === false);
}

console.log('orchestration · applyUpgradeGuardrails');
{
  const n = baseNote({ objective: { completed_investigations: 'Increase Lisinopril to 10 mg daily\nRepeat renal ultrasound in 2 weeks - normal' }, assessment_and_plan: [{ issue: 'Hypertension — Lisinopril', treatment_planned: '', investigations_planned: '', referrals: '' }] });
  const captured = [];
  const r = applyUpgradeGuardrails(n, { log: (l) => captured.push(l) });
  ok('re-routed the med line', /Lisinopril to 10 mg/.test(n.assessment_and_plan[0].treatment_planned));
  ok('fixed the future result', /renal ultrasound in 2 weeks/.test(n.assessment_and_plan[0].investigations_planned) && !/normal/.test(n.assessment_and_plan[0].investigations_planned));
  ok('emitted a summary log line', captured.some((l) => l.startsWith('[upgrade] guardrails complete')));
  ok('all logs carry the [upgrade prefix', r.logs.every((l) => l.startsWith('[upgrade')));
}

console.log('A(3) · pharmacy-binding');
{
  // Patient9 class: transcript pairs gabapentin↔Prexol, Zepbound↔Shoppers; note swaps gabapentin→Rexall
  const transcript = 'Send the gabapentin to Prexol pharmacy. The Zepbound goes to Shoppers Essex.';
  const n = baseNote({ assessment_and_plan: [{ issue: 'Neuropathy', treatment_planned: 'Gabapentin 300 mg — sent to Rexall', investigations_planned: '', referrals: '' }] });
  const { flags } = verifyPharmacyBinding(n, { transcript, meds: ['gabapentin', 'zepbound'] }, () => {});
  ok('flags a pharmacy routed to the wrong drug', flags.length === 1 && flags[0].type === 'pharmacy_mismatch' && /gabapentin/i.test(flags[0].message));
}
{
  const transcript = 'Send the gabapentin to Prexol.';
  const n = baseNote({ assessment_and_plan: [{ issue: 'Neuropathy', treatment_planned: 'Gabapentin 300 mg — sent to Prexol', investigations_planned: '', referrals: '' }] });
  const { flags } = verifyPharmacyBinding(n, { transcript, meds: ['gabapentin'] }, () => {});
  ok('does NOT flag when routing matches the transcript', flags.length === 0);
}

console.log('F · non-patient context');
{
  const { flags } = flagNonPatientContext(baseNote(), 'My dad needs his blood pressure pills renewed.', () => {});
  ok('flags caregiver/proxy language', flags.length === 1 && flags[0].type === 'non_patient_context');
  const { flags: f2 } = flagNonPatientContext(baseNote(), 'I have had a cough for three days.', () => {});
  ok('does not flag a normal first-person transcript', f2.length === 0);
}

console.log('C · admin-refill fail-safe');
{
  ok('promotes admin refill with a dose change', adminRefillFailsafe('medication_refill_administrative', 'I want to increase my Zepbound to 5 mg', () => {}) === 'medication_refill');
  ok('promotes admin refill with a pharmacy route', adminRefillFailsafe('medication_refill_administrative', 'renew and send to Rexall', () => {}) === 'medication_refill');
  ok('leaves a pure admin refill alone', adminRefillFailsafe('medication_refill_administrative', 'please renew all my usual pills', () => {}) === 'medication_refill_administrative');
  ok('never touches other encounter types', adminRefillFailsafe('gynecology', 'increase dose, send to Rexall', () => {}) === 'gynecology');
}

console.log('E · benchmarking-prompt detector');
{
  ok('detects a benchmarking rubric', looksLikeBenchmarkingPrompt('… metric_1_equivalence … overall_winner: heidi|notera … n=2000 …') === true);
  ok('passes the real gate prompt', looksLikeBenchmarkingPrompt('You are the Clinical QA Validator for DAS V31. Return {status, action, retry_reason}.') === false);
}

console.log('D-Tier2 · RxNorm (mocked fetch)');
{
  _clearCache();
  // mock RxNav: "metformin" resolves; "Brianox" (garbage) does not
  const fetchImpl = async (url) => {
    const u = decodeURIComponent(url);
    if (u.includes('approximateTerm') && /term=metformin/i.test(u)) return { ok: true, json: async () => ({ approximateGroup: { candidate: [{ rxcui: '6809', score: '100', name: 'metformin' }] } }) };
    if (u.includes('approximateTerm')) return { ok: true, json: async () => ({ approximateGroup: { candidate: [{ rxcui: '0', score: '5' }] } }) };
    if (u.includes('byRxcui')) return { ok: true, json: async () => ({ rxclassDrugInfoList: { rxclassDrugInfo: [{ rxclassMinConceptItem: { classId: 'A10BA02', className: 'Biguanides', classType: 'ATC1-4' } }] } }) };
    if (u.includes('spellingsuggestions')) return { ok: true, json: async () => ({ suggestionGroup: { suggestionList: { suggestion: ['Brimonidine', 'Brilinta'] } } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { flags } = await reconcileMedications(['metformin', 'Brianox'], { fetchImpl });
  ok('flags an unresolvable medication', flags.length === 1 && /Brianox/.test(flags[0].message));
  ok('adds "did you mean" spelling hints', /did you mean/i.test(flags[0].message) && /Brimonidine/.test(flags[0].message));
  ok('does not flag a resolvable medication', !flags.some((f) => /metformin/i.test(f.message)));
}

console.log('G(2) · numeric grounding');
{
  // fabricated B12 1000 (not in transcript) → flag; grounded 5 mmol/L → no flag
  const n = baseNote({ objective: { completed_investigations: 'Vitamin B12: 1000 micrograms\nBlood glucose 5 mmol/L' } });
  const { flags } = flagUngroundedNumbers(n, 'Her glucose was 5 and B12 was low.', () => {});
  ok('flags the fabricated B12 1000 value', flags.length === 1 && /1000/.test(flags[0].message));
}
{
  // spelled-out "one thousand" in transcript grounds "1000"
  const n = baseNote({ objective: { completed_investigations: 'Ferritin 1000 mcg' } });
  const { flags } = flagUngroundedNumbers(n, 'ferritin came back at one thousand', () => {});
  ok('grounds a spelled-out number (one thousand → 1000)', flags.length === 0);
}
{
  // non-measurement line is ignored
  const n = baseNote({ assessment_and_plan: [{ issue: 'Refill', treatment_planned: 'Refill 3 months supply', investigations_planned: '', referrals: '' }] });
  const { flags } = flagUngroundedNumbers(n, 'refill his pills', () => {});
  ok('ignores non-measurement numbers', flags.length === 0);
}

console.log('C(2) · multi-system fallback');
{
  const t = 'trying to conceive, PCOS, plus high cholesterol and stomach reflux and low B12';
  ok('narrow label + ≥3 systems → general_primary_care', multiSystemFallback('anemia', t, () => {}) === 'general_primary_care');
  ok('narrow label + single system → unchanged', multiSystemFallback('anemia', 'iron deficiency anemia, ferritin low', () => {}) === 'anemia');
  ok('non-narrow label is never overridden', multiSystemFallback('general_primary_care', t, () => {}) === 'general_primary_care');
}

console.log('UI · noteToMarkdown');
{
  const n = baseNote({
    subjective: { reason_for_visit: 'Trying to conceive', associated_symptoms: 'Increased sweating\nDenies fever' },
    objective: { completed_investigations: 'Fasting glucose: 5 - normal' },
    assessment_and_plan: [{ issue: 'PCOS', diagnosis: 'PCOS', assessment: '', investigations_planned: '', treatment_planned: 'Prenatal vitamins', referrals: '' }],
  });
  const mdOut = noteToMarkdown(n);
  ok('renders section headings', /### Subjective/.test(mdOut) && /### Objective/.test(mdOut) && /### Assessment & Plan/.test(mdOut));
  ok('renders one bullet per line', /- Trying to conceive/.test(mdOut) && /- Increased sweating/.test(mdOut) && /- Denies fever/.test(mdOut));
  ok('numbers A&P issues with a bold title', /1\. \*\*PCOS\*\*/.test(mdOut));
  ok('labels A&P sub-bullets', /- Treatment: Prenatal vitamins/.test(mdOut));
}

console.log('G(3) · date grounding');
{
  // ungrounded date (year not in transcript) → stripped from the line
  const n = baseNote({ subjective: { reason_for_visit: 'Trying to conceive since 2003-08-03', hpi_details: 'Married on 1996-12-25' } });
  const r = enforceDateGrounding(n, 'She has been trying to conceive for a while; she is married.', () => {});
  ok('strips an ungrounded ISO date', !/2003-08-03/.test(n.subjective.reason_for_visit) && /Trying to conceive/.test(n.subjective.reason_for_visit));
  ok('strips a second ungrounded date', !/1996-12-25/.test(n.subjective.hpi_details) && /Married/.test(n.subjective.hpi_details));
  ok('counts ungrounded dates', r.ungrounded === 2 && r.flags.some((f) => f.type === 'ungrounded_date'));
}
{
  // grounded date (year present in transcript) is kept
  const n = baseNote({ subjective: { reason_for_visit: 'LMP: 2021-03-30' } });
  const r = enforceDateGrounding(n, 'Her last period was 2021-03-30.', () => {});
  ok('keeps a date whose value is in the transcript', /2021-03-30/.test(n.subjective.reason_for_visit) && r.ungrounded === 0);
}
{
  // grounded by year alone
  const n = baseNote({ subjective: { reason_for_visit: 'Diagnosed 2019-05-02' } });
  const r = enforceDateGrounding(n, 'that was back in 2019 sometime', () => {});
  ok('keeps a date whose YEAR is in the transcript', /2019-05-02/.test(n.subjective.reason_for_visit) && r.ungrounded === 0);
}
{
  // implausible future year → warning flag
  const n = baseNote({ subjective: { reason_for_visit: 'Next review 2099' } });
  const r = enforceDateGrounding(n, 'come back next year 2099 apparently', () => {});
  ok('flags an implausible future year', r.flags.some((f) => f.type === 'implausible_date'));
}
{
  // flag-only mode keeps the text
  const n = baseNote({ subjective: { reason_for_visit: 'Married 1974-11-25' } });
  const r = enforceDateGrounding(n, 'they are married', () => {}, { mode: 'flag' });
  ok('flag mode keeps the date but flags it', /1974-11-25/.test(n.subjective.reason_for_visit) && r.ungrounded === 1);
}

console.log('grounding rate · applyUpgradeGuardrails');
{
  const n = baseNote({ objective: { completed_investigations: 'Vitamin B12: 1000 micrograms' }, subjective: { reason_for_visit: 'Married on 1996-12-25' } });
  const r = applyUpgradeGuardrails(n, { transcript: 'she is married and her B12 was low' });
  ok('sets a grounding rate in metadata', typeof n.metadata.grounding?.rate === 'number' && n.metadata.grounding.rate < 1);
  ok('summary logs the grounding rate', r.logs.some((l) => /grounding rate \d+%/.test(l)));
}

console.log('A(4) · named-reference grounding');
{
  // fabricated pharmacy (not in transcript) → stripped
  const n = baseNote({ assessment_and_plan: [{ issue: 'Refill', treatment_planned: 'Zepbound refill — sent to Rexall', investigations_planned: '', referrals: '' }] });
  const r = groundNamedReferences(n, 'send the zepbound to Prexol pharmacy', () => {});
  ok('strips a fabricated pharmacy name', !/Rexall/.test(n.assessment_and_plan[0].treatment_planned) && r.flags.some((f) => f.type === 'fabricated_reference'));
}
{
  // grounded referral target is kept
  const n = baseNote({ assessment_and_plan: [{ issue: 'Anemia', treatment_planned: '', investigations_planned: '', referrals: 'Referral to Dr. Taraban' }] });
  const r = groundNamedReferences(n, 'I will refer you to Dr. Taraban for that', () => {});
  ok('keeps a referral target spoken in the transcript', /Dr\. Taraban/.test(n.assessment_and_plan[0].referrals) && r.flags.length === 0);
}
{
  // fabricated facility → stripped
  const n = baseNote({ objective: { completed_investigations: 'MRI at Riverside Imaging' } });
  const r = groundNamedReferences(n, 'we arranged an MRI for you', () => {});
  ok('strips a fabricated facility name', !/Riverside/.test(n.objective.completed_investigations) && r.flags.some((f) => f.field === 'facility'));
}

console.log('A(4b) · clinician + phone grounding');
{
  // fabricated clinician + phone (gold has "Dr. Patient 290"; transcript has no "Taraban" and no such number)
  const n = baseNote({ assessment_and_plan: [{ issue: 'Anemia', treatment_planned: '', investigations_planned: '', referrals: 'Referral to specialist Dr. Taraban. Call the office at 596-637-777 directly.' }] });
  const r = groundNamedReferences(n, 'I will refer you to Dr. Patient 290 for the anemia.', () => {});
  ok('strips a fabricated clinician name', !/Taraban/.test(n.assessment_and_plan[0].referrals) && r.flags.some((f) => f.field === 'clinician'));
  ok('strips a fabricated phone number', !/596-637-777/.test(n.assessment_and_plan[0].referrals) && r.flags.some((f) => f.type === 'fabricated_contact'));
}
{
  // grounded clinician (name present in transcript) is kept
  const n = baseNote({ assessment_and_plan: [{ issue: 'Anemia', treatment_planned: '', investigations_planned: '', referrals: 'Referral to Dr. Patient 290' }] });
  const r = groundNamedReferences(n, 'refer to Dr. Patient 290 please', () => {});
  ok('keeps a grounded clinician name', /Patient/.test(n.assessment_and_plan[0].referrals) && !r.flags.some((f) => f.field === 'clinician'));
}
{
  // grounded phone is kept
  const n = baseNote({ subjective: { reason_for_visit: 'Contact number 555-123-4567' } });
  const r = groundNamedReferences(n, 'my number is 5551234567', () => {});
  ok('keeps a phone present in the transcript', /555-123-4567/.test(n.subjective.reason_for_visit) && !r.flags.some((f) => f.type === 'fabricated_contact'));
}

console.log('UI · noteToMarkdown sentence bullets');
{
  const n = baseNote({ assessment_and_plan: [{ issue: 'Anemia', diagnosis: 'Iron deficiency anemia', assessment: 'The patient has severe anemia. Her hemoglobin remains low despite oral iron.', investigations_planned: '', treatment_planned: '', referrals: '' }] });
  const mdOut = noteToMarkdown(n);
  ok('splits an assessment paragraph into separate bullets', /- The patient has severe anemia\./.test(mdOut) && /- Her hemoglobin remains low/.test(mdOut));
}
{
  const n = baseNote({ subjective: { reason_for_visit: 'Seeing Dr. Taraban for this. No other issues.' } });
  const mdOut = noteToMarkdown(n);
  ok('does not split on "Dr." abbreviation', /Seeing Dr\. Taraban for this\./.test(mdOut));
}

console.log('RxNorm agent · normalizeMedications (mocked)');
{
  _clearCache();
  const fetchImpl = async (url) => {
    const u = decodeURIComponent(url);
    if (u.includes('approximateTerm') && /term=metfromin/i.test(u)) return { ok: true, json: async () => ({ approximateGroup: { candidate: [{ rxcui: '6809', score: '90', name: 'metformin' }] } }) };
    if (u.includes('approximateTerm') && /term=zepbound/i.test(u)) return { ok: true, json: async () => ({ approximateGroup: { candidate: [{ rxcui: '2601723', score: '100', name: 'Zepbound' }] } }) };
    if (u.includes('approximateTerm')) return { ok: true, json: async () => ({ approximateGroup: { candidate: [{ rxcui: '0', score: '5' }] } }) };
    if (u.includes('spellingsuggestions')) return { ok: true, json: async () => ({ suggestionGroup: { suggestionList: { suggestion: ['Lorazepam'] } } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  // "metfromin" (misspelled, in transcript) → corrected to "Metformin"; "Brianox" (not in transcript, unresolved) → fabrication flag
  const n = baseNote({ assessment_and_plan: [{ issue: 'DM', treatment_planned: 'Metfromin 500 mg; Zepbound; Brianox', investigations_planned: '', referrals: '' }] });
  n.metadata.medications_mentioned = ['Metfromin', 'Zepbound', 'Brianox'];
  const r = await normalizeMedications(n, 'start metfromin and continue zepbound', { fetchImpl });
  ok('corrects a misspelled drug to the canonical name', /Metformin/.test(n.assessment_and_plan[0].treatment_planned) && !/Metfromin/.test(n.assessment_and_plan[0].treatment_planned));
  ok('reports the correction count', r.corrected >= 1);
  ok('flags a fabricated drug not in transcript', r.flags.some((f) => f.type === 'fabricated_medication' && /Brianox/.test(f.message)));
  ok('leaves a correctly-spelled brand alone', /Zepbound/.test(n.assessment_and_plan[0].treatment_planned));
}

console.log('R · de-repetition (degenerate loop guard)');
{
  const unit = 'next week for her safety and health overall today as scheduled too as well overall also as noted in details today in clinic ';
  const n = baseNote({ subjective: { hpi_details: 'Leg weakness began Monday. Felt lightheaded at the bank on Tuesday. ' + unit.repeat(500) } });
  const r = stripRepetition(n, () => {});
  ok('collapses a huge repetition loop', n.subjective.hpi_details.length < 400 && r.fixed >= 1);
  ok('keeps the legit content before the loop', /Leg weakness began Monday/.test(n.subjective.hpi_details) && /lightheaded at the bank on Tuesday/.test(n.subjective.hpi_details));
  ok('leaves normal text untouched', (() => { const m = baseNote({ subjective: { hpi_details: 'Cough for three days. Denies fever.' } }); stripRepetition(m, () => {}); return m.subjective.hpi_details === 'Cough for three days. Denies fever.'; })());
}
{
  // collapses simple repeated words too
  const n = baseNote({ subjective: { reason_for_visit: 'pain pain pain pain in the knee' } });
  stripRepetition(n, () => {});
  ok('collapses repeated words', n.subjective.reason_for_visit === 'pain in the knee');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
