import test from 'node:test';
import assert from 'node:assert/strict';
import { dropIntentDuplicates, fixSplitTitles, gatherSubjective, noteTidy } from '../src/orchestrator/noteTidy.js';

const plan = (lines) => `### Assessment & Plan\n1. **Skin lesions**\n${lines.map((l) => `   - ${l}`).join('\n')}\n2. **Other**\n   - Referral to dermatologist\n`;

test('same-intent referral lines: the most complete one stays, the generic ones go (tiiir)', () => {
  const r = dropIntentDuplicates(plan(['Referral to Dr. Toth for dermatology evaluation of neck and congenital bleeding lesions', 'Referral to dermatologist', 'Dermatology referral request for skin lesions', 'Discussed cosmetic classification of neck lesions']));
  assert.equal(r.dropped.length, 2);
  assert.ok(r.md.includes('Dr. Toth')); assert.ok(r.md.includes('Discussed cosmetic')); assert.ok(r.md.split('Referral to dermatologist').length === 2);
  assert.ok(r.md.includes('2. **Other**\n   - Referral to dermatologist'), 'another problem block is never touched');
});
test('ENT lines (pjxur, buiuz) and ultrasound lines (ggn3c)', () => {
  assert.equal(dropIntentDuplicates(plan(['ENT referral to Dr. Ling (in addition to prior referral on waitlist with Dr. Hilal)', 'Ear, Nose, Throat specialist referral'])).dropped.length, 1);
  assert.equal(dropIntentDuplicates(plan(['Referral to ENT specialist locally for left-sided tinnitus', 'Referral to ear, nose, throat specialist'])).dropped.length, 1);
  assert.equal(dropIntentDuplicates(plan(['Arrange urgent abdominal ultrasound (preferred in Windham)', 'Arrange ultrasound for abdomen'])).dropped.length, 1);
});
test('different content, different doctors, hand-over and follow-up lines are never merged', () => {
  assert.equal(dropIntentDuplicates(plan(['Referral to Dr. Ling for ENT', 'Referral to Dr. Hilal for ENT'])).dropped.length, 0);
  assert.equal(dropIntentDuplicates(plan(['Arrange X-ray left knee', 'Requisitions for X-ray and ultrasound printed and provided'])).dropped.length, 0);
  assert.equal(dropIntentDuplicates(plan(['Arrange MRI inner ear', 'Follow-up by phone once MRI is booked'])).dropped.length, 0);
  assert.equal(dropIntentDuplicates(plan(['Referral to dermatologist for lesion on the neck', 'Referral to cardiology'])).dropped.length, 0);
  assert.equal(dropIntentDuplicates(plan(['Referral to dermatologist for neck lesion', 'Referral to dermatologist for back rash'])).dropped.length, 0);
});
test('a title split from its name is joined again', () => {
  const r = fixSplitTitles('### Objective\n- Audiometry: normal\n- Dr.\n- Albana walk-in clinic report reviewed: blood pressure elevated\n- Done');
  assert.equal(r.fixed, 1); assert.ok(r.md.includes('- Dr. Albana walk-in clinic report reviewed'));
  assert.equal(fixSplitTitles('- Dr. Smith saw her').fixed, 0);
});
const SUBJ = `### Subjective
- Follow-up left ear pulsatile tinnitus
- Constant pulsating sensation exacerbated following prior wax removal
- Aggravating: lying down, nasal spray, previous ear wax removal
- Baseline ear noise prior to recent exacerbation
- Denies vertigo

- Ear wax management
- Completed hearing test with normal results; has been applying oil to ear for wax

- Left-sided tingling present

### Past Medical History
- x`;
test('wax lines gather in the wax group; a labelled list line stays; nothing is lost', () => {
  const r = gatherSubjective(SUBJ, []);
  assert.equal(r.moved.length, 1);
  const wax = r.md.split('\n\n').find((b) => b.includes('- Ear wax management'));
  assert.ok(wax.includes('Constant pulsating sensation exacerbated following prior wax removal')); assert.ok(!wax.includes('Aggravating'));
  assert.equal(r.md.split('\n').filter((l) => l.trim()).sort().join('|'), SUBJ.split('\n').filter((l) => l.trim()).sort().join('|'));
});
test('medicine lines gather in the medicine group; no move when it would empty a group', () => {
  const md = `### Subjective\n- Dizziness for a week\n- Betahistine prescribed by walk-in clinic\n- Worse on standing\n- Slept badly\n\n- Betahistine not taken due to no vertigo\n- Betahistine may or may not help\n\n- Other\n\n### Objective\n- x`;
  const r = gatherSubjective(md, ['Betahistine 16 mg']); assert.equal(r.moved.length, 1);
  assert.ok(r.md.includes('- Betahistine may or may not help\n- Betahistine prescribed by walk-in clinic'));
  const two = `### Subjective\n- Betahistine prescribed\n- Dizzy\n\n- Betahistine not taken\n- Betahistine may help\n`;
  assert.equal(gatherSubjective(two, ['Betahistine']).moved.length, 0);
});
test('noteTidy is a no-op on a clean note and fails closed on junk', () => {
  const clean = '### Subjective\n- A\n- B\n\n### Assessment & Plan\n1. **X**\n   - Referral to ENT\n';
  assert.equal(noteTidy(clean).md, clean); assert.deepEqual(noteTidy(clean).meta, {});
  assert.equal(noteTidy('').md, ''); assert.equal(noteTidy(null).md, '');
});
