// The Gemini transcription engine is asked to "Transcribe this recorded medical consultation word for word ...". About 4% of consultations (3 of 72 in 30 days) came back with that
// instruction written into the transcript (a window of audio the model answered by repeating its prompt). The note pipeline read it as speech. This removes the instruction
// (whole, or any of its sentences) from a transcript. Pure; never touches anything else.
'use strict';

const SENTENCES = [
  /Transcribe this recorded medical consultation[^.]*\./gi,
  /Write numbers, doses and drug names exactly as spoken\./gi,
  /Do not summari[sz]e, correct, explain or add anything\./gi,
  /If there is no speech, output nothing\./gi,
];

export function stripPromptLeak(text) {
  const src = String(text || ''); let out = src;
  for (const re of SENTENCES) out = out.replace(re, ' ');
  if (out === src) return src;
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.?!])/g, '$1').trim();
}

// Chirp 2 is given a list of drug and symptom words to listen for (medicalVocab.js). On a stretch of typing or room noise it has been seen to write that list out as if it were
// speech ("epigastric,Pap smear,mammogram,Cipralex,melanoma,oxazepam,..." in two real recordings, 2026-10-26 and 2026-11-18). The tell is a run of at least five items joined by
// commas with NO space, mostly made of words from that list; real speech output always has ", ". The run is removed; nothing else is touched.
import { MEDICAL_TERMS } from './medicalVocab.js';
const LIST_RUN = /(?:[A-Za-z][A-Za-z'\- ]{1,30},){4,}(?:[A-Za-z][A-Za-z'\- ]{0,30})?/g;
export function stripVocabLeak(text) {
  const src = String(text || ''); if (!src.includes(',')) return src;
  const out = src.replace(LIST_RUN, (run) => {
    const items = run.split(',').map((s) => s.trim()).filter(Boolean);
    const known = items.filter((it) => it.toLowerCase().split(/\s+/).some((w) => MEDICAL_TERMS.has(w))).length;
    return items.length >= 5 && known / items.length >= 0.5 ? ' ' : run;
  });
  return out === src ? src : out.replace(/[ \t]{2,}/g, ' ').trim();
}
