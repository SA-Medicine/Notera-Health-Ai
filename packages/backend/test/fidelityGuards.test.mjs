import test from 'node:test';
import assert from 'node:assert/strict';
import { fidelityGuards, socialGuard, unheardDrugs, unifySpellings, unheardTests, dropEmptyHeadings, tidyPlanLines, dropCoveredScreeningStatus } from '../src/orchestrator/fidelityGuards.js';

// excerpts of a real visit (acid reflux after a knee replacement): the clinician lists reflux triggers, nobody says anything about the patient's habits
const T = `Since the surgery. I had to drink Gatorade. No caffeine? Coffee? How many? Maybe two. Do you have a metallic taste? Oh Yeah. I'll put you on a medication. You'll take it before the breakfast every day.
So the things that can make the reflux worse is caffeine, ibuprofen. The other things that smoking, alcohol, obviously. And then tomatoes.
The Crestor or rovastatin. Yes. You're due for tetanus shot? So did you want us to send you for some ready? Okay. MRI. Just in case in the future you need MRIs.
Poop test? Can I ask them to mail the poop? I'm going to give you the tetanus shot. I'm mailing your poop kit to your house. Mammogram up to date? Yeah. Pap smear No.`;
const note = () => ({
  subjective: { reason_for_visit: 'Presenting Complaint:\n- Acid reflux', hpi_details: 'Allergies:\nHeartburn:\n- ginger chewables calm it down', aggravating_relieving_factors: '', symptom_progression: '', previous_episodes: '', functional_impact: '', associated_symptoms: '' },
  past_medical_history: { medical_surgical: 'Hypertension', social: 'Patient is single, lives alone, does not smoke or drink alcohol', family: '', exposure: '', immunisation: 'Tetanus booster due', other: 'Non-smoker\nPreventive care: mammogram up to date, stool test due, Pap smear declined\nMedications: ibuprofen 400 milligram, Crestor (rosuvastatin)' },
  assessment_and_plan: [
    { issue: 'Acid reflux', diagnosis: 'Acid reflux', assessment: '', investigations_planned: '', treatment_planned: 'Start Pantoprazole before breakfast daily with a small cracker', referrals: '', differential_diagnoses: [] },
    { issue: 'Sleep apnea', diagnosis: '', assessment: '', investigations_planned: 'Referral for sleep study or follow-up with anesthesiologist discussed', treatment_planned: '', referrals: '' },
    { issue: 'Hypercholesterolaemia', diagnosis: '', assessment: 'Stable', investigations_planned: '', treatment_planned: 'Refill Rovastatin; prescription faxed', referrals: '' },
    { issue: 'Preventive care', diagnosis: '', assessment: '', investigations_planned: 'FIT kit to be mailed to patient\'s home; tetanus shot; poop kit', treatment_planned: 'Administer tetanus booster vaccination today', referrals: '' },
  ],
  metadata: { flags: [{ type: 'medication_unverified', field: 'medications', severity: 'warning', message: 'Heard "Rovastatin"; the model had written "rosuvastatin", which is not in the transcript. Kept as spoken — please verify the drug name.' }] },
});

test('social history nobody said is removed, advice about triggers is not history', () => {
  const n = note(); const r = socialGuard(n, T);
  assert.ok(r.length >= 3);
  assert.equal(n.past_medical_history.social, '');
  assert.ok(!/smok/i.test(n.past_medical_history.other), n.past_medical_history.other);
  assert.ok(n.metadata.flags.some((f) => f.type === 'removed_unsupported' && /single/.test(f.message)));
});
test('social history the patient says stays', () => {
  const n = note(); n.past_medical_history.social = 'Lives with her husband, non-smoker';
  socialGuard(n, T + ' I live with my husband. Do you smoke? No, never smoked.');
  assert.equal(n.past_medical_history.social, 'Lives with her husband, non-smoker');
});
test('"single dose" and plan advice are never touched', () => {
  const n = note(); n.past_medical_history.other = 'Single dose of ibuprofen taken\nAvoid smoking and alcohol'; n.assessment_and_plan[0].treatment_planned = 'Advice: avoid smoking, alcohol';
  socialGuard(n, T); assert.match(n.past_medical_history.other, /Single dose of ibuprofen/); assert.match(n.past_medical_history.other, /Avoid smoking/); assert.match(n.assessment_and_plan[0].treatment_planned, /avoid smoking/);
});
test('a drug the recording never names becomes its class and is flagged; a spoken or branded drug stays', () => {
  const n = note(); const r = unheardDrugs(n, T, [{ spoken: 'Crestor', generic: 'rosuvastatin' }]);
  assert.deepEqual(r.map((x) => x.drug), ['Pantoprazole']);
  assert.match(n.assessment_and_plan[0].treatment_planned, /^Start PPI before breakfast/);
  assert.match(n.past_medical_history.other, /Crestor \(rosuvastatin\)/);
  assert.ok(n.metadata.flags.some((f) => f.type === 'drug_not_heard' && f.severity === 'warning'));
});
test('a near spelling of a branded drug is written with the generic everywhere and its stale flag goes', () => {
  const n = note(); const r = unifySpellings(n, T, [{ spoken: 'Crestor', generic: 'rosuvastatin' }]);
  assert.equal(r[0].to, 'rosuvastatin'); assert.match(n.assessment_and_plan[2].treatment_planned, /^Refill Rosuvastatin; prescription faxed/);
  assert.ok(!n.metadata.flags.some((f) => f.type === 'medication_unverified'));
});
test('a test nobody mentioned is taken out of the plan; MRI (said) stays', () => {
  const n = note(); n.assessment_and_plan.push({ issue: 'Knee', investigations_planned: 'MRI if needed', treatment_planned: '' });
  const r = unheardTests(n, T);
  assert.equal(r.length, 1); assert.equal(n.assessment_and_plan[1].investigations_planned, 'Follow-up with anesthesiologist discussed');
  assert.equal(n.assessment_and_plan[4].investigations_planned, 'MRI if needed');
});
test('headings with nothing under them are dropped', () => {
  const n = note(); const r = dropEmptyHeadings(n);
  assert.deepEqual(r, ['Allergies:']); assert.ok(!/Allergies/.test(n.subjective.hpi_details)); assert.match(n.subjective.hpi_details, /Heartburn:/);
});
test('one stool test per problem, "poop" becomes stool, vaccine moves out of investigations without a duplicate', () => {
  const n = note(); const r = tidyPlanLines(n); const p = n.assessment_and_plan[3];
  assert.equal(r.poop, 1); assert.equal(r.duplicates, 1); assert.equal(r.vaccines, 1);
  assert.equal(p.investigations_planned, "FIT kit to be mailed to patient's home"); assert.equal(p.treatment_planned, 'Administer tetanus booster vaccination today');
});
test('screening status lines in Past Medical History go when the plan carries them, stay when it does not', () => {
  const n = note(); n.assessment_and_plan[3].investigations_planned = 'FIT kit'; n.assessment_and_plan[3].treatment_planned = 'Tetanus shot'; n.assessment_and_plan[3].issue = 'Preventive care mammogram pap';
  const r = dropCoveredScreeningStatus(n); assert.ok(r.some((x) => /Preventive care/.test(x))); assert.ok(r.some((x) => /Tetanus booster due/.test(x)));
  const m = note(); m.assessment_and_plan = [m.assessment_and_plan[0]]; assert.deepEqual(dropCoveredScreeningStatus(m), []);
});
test('all guards together never throw and keep a clean note unchanged', () => {
  const n = note(); const r = fidelityGuards(n, T, { refMeds: [{ spoken: 'Crestor', generic: 'rosuvastatin' }] });
  assert.ok(r.social && r.drugs && r.tests && r.headings && r.plan);
  const clean = { subjective: { reason_for_visit: 'Cough for 3 days' }, past_medical_history: { other: 'Medications: ibuprofen' }, assessment_and_plan: [{ issue: 'Cough', treatment_planned: 'Rest; fluids' }], metadata: {} };
  const before = JSON.stringify(clean); fidelityGuards(clean, 'Cough for three days. Take ibuprofen. Rest and fluids.'); assert.equal(JSON.stringify(clean), before);
  assert.doesNotThrow(() => fidelityGuards({}, 'x'));
});

import { dedupeMedList, dropDietRepeats, numberFlags, mriCheck } from '../src/orchestrator/fidelityGuards.js';
import { missingNumbers } from '../src/orchestrator/groundingAgent.js';
test('plan items that arrive on separate lines are tidied too (stool test once, vaccine out of investigations)', () => {
  const n = { assessment_and_plan: [{ issue: 'Preventive care', investigations_planned: "Stool test (FIT kit) to be mailed\ntetanus shot\npoop test kit", treatment_planned: 'Tetanus vaccine administered' }] };
  tidyPlanLines(n); assert.equal(n.assessment_and_plan[0].investigations_planned, 'Stool test (FIT kit) to be mailed'); assert.equal(n.assessment_and_plan[0].treatment_planned, 'Tetanus vaccine administered');
});
test('a referral already written in the investigations line is not repeated', () => {
  const n = { assessment_and_plan: [{ issue: 'Sleep apnea', investigations_planned: 'Referral to anesthesiologist for follow-up', treatment_planned: '', referrals: 'Anesthesiologist' }] };
  tidyPlanLines(n); assert.equal(n.assessment_and_plan[0].referrals, '');
});
test('a drug listed twice (brand with generic, then the generic) is listed once', () => {
  const n = { past_medical_history: { other: 'Medications: ibuprofen 400 milligram, Crestor (rosuvastatin), rosuvastatin, candesartan' } };
  dedupeMedList(n); assert.equal(n.past_medical_history.other, 'Medications: ibuprofen 400 milligram, Crestor (rosuvastatin), candesartan');
});
test('diet lines in Past Medical History that the story already tells are dropped; conditions stay', () => {
  const n = { subjective: { reason_for_visit: 'Drinks 2 cups of coffee daily\nDenies soda or Gatorade' }, past_medical_history: { other: 'Drinks approximately 2 cups of coffee daily; denies soda or Gatorade\nHypertension on candesartan' } };
  dropDietRepeats(n); assert.equal(n.past_medical_history.other, 'Hypertension on candesartan');
});
test('a dose or duration the recording never says is flagged, a spoken one is not', () => {
  const n = { assessment_and_plan: [{ issue: 'Reflux', treatment_planned: 'PPI before breakfast for 3-4 weeks; ibuprofen 400 mg at night; physiotherapy twice weekly' }], metadata: {} };
  const r = numberFlags(n, 'Take it before breakfast. I take four hundred milligram at night.', missingNumbers);
  assert.equal(r.length, 1); assert.match(n.metadata.flags[0].message, /3-4/);
});
test('MRI compatibility wording is flagged when the recording is unclear, not when it is explicit', () => {
  const n = { past_medical_history: { other: 'Implanted hardware may not be MRI compatible' }, metadata: {} };
  assert.equal(mriCheck(n, 'a device that may not be MRI comfortable').length, 1); assert.ok(n.metadata.flags[0].message.includes('operative record'));
  const m = { past_medical_history: { other: 'MRI compatible hardware' }, metadata: {} }; assert.equal(mriCheck(m, 'the hardware is MRI compatible').length, 0);
});
test('"lives alone" stays out when the recording only has the word "live" in noise; a dangling fragment is dropped with its test', () => {
  const n = { past_medical_history: { other: 'Lives alone\nHypertension' }, assessment_and_plan: [{ issue: 'Sleep apnea', investigations_planned: 'Consider sending for sleep study', treatment_planned: 'Refill Fexofenadine' }], objective: { examination: 'Left knee hardware, may not be MRI compatible' }, metadata: {} };
  socialGuard(n, 'Once you live. Oh, that is my house.'); assert.equal(n.past_medical_history.other, 'Hypertension');
  unheardTests(n, 'Maybe I should see the anesthesiologist.'); assert.equal(n.assessment_and_plan[0].investigations_planned, '');
  const d = unheardDrugs(n, 'Less than flexible. It helps.'); assert.equal(d[0].shown, 'antihistamine');
  assert.equal(mriCheck(n, 'may not be MRI comfortable').length, 1);
});
