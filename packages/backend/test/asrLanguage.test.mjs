// node --test test/asrLanguage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeWithChain, validateSettings, resetHealth } from '../src/asr/engines.js';
import { normalizeLang, isEnglish, englishPromptFor, originalPromptFor, settingsForLang, languageMeta } from '../src/asr/language.js';
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

test('Hindi: Gemini only, the English working transcript plus the original-script copy, both asked in parallel', async () => {
  resetHealth(); const calls = [];
  const gemini = async (p, engine, l, o) => { calls.push({ engine, prompt: o?.prompt || '' }); return o.prompt.includes('Devanagari') ? { text: 'मुझे दो दिन से सीने में दर्द है, Metformin 500 mg' } : { text: 'I have had chest pain for two days, Metformin 500 mg', windows: 1, durationSeconds: 20, failedWindows: 0 }; };
  const r = await transcribeWithChain(SPEECH, { language: 'hi', settings: S({ crossCheck: true }), runners: { v2: async () => { throw new Error('Chirp is English-pinned'); }, v1: async () => { throw new Error('no'); }, gemini } });
  assert.equal(r.engine, 'gemini-2.5-flash'); assert.match(r.text, /chest pain for two days/); assert.match(r.original, /सीने में दर्द/);
  assert.equal(calls.length, 2); assert.ok(calls.some((c) => /Hindi/.test(c.prompt) && /write all of it in English/.test(c.prompt)) && calls.some((c) => /Devanagari/.test(c.prompt)));
  assert.deepEqual(languageMeta('hi', r.original), { language: 'hi', translated: true, original: r.original });
});

test('Punjabi / mixed: the right script is asked for; a failing original-copy call never fails the visit', async () => {
  resetHealth(); assert.match(originalPromptFor('pa'), /Gurmukhi/); assert.match(originalPromptFor('auto'), /Devanagari.*Gurmukhi/); assert.match(englishPromptFor('pa'), /Punjabi/);
  const gemini = async (p, engine, l, o) => { if (/Gurmukhi/.test(o.prompt)) throw new Error('original failed'); return { text: 'Blood sugar was 8.2 this morning', windows: 1, durationSeconds: 20, failedWindows: 0 }; };
  const r = await transcribeWithChain(SPEECH, { language: 'pa', settings: S(), runners: { v2: async () => ({ text: 'no' }), v1: async () => ({ text: 'no' }), gemini } });
  assert.equal(r.text, 'Blood sugar was 8.2 this morning'); assert.equal(r.original, undefined); assert.deepEqual(languageMeta('pa', ''), { language: 'pa', translated: true });
});

test('non-English chain settings: Gemini first, a second Gemini model as fallback, no English-only second opinion', () => {
  const s = settingsForLang(S({ crossCheck: true }), 'hi'); assert.equal(s.primary, 'gemini-2.5-flash'); assert.deepEqual(s.fallbacks, ['gemini-3.7-flash']); assert.equal(s.crossCheck, false);
});

test('the new prompts are cleaned too if the engine ever echoes them back', () => {
  for (const p of [englishPromptFor('hi'), originalPromptFor('pa')]) assert.equal(stripPromptLeak('I have a cough. ' + p).replace(/\s+/g, ' ').includes('word for word'), false);
});
