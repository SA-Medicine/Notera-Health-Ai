// node --test test/asrLanguage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeWithChain, validateSettings, resetHealth } from '../src/asr/engines.js';
import { normalizeLang, isEnglish, englishPromptFor, originalSource, settingsForLang, languageMeta, looksRomanisedIndic } from '../src/asr/language.js';
import { stripPromptLeak } from '../src/asr/promptLeak.js';

const pcm = (seconds, amp) => { const b = Buffer.alloc(seconds * 32000); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(Math.round(Math.sin(i / 8) * amp), i); return b; };
const SPEECH = pcm(20, 4000);
const S = (o = {}) => validateSettings({ primary: 'chirp_2', fallbacks: ['latest_long'], crossCheck: false, ...o });

test('language codes: anything unknown is English, the known ones are normalised', () => {
  for (const v of [undefined, null, '', 'en', 'EN', 'en-US', 'fr', 'xx', 'english']) assert.equal(normalizeLang(v), 'en');
  assert.equal(normalizeLang('hi'), 'hi'); assert.equal(normalizeLang('hi-IN'), 'hi'); assert.equal(normalizeLang('PA'), 'pa'); assert.equal(normalizeLang('Punjabi'), 'pa'); assert.equal(normalizeLang('auto'), 'auto'); assert.equal(normalizeLang('mixed'), 'auto');
  assert.ok(isEnglish(undefined) && isEnglish('en') && !isEnglish('hi'));
});

test('English: settings, prompts and response are exactly what they were (no original, no language fields)', async () => {
  resetHealth(); const base = S(); assert.equal(settingsForLang(base, 'en'), base, 'the same object');
  const seen = []; const r = await transcribeWithChain(SPEECH, { settings: base, runners: { v2: async (p, e, l, o) => { seen.push(o); return { text: 'chest pain for two days', windows: 1, durationSeconds: 20, failedWindows: 0 }; }, v1: async () => ({ text: 'x' }), gemini: async () => { throw new Error('must not be called'); } } });
  assert.equal(r.text, 'chest pain for two days'); assert.equal(r.engine, 'chirp_2'); assert.equal(r.original, undefined); assert.deepEqual(seen, [undefined]); assert.deepEqual(languageMeta('en', 'x'), {});
});

test('Hindi: Gemini writes the English working transcript, Chirp 3 (hi-IN) writes the original-script copy, both at the same time', async () => {
  resetHealth(); const calls = [];
  const gemini = async (p, engine, l, o) => { calls.push({ kind: 'gemini', engine, prompt: o?.prompt || '' }); return { text: 'I have had chest pain for two days, Metformin 500 mg', windows: 1, durationSeconds: 20, failedWindows: 0 }; };
  const v2 = async (p, engine, l, o) => { calls.push({ kind: 'v2', engine, lang: o?.languageCode }); return { text: 'मुझे दो दिन से सीने में दर्द है, मेटफॉर्मिन 500 मिलीग्राम' }; };
  const r = await transcribeWithChain(SPEECH, { language: 'hi', settings: S({ crossCheck: true }), runners: { v2, v1: async () => { throw new Error('no'); }, gemini } });
  assert.equal(r.engine, 'gemini-2.5-flash'); assert.match(r.text, /chest pain for two days/); assert.match(r.original, /सीने में दर्द/);
  assert.deepEqual(calls.map((c) => c.kind).sort(), ['gemini', 'v2']); assert.equal(calls.find((c) => c.kind === 'v2').engine, 'chirp_3'); assert.equal(calls.find((c) => c.kind === 'v2').lang, 'hi-IN');
  assert.match(calls.find((c) => c.kind === 'gemini').prompt, /write all of it in English.*Hindi/);
  assert.deepEqual(languageMeta('hi', r.original), { language: 'hi', translated: true, original: r.original });
});

test('Punjabi and mixed visits: English transcript only (no model writes Punjabi reliably); a failing Hindi original never fails the visit', async () => {
  resetHealth(); assert.equal(originalSource('pa'), null); assert.equal(originalSource('auto'), null); assert.equal(originalSource('en'), null); assert.deepEqual(originalSource('hi'), { engine: 'chirp_3', languageCode: 'hi-IN' });
  assert.match(englishPromptFor('pa'), /Punjabi/); assert.match(englishPromptFor('auto'), /Hindi or Punjabi/);
  let v2calls = 0; const gemini = async () => ({ text: 'Blood sugar was 8.2 this morning', windows: 1, durationSeconds: 20, failedWindows: 0 });
  const pa = await transcribeWithChain(SPEECH, { language: 'pa', settings: S(), runners: { v2: async () => { v2calls++; return { text: 'no' }; }, v1: async () => ({ text: 'no' }), gemini } });
  assert.equal(pa.text, 'Blood sugar was 8.2 this morning'); assert.equal(pa.original, undefined); assert.equal(v2calls, 0, 'no original call for Punjabi'); assert.deepEqual(languageMeta('pa', ''), { language: 'pa', translated: true });
  const hi = await transcribeWithChain(SPEECH, { language: 'hi', settings: S(), runners: { v2: async () => { throw new Error('chirp down'); }, v1: async () => ({ text: 'no' }), gemini } });
  assert.equal(hi.text, 'Blood sugar was 8.2 this morning'); assert.equal(hi.original, undefined);
});

test('non-English chain settings: Gemini first, a second Gemini model as fallback, no English-only second opinion', () => {
  const s = settingsForLang(S({ crossCheck: true }), 'hi'); assert.equal(s.primary, 'gemini-2.5-flash'); assert.deepEqual(s.fallbacks, ['gemini-3.7-flash']); assert.equal(s.crossCheck, false);
});

test('the new prompts are cleaned too if the engine ever echoes them back', () => {
  for (const p of [englishPromptFor('hi'), englishPromptFor('pa'), englishPromptFor('auto')]) assert.equal(stripPromptLeak('I have a cough. ' + p).replace(/\s+/g, ' ').includes('word for word'), false);
});

test('transliterated Hindi is told apart from English (and from English with a Hindi word or a name in it)', async () => {
  assert.equal(looksRomanisedIndic('Doctor, aapko kya takleef hai? Mareez, mujhe pichle teen din se seene mein dard hai aur saans foolti hai. Bukhar nahi hai. Main Metformin 500 mg din mein do baar leta hoon.'), true);
  assert.equal(looksRomanisedIndic('Doctor, what is your problem? Patient, I have had chest pain for the last three days and shortness of breath. I take Metformin 500 mg twice a day.'), false);
  assert.equal(looksRomanisedIndic('The patient is called Hardeep Singh and takes Metformin; her mother makes roti and dal every day, and she has no pain at all today.'), false);
  assert.equal(looksRomanisedIndic('short text'), false);
  // the chain refuses a romanised answer from the first Gemini model and uses the second one
  resetHealth(); let n = 0;
  const gemini = async () => ({ text: ++n === 1 ? 'Doctor aapko kya takleef hai. Mujhe teen din se seene mein dard hai aur bukhar nahi hai. Main Metformin leta hoon din mein do baar.' : 'Doctor, what is the problem? I have had chest pain for three days and no fever. I take Metformin twice a day.', windows: 1, durationSeconds: 20, failedWindows: 0 });
  const r = await transcribeWithChain(SPEECH, { language: 'hi', settings: S(), runners: { v2: async () => ({ text: '' }), v1: async () => ({ text: 'x' }), gemini } });
  assert.equal(r.engine, 'gemini-3.7-flash'); assert.match(r.text, /chest pain for three days/); assert.equal(r.fellBack, true);
  // English visits are never judged this way
  const en = await transcribeWithChain(SPEECH, { language: 'en', settings: S(), runners: { v2: async () => ({ text: 'Doctor aapko kya takleef hai. Mujhe teen din se seene mein dard hai aur bukhar nahi hai. Main Metformin leta hoon din mein do baar.' }), v1: async () => ({ text: 'x' }), gemini } });
  assert.equal(en.engine, 'chirp_2');
});
