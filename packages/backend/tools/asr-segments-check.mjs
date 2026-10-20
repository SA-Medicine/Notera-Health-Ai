#!/usr/bin/env node
// Reproduce the LIVE path on a stored recording: cut it into the same 20-second segments the browser sends, transcribe each with ONE engine,
// and count segments that contain speech-level audio but come back EMPTY (the app treats an empty answer as silence, so that speech is lost
// without any error). Then try the other engines on exactly those segments to see what the fallback chain would recover.
// Prints statistics only. Usage: node tools/asr-segments-check.mjs <consult-id-suffix...>
import { query } from '../src/db/pool.js';
import { transcodePcm16k } from '../src/asr/audio.js';
import { transcribeWithChain, speechLike } from '../src/asr/engines.js';
import { normalise } from './asr-benchmark.mjs';

const SUFFIXES = process.argv.slice(2); const BUCKET = process.env.GCS_AUDIO_BUCKET || ''; const PRIMARY = process.env.PRIMARY || 'chirp_2'; const OTHERS = (process.env.OTHERS || 'chirp_3,latest_long,gemini-2.5-flash').split(',');
const SEG = 20 * 32000; const one = (engine) => ({ primary: engine, fallbacks: [], timeoutMs: 90000, breakerFailures: 99, breakerCooldownMs: 10000, speechCheck: false });
const words = async (pcm, engine) => { try { return normalise((await transcribeWithChain(pcm, { settings: one(engine), log: () => {} })).text).length; } catch { return -1; } };
async function mapLimit(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
const { Storage } = await import('@google-cloud/storage'); const bucket = new Storage().bucket(BUCKET);
for (const suf of SUFFIXES) {
  const [r] = await query(`SELECT consult_id, audio_uri FROM clinical.consults WHERE consult_id LIKE $1 AND audio_uri IS NOT NULL LIMIT 1`, [`%${suf}`]); if (!r) { console.log(suf, 'not found'); continue; }
  const [buf] = await bucket.file(r.audio_uri.replace(`gs://${BUCKET}/`, '')).download(); const pcm = await transcodePcm16k(buf);
  const segs = []; for (let s = 0; s < pcm.length; s += SEG) segs.push(pcm.subarray(s, Math.min(pcm.length, s + SEG)));
  const res = await mapLimit(segs, 3, async (seg) => ({ speech: speechLike(seg, { minSeconds: 3 }), n: await words(seg, PRIMARY), seconds: seg.length / 32000, seg }));
  const speechSegs = res.filter((x) => x.speech); const empty = speechSegs.filter((x) => x.n === 0); const failed = res.filter((x) => x.n < 0);
  const total = res.reduce((s, x) => s + Math.max(0, x.n), 0);
  const rec = {}; for (const e of OTHERS) { const got = await mapLimit(empty, 3, async (x) => words(x.seg, e)); rec[e] = { recovered_segments: got.filter((n) => n > 0).length, recovered_words: got.reduce((s, n) => s + Math.max(0, n), 0) }; }
  console.log(JSON.stringify({ id: suf, minutes: +(pcm.length / 32000 / 60).toFixed(1), segments: segs.length, speech_segments: speechSegs.length, [`${PRIMARY}_words`]: total, empty_for_speech: empty.length, failed_calls: failed.length, recovered_by: rec }));
}
process.exit(0);
