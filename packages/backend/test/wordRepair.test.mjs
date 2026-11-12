import test from 'node:test';
import assert from 'node:assert/strict';
import { repairTarget, repairDrugNames, seriousLines, parseMajor, repairSeriousWords, repairWords } from '../src/orchestrator/wordRepair.js';

const lexicon = { set: new Set(['lyrica', 'metformin', 'protonix', ...Array.from({ length: 1200 }, (_, i) => 'filler' + i)]) };

test('repairTarget: one or two letters off, one candidate only', () => {
  assert.equal(repairTarget('Symbalta'), 'Cymbalta');
  assert.equal(repairTarget('Monjaro'), 'Mounjaro');
  assert.equal(repairTarget('Mexalt'), 'Maxalt');
  assert.equal(repairTarget('pre-Gablin'), 'Pregabalin');
  assert.equal(repairTarget('Deloxitine'), 'Duloxetine');
  assert.equal(repairTarget('Amopine'), null);         // amlodipine is 3 off: left as heard
  assert.equal(repairTarget('Lexina'), null);          // nothing close
  assert.equal(repairTarget('morning'), null);
});

test('repairDrugNames: fixes the garbled names everywhere, leaves rare real drugs and ambiguous ones', () => {
  const md = ['### Past Medical History', '- Medications: Symbalta, Lyrica, Amopine, Protopic', '', '### Assessment and Plan', '1. **Pain**', '   - Treatment planned:', '     - Started: Monjaro 2.5 mg weekly', '     - Continued: Symbalta 60 mg daily'].join('\n');
  const note = { past_medical_history: { other: 'Current medications: Symbalta, Lyrica' }, metadata: { flags: [] } };
  const r = repairDrugNames(md, 'she takes Symbalta and Monjaro', { lexicon, note });
  assert.match(r.md, /Medications: Cymbalta, Lyrica, Amopine, Protopic/);
  assert.match(r.md, /Started: Mounjaro 2\.5 mg/);
  assert.match(r.md, /Continued: Cymbalta 60 mg/);
  assert.deepEqual(r.fixes.map((f) => [f.from, f.to, f.places]), [['Symbalta', 'Cymbalta', 3], ['Monjaro', 'Mounjaro', 1]]);
  assert.equal(note.past_medical_history.other, 'Current medications: Cymbalta, Lyrica');
});

test('repairDrugNames: ordinary words and class names are not touched', () => {
  const md = '### Past Medical History\n- Medications: estrogen, probiotics, antibiotics, migraine';
  assert.equal(repairDrugNames(md, '', { lexicon }).md, md);
});

test('repairDrugNames: without the RxNorm list nothing changes', () => {
  const md = '### Past Medical History\n- Medications: Symbalta';
  assert.equal(repairDrugNames(md, '', { lexicon: { set: new Set(['a']) } }).md, md);
  assert.equal(repairDrugNames(md, '', {}).md, md);
});

test('seriousLines: bullets only, with the family', () => {
  const md = '### Past Medical History\n- Received chemotherapy yesterday\n- Hypertension\n\n### Assessment and Plan\n1. **Cancer follow-up**\n   - Referral to oncology';
  const s = seriousLines(md);
  assert.deepEqual(s.map((x) => x.line), ['Received chemotherapy yesterday']);
});

test('serious word the recording never mentions: the line is removed; negated lines stay', async () => {
  const md = '### Past Medical History\n- Received chemotherapy yesterday\n- No family history of cancer\n- Asthma';
  const r = await repairSeriousWords(md, 'we talked about your asthma and the puffer', {});
  assert.doesNotMatch(r.md, /chemotherapy/);
  assert.match(r.md, /No family history of cancer/);
  assert.match(r.md, /Asthma/);
  assert.equal(r.removed.length, 1);
});

test('serious word said in the recording: model labels, code checks the quote', async () => {
  const transcript = 'I was supposed to see him yesterday but I had cancer so I could not get there. When is your appointment now? Oh yesterday he canceled. I just got to call him and reschedule.';
  const md = '### Past Medical History\n- Hypothyroidism under care of Dr. Noor; missed appointment yesterday due to cancer';
  const llm = (v) => ({ generateContent: async () => JSON.stringify({ checks: [v] }) });
  const good = { n: 1, verdict: 'mishear', meant: 'cancel', quote: 'I had cancer so I could not get there' };
  const clean = await repairSeriousWords(md, transcript, { clean: true, getLlm: async () => llm(good) });
  assert.equal(clean.removed.length, 1); assert.doesNotMatch(clean.md, /cancer/);
  assert.match(clean.md, /- Hypothyroidism under care of Dr\. Noor$/m);   // only the wrong part goes, the true part stays
  const normal = await repairSeriousWords(md, transcript, { clean: false, getLlm: async () => llm(good) });
  assert.equal(normal.removed.length, 0); assert.equal(normal.flags.length, 1); assert.match(normal.md, /due to cancer/); assert.equal(normal.flags[0].type, 'word_check');
  // the model invents the quote: nothing happens
  const bad = await repairSeriousWords(md, transcript, { clean: true, getLlm: async () => llm({ ...good, quote: 'she had to cancel the cancer visit' }) });
  assert.equal(bad.removed.length, 0);
  // "meant" is a whole phrase, or a word the recording never says: the patient really said it, nothing happens
  assert.equal((await repairSeriousWords(md, transcript, { clean: true, getLlm: async () => llm({ ...good, meant: 'felt winded or exhausted' }) })).removed.length, 0);
  assert.equal((await repairSeriousWords(md, transcript, { clean: true, getLlm: async () => llm({ ...good, meant: 'counseling' }) })).removed.length, 0);
  assert.equal((await repairSeriousWords(md, transcript, { clean: true, getLlm: async () => llm({ ...good, meant: '' }) })).removed.length, 0);
  // the model says confirmed or unclear: nothing happens
  for (const verdict of ['confirmed', 'unclear']) assert.equal((await repairSeriousWords(md, transcript, { clean: true, getLlm: async () => llm({ ...good, verdict }) })).removed.length, 0);
});

test('a model that fails or is not available leaves the note alone; no model call without a candidate', async () => {
  const transcript = 'my mother had breast cancer and I am on tamoxifen';
  const md = '### Past Medical History\n- Mother had breast cancer';
  let calls = 0;
  const r = await repairSeriousWords(md, transcript, { clean: true, getLlm: async () => { calls++; throw new Error('down'); } });
  assert.equal(r.md, md); assert.equal(calls, 1);
  const none = await repairSeriousWords('### Subjective\n- Cough for 3 days', transcript, { getLlm: async () => { calls++; return {}; } });
  assert.equal(calls, 1); assert.equal(none.checked, 0);
});

test('"Mobility aids" is not AIDS; a real HIV line with no mention in the recording is', async () => {
  const md = '### Past Medical History\n- Mobility aids\n- HIV positive';
  const r = await repairSeriousWords(md, 'she uses a walker and her knee hurts', {});
  assert.match(r.md, /Mobility aids/); assert.doesNotMatch(r.md, /HIV/);
});

test('parseMajor: garbage in, nothing out', () => {
  assert.deepEqual(parseMajor('not json', [], 'x'), []);
});

test('repairWords: both parts, flags for the drug fix', async () => {
  const md = '### Past Medical History\n- Medications: Symbalta\n- Received chemotherapy yesterday';
  const r = await repairWords({ md, transcript: 'on Symbalta for pain', lexicon });
  assert.match(r.md, /Cymbalta/); assert.doesNotMatch(r.md, /chemotherapy/);
  assert.equal(r.flags.find((f) => f.type === 'drug_corrected').field, 'medications');
  assert.equal(r.meta.drugs.length, 1); assert.equal(r.meta.removed.length, 1);
});
