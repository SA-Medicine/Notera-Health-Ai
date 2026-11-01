// node --test test/noteSafety.test.mjs   (made-up visits, no patient data)
import test from 'node:test';
import assert from 'node:assert/strict';
import { safetyPass } from '../src/orchestrator/noteSafety.js';
import { strictPlan } from '../src/orchestrator/planStrict.js';
import { socialGuard } from '../src/orchestrator/fidelityGuards.js';
import { flagUngroundedNumbers } from '../src/validation/upgrades.js';

const STOMACH = 'So you are sixteen. I sent you to the stomach doctor for the belching and reflux. She gave you Pravachol thirty milligrams in the morning and a high dose vitamin D. Do you take the stomach pill? Yes. I heard it can lower bone mass. Take it for three months, then break for two weeks, then go back. And you do not drink or drink alco-- smoke? No. You live with your mother? Yeah. Anything else? No.';

test('a lost negation is restored: the social guard keeps "Denies" and the safety pass repairs a bare "Smoking"', () => {
  const note = { past_medical_history: { social: 'Denies alcohol use and smoking' }, subjective: {}, objective: {}, assessment_and_plan: [] };
  socialGuard(note, 'Do you smoke? No. Anything else? No.');
  assert.match(note.past_medical_history.social, /^Denies smoking/i);   // alcohol clause removed when the recording has no alcohol question, the verb stays with smoking
  const note2 = { past_medical_history: { social: 'Denies alcohol use and smoking' }, subjective: {}, objective: {}, assessment_and_plan: [] };
  socialGuard(note2, 'Do you drink alcohol? No. Do you smoke? No.');
  assert.equal(note2.past_medical_history.social, 'Denies alcohol use and smoking');
  const md = '### Subjective\n- Cough\n\n### Past Medical History\n- Lives with mother, smoking\n\n### Objective\n- Deferred\n\n### Assessment & Plan\n1. **Cough**\n   - Rest\n';
  const r = safetyPass(md, STOMACH, () => {});
  assert.match(r.md, /Lives with mother, Denies smoking/);
  assert.ok(r.flags.some((f) => f.type === 'social_status_restored'));
  const r2 = safetyPass(md, 'x'.repeat(250) + ' The weather is fine today and we talked about school.', () => {});
  assert.match(r2.md, /Smoking status not clear/);
});

test('an unheard drug takes the heard drug with the same dose, a statin without cholesterol context is flagged and loses its generic label', () => {
  const md = '### Subjective\n- Belching\n\n### Past Medical History\n- Reflux\n\n### Objective\n- Deferred\n\n### Assessment & Plan\n1. **Reflux**\n   - Continue Pravachol (pravastatin) 30 milligrams in the morning\n   - Continue Prevacid 30 mg for at least 3 months, then break\n2. **Vitamin D deficiency**\n   - High dose vitamin D\n';
  const r = safetyPass(md, STOMACH, () => {});
  assert.ok(!/Prevacid/.test(r.md));
  assert.ok(!/pravastatin/i.test(r.md));
  assert.match(r.md, /\*\*Vitamin D\*\*/);
  for (const t of ['drug_not_heard', 'drug_context', 'diagnosis_not_said']) assert.ok(r.flags.some((f) => f.type === t), t);
  assert.ok(/stomach-acid/.test(r.flags.find((f) => f.type === 'drug_context').message));
  const ok = safetyPass(md.replace('Reflux', 'Cholesterol'), STOMACH + ' Your cholesterol is high.', () => {});
  assert.ok(!ok.flags.some((f) => f.type === 'drug_context'));
});

test('plan lines the recording does not support are dropped or softened, repeats merged', () => {
  const T = 'Your cholesterol and blood pressure are high at the clinic, take the pill every day. Your sugar is borderline. I will ask the specialist to see you, I will ask him if anything needs to be monitored or not. We will check again in three months. Do you want a dietician? I have my daughter. You are not taking Lipitor because of leg pain. Take it at least four times a week.';
  const md = '### Subjective\n- Missing blood pressure pill\n- Stopped Lipitor due to leg pain\n\n### Past Medical History\n- Medications: Lipitor (atorvastatin) four times a week, blood pressure pill every day.\n\n### Objective\n- Bloods: haemoglobin normal, sugar borderline\n- sugar: borderline\n- Previous evaluation by Dr. Smith 10 years ago\n\n### Assessment & Plan\n1. **Sugar**\n   - Repeat fasting blood glucose and HbA1c in 3 months\n   - Repeat blood work in 3 months\n   - Declined dietitian referral as daughter helps\n   - Consider seeing a dietician for sugar control\n   - Monitor blood pressure at home\n2. **Neutrophils**\n   - Arrange Neutrophil count monitoring\n   - Referral to specialist clinic sent\n   - Referral to specialist clinic run by Dr. Saad\n3. **Cholesterol**\n   - Non-compliant with statin therapy\n   - Continue Lipitor daily (at least four times weekly)\n';
  const r = safetyPass(md, T, () => {});
  const out = strictPlan(r.md, T, () => {});
  assert.ok(!/HbA1c|at home|Arrange Neutrophil|Consider seeing/.test(out), out);
  assert.equal((out.match(/Referral to specialist clinic/g) || []).length, 1);
  assert.match(out, /Referral to specialist clinic run by Dr\. Saad/);
  assert.ok(!/ sent/.test(out));
  assert.match(out, /Lipitor \(atorvastatin\) four times a week \(not currently taking\)/);
  assert.match(out, /Resume Lipitor daily/);
  assert.ok(/Previous evaluation by Dr\. Smith[^\n]*\n\n### Objective/.test(out), out);   // moved into Past Medical History
  assert.ok(!/- sugar: borderline/.test(out));
  assert.ok(r.flags.some((f) => f.type === 'frequency_conflict'));
});

test('without a recording only the structural steps run, and a clean note is returned unchanged', () => {
  const md = '### Subjective\n- Cough\n\n### Past Medical History\n- Asthma\n\n### Objective\n- Chest clear\n\n### Assessment & Plan\n1. **Cough**\n   - Rest\n';
  assert.equal(safetyPass(md, '', () => {}).md, md);
  assert.equal(safetyPass(md, STOMACH, () => {}).md, md);
});

test('a blood pressure said as "hundred and sixty over hundred" is grounded', () => {
  const T = 'Your pressure is high. Hundred and sixty over hundred. Then one forty-nine over eighty-two. And one hundred and forty-three over eighty-eight.';
  const note = { objective: { vital_signs: 'BP 160/100 mmHg\nBP 149/82 mmHg\nBP 143/88 mmHg' } };
  const r = flagUngroundedNumbers(note, T);
  assert.equal(r.flags.length, 0);
});

test('a drug the patient is not taking is resumed, not continued, even when the plan line has no cue word', () => {
  const T = 'x'.repeat(220) + ' You stopped the Lipitor because of leg pain. Start it again.';
  const md = '### Subjective\n- Stopped Lipitor due to leg pain\n\n### Past Medical History\n- Medications: Lipitor 20 mg daily.\n\n### Objective\n- Deferred\n\n### Assessment & Plan\n1. **Cholesterol**\n   - Continue Lipitor 20 mg daily\n';
  const r = safetyPass(md, T, () => {});
  assert.match(r.md, /Resume Lipitor 20 mg daily/);
  assert.match(r.md, /Lipitor 20 mg daily \(not currently taking\)/);
});

test('a test nobody named is also taken out of the Follow-up item', () => {
  const T = 'x'.repeat(220) + ' We will check your sugar again in three months.';
  const md = '### Subjective\n- Sugar\n\n### Past Medical History\n- None\n\n### Objective\n- Deferred\n\n### Assessment & Plan\n1. **Sugar**\n   - Diet advice\n2. **Follow-up**\n   - Recheck blood glucose / HbA1c in 3 months\n';
  const r = safetyPass(md, T, () => {});
  assert.ok(!/HbA1c/.test(r.md), r.md);
  assert.match(r.md, /Recheck blood glucose in 3 months/);
  assert.ok(r.flags.some((f) => f.type === 'test_not_said'));
});
