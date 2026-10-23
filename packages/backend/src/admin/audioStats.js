// What can be said about a stored recording without listening to it: how long it is, how loud, how many words the transcript holds for that length,
// and a short list of reasons it might not be a real consultation (a test clip, a silent file, a mic left on). The flags only help a person decide;
// nothing is ever removed because of a flag.
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const BYTES_PER_SECOND = 32000;   // 16 kHz mono, 16-bit
export const THRESHOLDS = { shortS: 20, silentLevel: 250, minWpm: 40, maxWpm: 260, minWordsFor30s: 10 };

/** Mean absolute amplitude of 16-bit little-endian PCM (sampled): silence and room noise stay low, speech does not. */
export function meanLevel(pcm) {
  if (!pcm || pcm.length < 2) return 0;
  let sum = 0, n = 0; for (let i = 0; i + 1 < pcm.length; i += 64) { sum += Math.abs(pcm.readInt16LE(i)); n++; }
  return n ? sum / n : 0;
}

/**
 * Decodes recording bytes to 16 kHz mono PCM through a real temporary FILE (not a pipe): browser recordings sometimes hold two audio streams one after
 * the other, and ffmpeg only reads past the first when it can seek. Returns null when the file cannot be decoded.
 */
export async function decodeFile(buf, { timeoutMs = 120000 } = {}) {
  const f = path.join(os.tmpdir(), 'audio-' + crypto.randomBytes(6).toString('hex') + '.bin');
  try {
    fs.writeFileSync(f, buf);
    return await new Promise((resolve) => {
      const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const out = []; const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
      p.stdout.on('data', (d) => out.push(d)); p.on('error', () => { clearTimeout(t); resolve(null); });
      p.on('close', (code) => { clearTimeout(t); const b = Buffer.concat(out); resolve(code === 0 && b.length ? b : null); });
    });
  } finally { try { fs.unlinkSync(f); } catch { /* already gone */ } }
}

/** A WebM/Matroska recording must start with the EBML header (1A 45 DF A3). One that starts with a later data block can never be played. */
export const missingWebmHeader = (buf) => !!buf && buf.length > 4 && buf.subarray(0, 4).toString('hex') !== '1a45dfa3' && buf.subarray(0, 4).toString('latin1') !== 'OggS' && buf.subarray(0, 4).toString('latin1') !== 'RIFF';

/**
 * The six recordings that could not be played all had ONE stray one-second piece (16 439 bytes) in front of an otherwise good file. This cuts
 * anything in front of the first container header (looked for in the first 512 KB). { buf, trimmed, ok }: ok=false means no known header at all.
 */
export function repairWebm(buf) {
  if (!buf || buf.length < 8) return { buf, trimmed: 0, ok: false };
  const four = buf.subarray(0, 4).toString('latin1');
  if (buf.subarray(0, 4).toString('hex') === '1a45dfa3' || buf.subarray(4, 8).toString('latin1') === 'ftyp' || four === 'OggS' || four === 'RIFF') return { buf, trimmed: 0, ok: true };
  const i = buf.subarray(0, 512 * 1024).indexOf(Buffer.from('1a45dfa3', 'hex'));
  return i > 0 ? { buf: buf.subarray(i), trimmed: i, ok: true } : { buf, trimmed: 0, ok: false };
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
export function audioFlags({ durationS, level, words, ownerRole, bytes, damaged = false }) {
  const f = [];
  if (durationS == null) { f.push(damaged ? 'damaged file (no audio header)' : 'cannot be decoded'); if (ownerRole === 'admin') f.push('admin account (test upload?)'); return f; }
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
