import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLexicon, nearest, spokenVariants, drugsInNote, doseOk, checkDrugs } from '../src/orchestrator/drugCheck.js';

const NAMES = ['atacand', 'candesartan', 'amlodipine', 'lyrica', 'pregabalin', 'seroquel', 'naproxen', 'tylenol', 'acetaminophen', 'cefuroxime', 'flomax'];
const lex = buildLexicon(NAMES);
const MD = '### Past Medical History\n- Medications: cand 8 milligrams twice a day, amlodipine 200 mg daily\n\n### Assessment & Plan\n1. **Hypertension**\n   - Treatment planned:\n     - Changed: Atacand 16 mg every morning\n     - Continued: Amlodipine 5 mg daily\n2. **Rash**\n   - Treatment planned: Start cefuroxim 250 mg twice daily';
const TX = 'Instead of this at a cand, you are only 8 milligrams twice a day. Amlodipine 5. I will give you cefuroxime 250 twice a day.';

test('drug names are read from the Medications line and the treatment items, cut before the dose', () => {
  assert.deepEqual(drugsInNote(MD).map((d) => d.term), ['cand', 'amlodipine', 'Atacand', 'cefuroxim']);
});
test('a misheard name is matched through what was said around it ("at a cand" -> atacand) or by spelling', () => {
  assert.ok(spokenVariants('cand', TX).includes('at a cand'));
  assert.equal(nearest(lex, 'at a cand').name, 'atacand'); assert.equal(nearest(lex, 'cefuroxim').name, 'cefuroxime'); assert.equal(nearest(lex, 'zzzz'), null);
});
test('a dose is fine when the drug is sold in it or two to four tablets of it', () => {
  assert.equal(doseOk(10, 'mg', ['2.5 mg', '5 mg', '10 mg']), true); assert.equal(doseOk(20, 'mg', ['5 mg', '10 mg']), true); assert.equal(doseOk(200, 'mg', ['2.5 mg', '5 mg', '10 mg']), false); assert.equal(doseOk(7, 'mg', []), true);
});
test('the whole check: unknown names get a one-click suggestion, impossible doses are flagged, nothing in the note changes', async () => {
  const fetchImpl = async (url) => ({ ok: true, json: async () => (/rxcui\.json\?name=amlodipine/i.test(url) ? { idGroup: { rxnormId: ['17767'] } } : /related/.test(url) ? { relatedGroup: { conceptGroup: [{ conceptProperties: [{ name: 'amlodipine 2.5 MG Oral Tablet' }, { name: 'amlodipine 5 MG Oral Tablet' }, { name: 'amlodipine 10 MG Oral Tablet' }] }] } } : {}) });
  const r = await checkDrugs(MD, TX, { lexicon: lex, fetchImpl, patientMeds: [] });
  const by = Object.fromEntries(r.review.map((x) => [x.name, x]));
  assert.equal(by.cand.verified, false); assert.equal(by.cand.suggestion, 'Atacand'); assert.equal(by.cefuroxim.suggestion, 'Cefuroxime');
  assert.equal(by.amlodipine.doseOk, false); assert.equal(by.amlodipine.dose, '200 mg');
  const msgs = r.flags.map((f) => f.message); assert.ok(msgs.some((m) => /^Heard "cand" .* had written "Atacand"/.test(m))); assert.ok(msgs.some((m) => /amlodipine is not sold as 200 mg/i.test(m)));
});
test('the patient\'s own medication list (from the EHR) is tried first', async () => {
  const r = await checkDrugs('- Medications: sera quell 50 mg', 'she takes sera quell at night', { lexicon: lex, patientMeds: ['Seroquel 50 mg'], fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(r.review[0].suggestion, 'Seroquel 50 mg'.split(' ')[0]); assert.match(r.flags[0].message, /patient's medication list/);
});
