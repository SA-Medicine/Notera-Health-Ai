import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsOf, mergeGraphs, numberFacts } from '../src/orchestrator/factGraph.js';
import { keysOf, requiredFacts, unitsOf, matchFact, ledger, placeFact, reconcileFacts } from '../src/orchestrator/factLedger.js';
import { noteToMarkdown } from '../src/orchestrator/renderMarkdown.js';

const TX = 'Your blood pressure is 150 over 80 today. I am going to start Lyrica 75 milligrams twice a day for the pain and stop the naproxen. No numbness or tingling in the leg. You had an x-ray two years ago that showed arthritis. We will do a flu shot today in the left arm. Come back in two weeks. I will refer you to the foot surgeon. Your mother had breast cancer.';
const note = () => ({ metadata: { subjective_style: 'topics' }, subjective: { reason_for_visit: 'Presenting Complaint:\n- Left hip pain', hpi_details: 'Left Hip Pain:\n- Present since last winter' }, past_medical_history: { medical_surgical: 'Recurrent shingles' }, objective: {}, assessment_and_plan: [{ issue: 'Left hip pain', diagnosis: '', assessment: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: 'Start Lyrica 75 mg twice daily', referrals: '' }] });
const F = (o) => ({ id: 'F001', type: 'symptom', role: 'active_problem', slot: '', text: '', importance: 'major', confidence: 0.9, actor: 'patient', status: '', certainty: '', body_part: '', region: '', medication: '', medication_status: '', dose: '', frequency: '', value: '', unit: '', numeric_type: '', negative: false, render_required: true, quote: 'q', grounded: true, at: 0, ...o });

test('a long transcript is read in overlapping windows that end on a sentence; a short one in one', () => {
  assert.equal(windowsOf('Short visit. Nothing else.').length, 1);
  const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} about the pain and the knee today.`).join(' '); const w = windowsOf(long, { size: 300, overlap: 40 });
  assert.ok(w.length >= 3); assert.ok(w.every((x) => /[.]$/.test(x.trim()))); assert.ok(w[1].includes('Sentence number'), 'windows overlap'); assert.equal(w[0].split(/\s+/)[0], 'Sentence');
});
test('windows merge into one graph: a fact seen twice is kept once and the edges follow the merged numbers', () => {
  const a = { clinical_entities: [{ entity_type: 'symptom', display_text: 'knee pain', source_quote: 'my knee hurts' }, { entity_type: 'medication', display_text: 'Advil', source_quote: 'I take Advil' }], relationships: [{ source_index: 0, target_index: 1, relationship: 'treated_by' }], orders: [{ test: 'x-ray' }] };
  const b = { clinical_entities: [{ entity_type: 'symptom', display_text: 'knee pain', source_quote: 'my knee hurts' }, { entity_type: 'follow_up', display_text: 'return in 2 weeks', source_quote: 'come back in two weeks' }], relationships: [{ source_index: 0, target_index: 1, relationship: 'followed_by' }], orders: [{ test: 'x-ray' }] };
  const m = mergeGraphs([a, b, null]); assert.equal(m.clinical_entities.length, 3); assert.equal(m.orders.length, 1); assert.deepEqual(m.relationships.map((r) => [r.source_index, r.target_index, r.relationship]).sort(), [[0, 1, 'treated_by'], [0, 2, 'followed_by']].sort());
  const n = numberFacts(m, 'my knee hurts. I take Advil. come back in two weeks'); assert.deepEqual(n.facts.map((f) => f.id), ['F001', 'F002', 'F003']); assert.ok(n.facts.every((f) => f.grounded)); assert.equal(n.edges.length, 2);
});
test('a fact is found when the note holds its words and numbers; a number that differs, or a denial written as a positive, is not a match', () => {
  const units = unitsOf(note());
  assert.ok(matchFact(F({ type: 'medication', text: 'Start Lyrica 75 mg twice daily', medication: 'Lyrica', dose: '75 mg', frequency: 'twice daily' }), units));
  assert.equal(matchFact(F({ type: 'medication', text: 'Lyrica 150 mg twice daily', medication: 'Lyrica', dose: '150 mg' }), units), null, 'another dose is another fact');
  assert.equal(matchFact(F({ text: 'No left hip pain', negative: true }), units), null, 'a denial needs a negation in the line');
  assert.ok(matchFact(F({ text: 'Left hip pain since last winter' }), units));
});
test('only facts the note must hold are required: grounded, not background, not a drug that was only mentioned', () => {
  const r = requiredFacts([F({ id: 'F1', text: 'knee pain' }), F({ id: 'F2', text: 'weather', importance: 'background' }), F({ id: 'F3', text: 'x', grounded: false }), F({ id: 'F4', type: 'medication', medication: 'Zepbound', text: 'Zepbound', medication_status: 'mention' }), F({ id: 'F5', text: 'knee pain' })]);
  assert.deepEqual(r.map((f) => f.id), ['F1']);
});
test('rule placement writes each type into its own section with the fact\'s own words', () => {
  const n = note(); const g = { facts: [], edges: [] };
  assert.equal(placeFact(n, F({ type: 'physical_exam', text: 'blood pressure 150/80', numeric_type: 'vitals' }), g), 'Objective / Vital Signs');
  assert.equal(placeFact(n, F({ type: 'physical_exam', text: 'tender over the greater trochanter', region: 'Left hip' }), g), 'Objective / Examination');
  assert.equal(placeFact(n, F({ type: 'lab_result', text: 'X-ray two years ago: arthritis' }), g), 'Objective / Investigations');
  assert.equal(placeFact(n, F({ type: 'family_history', text: 'mother had breast cancer' }), g), 'Past Medical History');
  assert.match(placeFact(n, F({ type: 'referral', text: 'foot surgeon for bunion assessment', body_part: 'Left hip' }), g), /Referrals/);
  assert.match(placeFact(n, F({ type: 'medication', medication: 'Naproxen', medication_status: 'planned', text: 'stop naproxen', body_part: 'Left hip' }), g), /Treatment/);
  assert.match(placeFact(n, F({ type: 'symptom', text: 'numbness in the leg', negative: true, body_part: 'Left hip' }), g), /Subjective/);
  const md = noteToMarkdown(n); assert.match(md, /Vital Signs\*\*\n- Blood pressure 150\/80/); assert.match(md, /Left hip: tender over the greater trochanter/); assert.match(md, /Family|Mother had breast cancer/); assert.match(md, /No numbness in the leg/);
});
test('the whole stage: found facts stay, the model places some, the rest is written in by rule, and the report says which', async () => {
  const n = note(); const facts = [
    F({ id: 'F001', type: 'medication', text: 'Start Lyrica 75 mg twice daily', medication: 'Lyrica', dose: '75 mg', frequency: 'twice daily', medication_status: 'planned', quote: 'start Lyrica 75 milligrams twice a day' }),
    F({ id: 'F002', type: 'physical_exam', text: 'blood pressure 150/80', numeric_type: 'vitals', quote: 'Your blood pressure is 150 over 80 today' }),
    F({ id: 'F003', type: 'follow_up', text: 'return in two weeks', quote: 'Come back in two weeks' }),
    F({ id: 'F004', type: 'family_history', text: 'mother had breast cancer', quote: 'Your mother had breast cancer', importance: 'critical' }),
  ];
  const llm = { generateContent: async () => JSON.stringify({ entries: [{ fact: 'F003', section: 'plan', n: 1, field: 'follow_up', text: 'in two weeks', }] }) };
  const r = await reconcileFacts(llm, n, { facts, edges: [] }, TX);
  const st = Object.fromEntries(r.rows.map((x) => [x.id, x.status])); assert.equal(st.F001, 'found'); assert.equal(st.F003, 'placed'); assert.equal(st.F002, 'forced'); assert.equal(st.F004, 'forced'); assert.equal(r.summary.stillMissing, 0);
  const md = noteToMarkdown(n); assert.match(md, /Blood pressure 150\/80/); assert.match(md, /Mother had breast cancer/); assert.match(md, /Follow-up|two weeks/i);
  const again = await reconcileFacts(null, n, { facts, edges: [] }, TX); assert.equal(again.summary.forced, 0, 'a second pass finds everything');
});
test('a model that says "already there" must point at a real note line; a made-up line is not believed', async () => {
  const n = note(); const f = [F({ id: 'F001', type: 'symptom', text: 'hip aches at night', body_part: 'Left Hip Pain', quote: 'hip aches at night', importance: 'critical' })];
  const bad = { generateContent: async () => JSON.stringify({ entries: [{ fact: 'F001', found_in: 'Hip aches at night in bed' }] }) };
  const r = await reconcileFacts(bad, n, { facts: f, edges: [] }, 'hip aches at night'); assert.equal(r.rows[0].status, 'forced');
  const n2 = note(); const good = { generateContent: async () => JSON.stringify({ entries: [{ fact: 'F001', found_in: 'Present since last winter' }] }) };
  const r2 = await reconcileFacts(good, n2, { facts: [{ ...f[0], importance: 'major' }], edges: [] }, 'hip aches at night'); assert.equal(r2.rows[0].status, 'found'); assert.equal(r2.summary.forced, 0);
});
test('keysOf drops filler and keeps drug names and numbers', () => { const k = keysOf(F({ text: 'Patient reports taking Tylenol 1 to 2 tablets every 4 hours', medication: 'Tylenol' })); assert.ok(k.stems.includes('tyleno')); assert.deepEqual(k.nums.sort(), ['1', '2', '4']); assert.ok(!k.stems.includes('patien')); });

test('a medicine written in by rule starts with the right action and names the drug', async () => {
  const { medLine } = await import('../src/orchestrator/factLedger.js');
  assert.equal(medLine(F({ text: 'Atacand dose increase', medication: 'Atacand' }), 'Atacand'), 'Increase Atacand');
  assert.equal(medLine(F({ text: 'stop the naproxen', medication: 'Naproxen' }), 'Naproxen'), 'Stop the naproxen');
  assert.equal(medLine(F({ text: 'Lyrica twice daily', medication: 'Lyrica', dose: '75 mg', frequency: 'twice daily', quote: 'I will start you on Lyrica' }), 'Lyrica 75 mg twice daily'), 'Start Lyrica 75 mg twice daily');
  assert.equal(medLine(F({ text: 'Ozempic', medication: 'Ozempic', quote: 'some people use Ozempic for that' }), 'Ozempic'), 'Discussed Ozempic', 'a drug only talked about is never written as started');
  assert.equal(medLine(F({ text: 'continue Tylenol as needed', medication: 'Tylenol' }), 'Tylenol'), 'Continue Tylenol as needed');
});

test('a shot given in the visit goes to its own problem, never to Vital Signs or the first problem; explanations are not required facts', async () => {
  const n = note(); const g = { facts: [], edges: [] };
  assert.match(placeFact(n, F({ type: 'physical_exam', text: 'B12 injection', numeric_type: 'vitals', quote: 'I will give you the B12 injection now' }), g), /Given today/);
  assert.match(placeFact(n, F({ type: 'treatment_instruction', text: 'Influenza vaccination administered in left arm', quote: 'we gave you the flu shot in the left arm' }), g), /Given today/);
  const md = noteToMarkdown(n); assert.ok(!/Vital Signs/.test(md)); assert.match(md, /Vitamin B12 injection[\s\S]*B12 injection administered/); assert.match(md, /Immunisation[\s\S]*Influenza vaccination administered in left arm/);
  const req = requiredFacts([F({ id: 'F1', type: 'clinical_context', text: 'flu season is early this year' }), F({ id: 'F2', type: 'treatment_instruction', text: 'pneumonia shot is an infection in the lungs' }), F({ id: 'F3', type: 'treatment_instruction', text: 'use heat on the neck twice a day' })]);
  assert.deepEqual(req.map((f) => f.id), ['F3']);
});

test('spelled-out numbers count: "four weeks" is not found in a line that says "2 weeks"; a critical fact needs its own line, and the model cannot vouch for it', async () => {
  const n = note(); n.assessment_and_plan.push({ issue: 'Stress', diagnosis: '', assessment: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: 'Advised to take 2 weeks stress leave', referrals: '' });
  const units = unitsOf(n); const sick = F({ type: 'administrative_action', text: 'sick note for work for four weeks', importance: 'major' });
  assert.equal(matchFact(sick, units), null, '4 weeks is not 2 weeks');
  const ok = F({ type: 'administrative_action', text: 'stress leave for two weeks', importance: 'major' }); assert.ok(matchFact(ok, units));
  const crit = F({ id: 'F009', type: 'referral', text: 'referral to dermatologist for mole on back', importance: 'critical', body_part: 'back', quote: 'refer you to the dermatologist for the mole on your back' });
  const llm = { generateContent: async () => JSON.stringify({ entries: [{ fact: 'F009', found_in: 'Left hip pain' }] }) };
  const r = await reconcileFacts(llm, n, { facts: [crit], edges: [] }, 'we will refer you to the dermatologist for the mole on your back');
  assert.equal(r.rows[0].status, 'forced', 'the model pointed at a line that does not hold a critical fact');
});

test('a vaccine that was declined, or only due, is never written as administered; a plan item with no matching problem does not land under an unrelated one', () => {
  const n = note(); const g = { facts: [], edges: [] };
  placeFact(n, F({ type: 'treatment', text: 'pneumonia shot', quote: 'I do not want the pneumonia shot today' }), g);
  placeFact(n, F({ type: 'treatment', text: 'tetanus shot', quote: 'you are okay on tetanus, it is good for ten years' }), g);
  placeFact(n, F({ type: 'treatment', text: 'Influenza vaccine in the left arm', quote: 'I will give you the flu shot in the left arm' }), g);
  const md = noteToMarkdown(n); assert.match(md, /Declined pneumonia shot/); assert.ok(!/Pneumonia shot administered|Tetanus shot administered/i.test(md)); assert.match(md, /Tetanus shot/); assert.match(md, /Influenza vaccine in the left arm administered/);
  const m = note(); placeFact(m, F({ type: 'investigation', text: 'MRI of the right shoulder', body_part: 'Right shoulder' }), g);
  assert.equal(m.assessment_and_plan[0].investigations_planned, ''); assert.equal(m.assessment_and_plan[1].issue, 'Right shoulder'); assert.match(m.assessment_and_plan[1].investigations_planned, /MRI of the right shoulder/);
});

test('the same amount written two ways is one fact: 1,000 micrograms = 1000 mcg, "iron level 31" = "iron 31", "Atacand dose" = "Atacand dose to two tablets"', () => {
  const n = { metadata: {}, subjective: { hpi_details: 'Fatigue' }, objective: { completed_investigations: 'iron 31\ncholesterol high' }, assessment_and_plan: [{ issue: 'Low vitamin B12', treatment_planned: 'Start Vitamin B12 supplement 1000 mcg daily; Increase Atacand dose to two tablets every morning', referrals: '' }] };
  const u = unitsOf(n);
  assert.ok(matchFact(F({ type: 'medication', text: 'Vitamin B12 1,000 micrograms', medication: 'Vitamin B12' }), u));
  assert.ok(matchFact(F({ type: 'lab_result', text: 'Iron level 31' }), u));
  assert.ok(matchFact(F({ type: 'medication', text: 'Atacand dose', medication: 'Atacand' }), u));
  assert.equal(matchFact(F({ type: 'lab_result', text: 'Iron level 41' }), u), null);
});

test('the writer\'s fact ids are taken off every line and kept as citations; a cited fact counts as found (a critical one only if the code finds it too)', async () => {
  const { stripCitations } = await import('../src/orchestrator/factLedger.js');
  const out = { subjective: { hpi_details: '[F001,F002] Left hip pain since last winter\n[-] Feels tired' }, assessment_and_plan: [{ issue: 'Hip', treatment_planned: '[F003] Start Lyrica 75 mg twice daily; Stop naproxen [F004]' }] };
  const c = stripCitations(out);
  assert.equal(out.subjective.hpi_details, 'Left hip pain since last winter\nFeels tired'); assert.equal(out.assessment_and_plan[0].treatment_planned, 'Start Lyrica 75 mg twice daily; Stop naproxen');
  assert.deepEqual([...c.ids].sort(), ['F001', 'F002', 'F003', 'F004']); assert.equal(c.lines, 4); assert.equal(c.cited, 2);
  const n = note(); const facts = [F({ id: 'F001', text: 'mother had breast cancer', type: 'family_history', importance: 'major' }), F({ id: 'F002', text: 'stroke last year', type: 'pmh', importance: 'critical' })];
  const r = await reconcileFacts(null, n, { facts, edges: [] }, 'x', () => {}, { cited: new Set(['F001', 'F002']) });
  const st = Object.fromEntries(r.rows.map((x) => [x.id, x.status])); assert.equal(st.F001, 'found'); assert.equal(st.F002, 'forced', 'a critical cited fact the code cannot find is written in');
});

test('a history or context fact the model did not place is not written in as a bare line (it would break the story); a plan fact is', async () => {
  const n = note(); const facts = [F({ id: 'F001', type: 'symptom', text: 'neck cracking like a tendon snapping', importance: 'major', quote: 'neck cracking like a tendon snapping' }), F({ id: 'F002', type: 'referral', text: 'refer to physiotherapy', importance: 'major', quote: 'refer to physiotherapy' })];
  const r = await reconcileFacts(null, n, { facts, edges: [] }, 'x'); const st = Object.fromEntries(r.rows.map((x) => [x.id, x.status]));
  assert.equal(st.F001, 'missing'); assert.equal(st.F002, 'forced');
});
