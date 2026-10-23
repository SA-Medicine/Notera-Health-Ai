// What can be said about a stored recording without listening to it: how long it is, how loud, how many words the transcript holds for that length,
// and a short list of reasons it might not be a real consultation (a test clip, a silent file, a mic left on). The flags only help a person decide;
// nothing is ever removed because of a flag.
'use strict';

const BYTES_PER_SECOND = 32000;   // 16 kHz mono, 16-bit
export const THRESHOLDS = { shortS: 20, silentLevel: 250, minWpm: 40, maxWpm: 260, minWordsFor30s: 10 };

/** Mean absolute amplitude of 16-bit little-endian PCM (sampled): silence and room noise stay low, speech does not. */
export function meanLevel(pcm) {
  if (!pcm || pcm.length < 2) return 0;
  let sum = 0, n = 0; for (let i = 0; i + 1 < pcm.length; i += 64) { sum += Math.abs(pcm.readInt16LE(i)); n++; }
  return n ? sum / n : 0;
}

/** { durationS, level } for an audio file's bytes (any format ffmpeg reads), or null when it cannot be decoded. `transcode` = bytes -> 16 kHz mono PCM. */
export async function measureAudio(buf, transcode) {
  const pcm = await transcode(buf);
  if (!pcm || !pcm.length) return null;
  return { durationS: +(pcm.length / BYTES_PER_SECOND).toFixed(1), level: +meanLevel(pcm).toFixed(0) };
}

export const countWords = (text) => (String(text || '').match(/[A-Za-z0-9']+/g) || []).length;
export const wordsPerMinute = (words, durationS) => (durationS > 0 ? +(words / (durationS / 60)).toFixed(0) : null);

/** Reasons to look twice. Order: the most serious first. */
export function audioFlags({ durationS, level, words, ownerRole, bytes }) {
  const f = [];
  if (durationS == null) { f.push('cannot be decoded'); return f; }
  if (durationS < THRESHOLDS.shortS) f.push('very short');
  if (level != null && level < THRESHOLDS.silentLevel) f.push('mostly silent');
  if (durationS >= 30 && (words ?? 0) < THRESHOLDS.minWordsFor30s) f.push('almost no words');
  const wpm = wordsPerMinute(words ?? 0, durationS);
  if (durationS >= 60 && wpm != null && wpm < THRESHOLDS.minWpm && !f.includes('almost no words')) f.push('few words for its length');
  if (durationS >= 60 && wpm != null && wpm > THRESHOLDS.maxWpm) f.push('more words than speech allows');
  if (ownerRole === 'admin') f.push('admin account (test upload?)');
  if (bytes != null && bytes < 20_000) f.push('tiny file');
  return f;
}
