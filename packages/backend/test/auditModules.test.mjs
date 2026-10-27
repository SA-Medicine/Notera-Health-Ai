import test from 'node:test';
import assert from 'node:assert/strict';
import { doseRepair } from '../src/orchestrator/doseRepair.js';
import { supportedTexts } from '../src/orchestrator/groundFacts.js';
import { collectParts } from '../src/orchestrator/groundingAgent.js';

const F = (o) => ({ id: 'F001', type: 'medication', text: '', importance: 'major', confidence: 0.9, medication: '', medication_status: '', dose: '', frequency: '', value: '', unit: '', negative: false, render_required: true, quote: 'q', grounded: true, ...o });
const planNote = (text) => ({ metadata: {}, subjective: {}, past_medical_history: {}, objective: {}, assessment_and_plan: [{ issue: 'Fibromyalgia', diagnosis: '', assessment: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: text, referrals: '' }] });

test('dose repair: an amount the recording never says is replaced by the one the graph holds for that drug; anything uncertain is left alone', () => {
  const tx = 'So you are on Cymbalta. Yes. And that is sixteen milligrams once a day? Yes.';
  const n1 = planNote('Continue Cymbalta (duloxetine) 60 mg once daily'); const r = doseRepair(n1, tx, [F({ medication: 'Cymbalta', dose: '16 mg' })]);
  assert.equal(r.fixed.length, 1); assert.match(n1.assessment_and_plan[0].treatment_planned, /16 mg/); assert.ok(n1.metadata.flags.some((f) => f.type === 'dose_corrected'));
  const n2 = planNote('Continue Cymbalta 60 mg once daily'); assert.equal(doseRepair(n2, tx, [F({ medication: 'Cymbalta', dose: '16 mg' }), F({ id: 'F002', medication: 'Cymbalta', dose: '30 mg' })]).fixed.length, 0, 'two doses were said: not certain');
  const n3 = planNote('Continue Cymbalta 16 mg once daily'); assert.equal(doseRepair(n3, tx, [F({ medication: 'Cymbalta', dose: '16 mg' })]).fixed.length, 0, 'already right');
});
test('graph support: a plan line that states an action is supported only by a fact that carries that action; a negated line needs a negated fact', () => {
  const note = planNote('Continue Cymbalta 16 mg once daily'); const parts = collectParts(note);
  const taking = F({ medication: 'Cymbalta', dose: '16 mg', text: 'Cymbalta 16 mg once a day', quote: 'you are on Cymbalta sixteen milligrams once a day', medication_status: 'active' });
  assert.equal(supportedTexts(parts, [taking]).size, 0, 'the patient takes it: that does not say the doctor continues it');
  const cont = F({ ...taking, text: 'Continue Cymbalta 16 mg once a day', quote: 'we will continue the Cymbalta sixteen milligrams once a day' });
  assert.equal(supportedTexts(parts, [cont]).size, 1);
});
