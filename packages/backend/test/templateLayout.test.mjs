import test from 'node:test';
import assert from 'node:assert/strict';
import { trimRepeats } from '../src/orchestrator/repeatTrim.js';
import { toTemplateFormat } from '../src/orchestrator/templateFormat.js';

const NOTE = `### Subjective
**Presenting Complaint:**
- Follow-up of abdominal discomfort
- Requisition for breast ultrasound and mammogram

**Diet:**
- Learning not to put sugar in coffee

### Past Medical History
- IBS
- Medications: Pravacit 30 mg every morning

### Objective
**Vital Signs**
- BP 143/88 mmHg (clinic)

### Assessment & Plan
1. **Abdominal discomfort**
   - Diagnosis: Abdominal discomfort
   - Investigations planned: Celiac serology
   - Treatment planned:
     - Continued: Pravacit 30 mg every morning
     - Stopped: aspirin
   - Referrals: ramp clinic run by Dr. Sad
   - Advice: Drink fluids; Rest
   - Follow-up: 30 days; Return to clinic in 30 days
2. **Breast cysts**
   - Treatment planned: Requisitions printed and provided for bilateral breast ultrasound and mammogram
`;

test('repeat trim: repeats inside a line, and a plan action told as story, but never a line with a number the plan lacks', () => {
  const r = trimRepeats(NOTE);
  assert.match(r.md, /Follow-up: Return to clinic in 30 days/);
  assert.ok(!/30 days; Return/.test(r.md));
  assert.ok(!/- Requisition for breast ultrasound/.test(r.md.split('### Past')[0]));
  assert.equal(r.removed.length, 2);
  const keep = trimRepeats('### Subjective\n- Scheduled for MRI on Friday 14th\n\n### Assessment & Plan\n1. **X**\n   - Treatment planned: Proceed with scheduled MRI on Friday\n');
  assert.equal(keep.removed.length, 0);   // 14th is not in the plan line
});

test('repeat trim: past medical history and objective are never touched; a pharmacy line stays', () => {
  const md = '### Past Medical History\n- Osteoporosis on risedronate monthly\n\n### Subjective\n- Osteoporosis on risedronate monthly\n- Pharmacy: Shoppers Drug Mart, faxed prescriptions\n\n### Assessment & Plan\n1. **A**\n   - Faxed prescriptions to Shoppers Drug Mart\n';
  assert.equal(trimRepeats(md).removed.length, 0);
});

test('template layout: flat lists, no labels, verbs kept, one Follow-up item at the end', () => {
  const t = toTemplateFormat(NOTE);
  assert.ok(!/\*\*(Presenting Complaint|Diet|Vital Signs):/.test(t) && !/^\*\*(Presenting|Diet|Vital)/m.test(t));
  assert.ok(!/(Treatment planned|Investigations planned|Referrals|Advice|Started|Continued|Stopped):/.test(t));
  assert.ok(!/Diagnosis:/.test(t), 'a Diagnosis line equal to the title goes');
  assert.match(t, /- Continue Pravacit 30 mg every morning/);
  assert.match(t, /- Stop aspirin/);
  assert.match(t, /- Referral to ramp clinic run by Dr\. Sad/);
  assert.match(t, /- Arrange Celiac serology/);
  assert.match(t, /- Drink fluids\n   - Rest/);
  assert.match(t, /3\. \*\*Follow-up\*\*\n   - 30 days\n   - Return to clinic in 30 days/);
  assert.equal((t.match(/^\d+\. /gm) || []).length, 3);
});

test('template layout: empty input and a note without a plan', () => {
  assert.equal(toTemplateFormat(''), '');
  assert.equal(toTemplateFormat('### Subjective\n- One line'), '### Subjective\n- One line');
});

test('template layout: tidy pass (empty brackets, contained lines, Resume after a stopped drug, duplicate empty problem)', () => {
  const md = '### Assessment & Plan\n1. **Elevated cholesterol**\n   - Highest ever\n   - Stopped taking it due to leg pain\n   - Continued: Lipitor 20 mg daily\n   - Referrals: ramp clinic ()\n   - Advice: Blood pressure pill; Continue Blood pressure pill every day\n2. **Hypercholesterolemia**\n3. **Anxiety**\n';
  const t = toTemplateFormat(md);
  assert.match(t, /- Resume Lipitor 20 mg daily/);
  assert.ok(!/\(\)/.test(t));
  assert.ok(!/- Blood pressure pill\n/.test(t) && /Blood pressure pill every day/.test(t));
  assert.ok(!/Hypercholesterolemia/.test(t));
  assert.match(t, /\*\*Anxiety\*\*/);
  assert.match(toTemplateFormat('### Assessment & Plan\n1. **A**\n   - Stopped: aspirin\n   - Continued: Lipitor 20 mg\n'), /Continue Lipitor 20 mg/);
});
