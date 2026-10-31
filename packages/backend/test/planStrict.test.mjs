import test from 'node:test';
import assert from 'node:assert/strict';
import { strictPlan, isDrugLine, fixVerb } from '../src/orchestrator/planStrict.js';

const TR = "You stopped taking the Lipitor because of the leg pain, right? Yes. I'm going to give you a prescription for 20 milligrams of Prozac. Your Pantoprazole, you are still taking it daily.";

test('drug lines: a dose or a frequency, never a plain sentence', () => {
  assert.ok(isDrugLine('Lipitor every day') && isDrugLine('Start Prozac 20 mg') && isDrugLine('Cyclobenzaprine 10 mg, one tablet three times a day'));
  assert.ok(!isDrugLine('Borderline in clinic, elevated at home off medication') && !isDrugLine('Sugar pills will be needed if levels rise') && !isDrugLine('Current medication two twice a day'));
});

test('verbs follow the transcript: Resume after a stopped drug, Start for a new prescription, Continue stays when the patient still takes it', () => {
  assert.equal(fixVerb('Continue Lipitor 20 mg daily', TR), 'Resume Lipitor 20 mg daily');
  assert.equal(fixVerb('Continue Prozac 20 mg', TR), 'Start Prozac 20 mg');
  assert.equal(fixVerb('Continue Pantoprazole 40 mg daily', TR), 'Continue Pantoprazole 40 mg daily');
  assert.equal(fixVerb('Stop Prozac 20 mg', TR), 'Stop Prozac 20 mg');
  assert.equal(fixVerb('Avoid alcohol', TR), 'Avoid alcohol');
});

test('plan: drug-named problems fold into one, empty duplicates go, two vaccines are never merged, a note with nothing to fix is returned as it is', () => {
  const md = '### Objective\n- BP: 140/90\n- BP: 160/100 (patient\'s home reading)\n\n### Assessment & Plan\n1. **Skin tag**\n   - Excised\n   - Start Prozac 20 mg\n   - Start Lexapro 10 mg\n2. **Prozac**\n3. **Immunizations**\n   - Influenza vaccine administered, left arm (given today)\n   - Pneumococcal vaccine administered, left arm (given today)\n4. **Skin tag**\n5. **Follow-up**\n   - 3 months';
  const out = strictPlan(md, TR);
  assert.ok(!/home reading/.test(out));
  assert.match(out, /\*\*Medication prescriptions\*\*\n {3}- Start Prozac 20 mg\n {3}- Start Lexapro 10 mg/);
  assert.match(out, /Influenza vaccine/); assert.match(out, /Pneumococcal vaccine/);
  assert.ok(!/\n4\. \*\*Skin tag\*\*/.test(out));
  assert.match(out, /\n\d\. \*\*Follow-up\*\*\n {3}- 3 months$/);
  const clean = '### Assessment & Plan\n1. **A**\n   - Repeat bloods\n2. **Follow-up**\n   - 3 months';
  assert.equal(strictPlan(clean, TR), clean);
});
