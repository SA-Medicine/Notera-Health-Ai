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
