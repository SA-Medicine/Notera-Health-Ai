'use strict';
// Visit language for speech-to-text: English (the default and the only path that existed), Hindi, Punjabi, or "auto" (the speakers mix them).
//
// The note pipeline is English and locked, so the WORKING transcript is always English. For Hindi / Punjabi / auto visits Gemini hears the audio and writes the English
// transcript directly (the same call as today, with a prompt that knows the speakers switch languages mid-sentence), and, for Hindi, a Chirp 3 call writes the ORIGINAL words in their
// own script (Hindi only, see originalSource) so the doctor can check what was really said. The English path is untouched.
//
// Google STT / Chirp are pinned to English (en-US) and the a-z plausibility guards only fit English, so a non-English visit uses Gemini only (a second Gemini model as
// fallback) and no English-only second opinion. The prompts reuse the sentences promptLeak.js already removes if the model ever echoes them.

const MAP = { en: 'en', 'en-us': 'en', 'en-in': 'en', english: 'en', hi: 'hi', 'hi-in': 'hi', hindi: 'hi', pa: 'pa', 'pa-in': 'pa', punjabi: 'pa', auto: 'auto', mixed: 'auto' };
/** Any input (query string, saved value) -> 'en' | 'hi' | 'pa' | 'auto'. Anything unknown is English. */
export function normalizeLang(v) { return MAP[String(v ?? '').toLowerCase().trim()] || 'en'; }
export const isEnglish = (l) => normalizeLang(l) === 'en';

const NAMES = { hi: 'Hindi', pa: 'Punjabi', auto: 'Hindi or Punjabi' };

/** Prompt for the working (English) transcript of a Hindi / Punjabi / mixed visit. */
export function englishPromptFor(lang) {
  const n = NAMES[normalizeLang(lang)]; if (!n) return null;
  return `Transcribe this recorded medical consultation word for word and write all of it in English as plain text without speaker labels. The speakers talk in ${n} mixed with English and may switch between them inside one sentence: translate the ${n} parts into plain English and keep the English parts as spoken. Every word you write must be an English word: never write ${n} in Roman letters (no transliteration) and never leave a ${n} word in the text. Write numbers, doses and drug names exactly as spoken. Keep every symptom, denial, instruction and detail. Do not summarise, correct, explain or add anything. If there is no speech, output nothing.`;
}
/**
 * Which Google speech model writes the ORIGINAL-script copy (kept next to the English transcript so the doctor can check what was said).
 * Hindi: Chirp 3 with hi-IN - tested on a synthesized visit, complete and accurate (symptom, drug names, doses, blood pressure).
 * Punjabi: none. Chirp 2, Chirp 3 and Google STT v1 all reject pa-IN, and a Gemini original copy looped and dropped words (the symptom was missing) on every model and prompt
 * tried (2026-11-05), so a copy that silently leaves things out is not offered: Punjabi and mixed visits keep the English transcript only.
 */
export function originalSource(lang) { return normalizeLang(lang) === 'hi' ? { engine: 'chirp_3', languageCode: 'hi-IN' } : null; }

// Hindi / Punjabi written in Roman letters ("mujhe pichle teen din se seene mein dard hai"): the model sometimes transliterates instead of translating (seen live 2026-11-05).
// Only words that are not English words are listed; the test is a count of them, so a stray name or one borrowed word never trips it.
const ROMAN = new Set(('hai hain hoon hu tha thi raha rahi rahe nahi nahin mujhe mujhko mera meri mere aap aapko aapka aapki kya kyun kaise kab kahan mein se ko ka ki ke liye bhi toh lekin aur yeh woh '
  + 'karta karti karte karna kiya hua hui hue lena leta leti dena deta dard bukhar pichle pichhle teen din dobara abhi thoda bahut accha acha theek sakta sakti chahiye hoga hogi ho gaya gayi '
  + 'saans seene seena pet sir sardi khansi dawai goli roz subah shaam raat khana peena paani hafte mahine saal dekho batao bataiye nai haan ji tumhe tumhara hamara unko inko').split(' '));
/** Is this "English" transcript really transliterated Hindi / Punjabi? True when 4 or more words (and at least 10% of the text) are Roman-script Hindi/Punjabi words. */
export function looksRomanisedIndic(text) {
  const w = String(text || '').toLowerCase().match(/[a-z']+/g) || []; if (w.length < 8) return false;
  const hits = w.filter((x) => ROMAN.has(x)).length; return hits >= 4 && hits / w.length >= 0.1;
}

/** Chain settings for a non-English visit: Gemini only (a second Gemini model as the fallback), no English-pinned second opinion. */
export function settingsForLang(base, lang) {
  if (isEnglish(lang)) return base;
  return { ...base, primary: 'gemini-2.5-flash', fallbacks: ['gemini-3.7-flash'], crossCheck: false };
}

/** What the server tells the app about a transcript: English visits add nothing. */
export function languageMeta(lang, original) {
  const l = normalizeLang(lang); if (l === 'en') return {};
  return { language: l, translated: true, ...(original ? { original } : {}) };
}
