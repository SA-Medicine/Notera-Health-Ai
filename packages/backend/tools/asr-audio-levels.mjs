#!/usr/bin/env node
// Why would a real recording come back under-transcribed? Measure the audio itself (loudness, how much of it is speech-level) and test
// whether simple pre-processing (gain normalisation) lets the same engine hear more. Prints statistics only — never transcript text.
//   node tools/asr-audio-levels.mjs [N=4]   (env ENGINE=chirp_2)
import { query } from '../src/db/pool.js';
import { transcodePcm16k } from '../src/asr/audio.js';
import { pcmDurationSeconds } from '../src/asr/googleSpeech.js';
import { transcribeWithChain } from '../src/asr/engines.js';
import { normalise } from './asr-benchmark.mjs';

const N = Number(process.argv[2]) || 4; const ENGINE = process.env.ENGINE || 'chirp_2'; const BUCKET = process.env.GCS_AUDIO_BUCKET || '';
export function levels(pcm) {
  const frame = 1600; let peak = 0, sumSq = 0, n = 0; const frames = []; // 100 ms frames
  for (let f = 0; f + frame * 2 <= pcm.length; f += frame * 2) { let s = 0; for (let i = f; i < f + frame * 2; i += 2) { const v = pcm.readInt16LE(i); s += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); } frames.push(Math.sqrt(s / frame)); sumSq += s; n += frame; }
  const db = (x) => (x > 0 ? 20 * Math.log10(x / 32768) : -120); const sorted = [...frames].sort((a, b) => a - b);
  const speech = frames.filter((x) => db(x) > -45).length / (frames.length || 1);
  return { rms_db: +db(Math.sqrt(sumSq / (n || 1))).toFixed(1), peak_db: +db(peak).toFixed(1), p90_db: +db(sorted[Math.floor(sorted.length * 0.9)] || 0).toFixed(1), p50_db: +db(sorted[Math.floor(sorted.length * 0.5)] || 0).toFixed(1), speech_level_share: +speech.toFixed(2) };
}
/** Scale so the loud-speech level (90th percentile of 100 ms frames) reaches about -20 dBFS; gain is capped at +24 dB, peaks are limited, never attenuates. */
export function normaliseGain(pcm, targetDb = -20, maxGainDb = 24) {
  const L = levels(pcm); const gainDb = Math.max(0, Math.min(maxGainDb, targetDb - L.p90_db)); const g = 10 ** (gainDb / 20); const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) { let v = Math.round(pcm.readInt16LE(i) * g); if (v > 32767) v = 32767; if (v < -32768) v = -32768; out.writeInt16LE(v, i); }
  return { pcm: out, gainDb: +gainDb.toFixed(1) };
}
async function main() {
  const rows = await query(`SELECT consult_id, audio_uri, transcript->>'text' AS text FROM clinical.consults WHERE audio_uri IS NOT NULL AND audio_uri <> '' AND length(coalesce(transcript->>'text','')) > 1500 ORDER BY created_at DESC LIMIT $1`, [N]);
  const { Storage } = await import('@google-cloud/storage'); const bucket = new Storage().bucket(BUCKET);
  const settings = { primary: ENGINE, fallbacks: [], timeoutMs: 170000, breakerFailures: 99, breakerCooldownMs: 10000, speechCheck: false };
  for (const r of rows) {
    try {
      const [buf] = await bucket.file(r.audio_uri.replace(`gs://${BUCKET}/`, '')).download(); const pcm = await transcodePcm16k(buf); const min = pcmDurationSeconds(pcm.length) / 60; const L = levels(pcm); const norm = normaliseGain(pcm);
      const run = async (p) => (await transcribeWithChain(p, { settings, log: () => {} })).text; const raw = normalise(await run(pcm)).length; const boosted = normalise(await run(norm.pcm)).length; const stored = normalise(r.text).length;
      console.log(JSON.stringify({ id: r.consult_id.slice(-6), minutes: +min.toFixed(1), levels: L, stored_wpm: Math.round(stored / min), engine_raw_wpm: Math.round(raw / min), engine_normalised_wpm: Math.round(boosted / min), gain_db: norm.gainDb }));
    } catch (e) { console.log(r.consult_id.slice(-6), 'failed:', String(e.message).slice(0, 80)); }
  }
  process.exit(0);
}
if (process.argv[1] && /asr-audio-levels\.mjs$/.test(process.argv[1])) await main();
