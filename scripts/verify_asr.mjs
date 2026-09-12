#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Verify the long-recording ASR path end to end.
//
//   node scripts/verify_asr.mjs <audio-file>            # dry run  — FREE, no API call
//   node scripts/verify_asr.mjs <audio-file> --live     # real call — BILLED
//
// With no file it generates a tone of --seconds (default 390 = 6.5 min) with ffmpeg.
//
// The dry run proves everything local: ffmpeg decode, exact duration, the window plan,
// that every window fits the ~60s synchronous limit, that the windows are contiguous,
// and which model will actually be billed. Only --live contacts Google, and it prints the
// estimated cost first at the standard rate ($0.016/min, billed in 15s increments).
// ─────────────────────────────────────────────────────────────────────────────
import '../packages/backend/src/loadEnv.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ffmpegAvailable, transcodePcm16k } from '../packages/backend/src/asr/audio.js';
import {
  billableModel, planWindows, pcmDurationSeconds, transcribePcm, _BYTES_PER_SECOND as BPS,
} from '../packages/backend/src/asr/googleSpeech.js';

const argv = process.argv.slice(2);
const live = argv.includes('--live');
const file = argv.find((a) => !a.startsWith('--'));
const seconds = Number((argv.find((a) => a.startsWith('--seconds=')) || '').split('=')[1]) || 390;
const RATE_PER_MIN = 0.016;          // standard model, USD
const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m!\x1b[0m ${s}`;

async function generateTone(secs) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notera-verify-'));
  const out = path.join(dir, 'tone.webm');
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', `sine=frequency=300:duration=${secs}`, '-ac', '1', '-c:a', 'libopus', '-f', 'webm', out, '-y']);
    ff.on('error', reject);
    ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`))));
  });
  return out;
}

const main = async () => {
  console.log('\n── Notera ASR verification ──\n');

  const ff = await ffmpegAvailable();
  console.log(ff ? ok(`ffmpeg: ${String(ff).slice(0, 60)}`)
    : bad('ffmpeg NOT on PATH — long recordings cannot be windowed and WILL fail'));
  if (!ff) process.exit(1);

  const cred = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  console.log(cred ? ok(`credentials: ${cred}`) : warn('GOOGLE_APPLICATION_CREDENTIALS unset (ambient credentials will be used)'));

  const requested = process.env.ASR_MODEL || 'latest_long';
  const billed = billableModel(requested);
  console.log(ok(`model: ${requested}${billed !== requested ? ` → billed as ${billed} (cost guard: premium model refused)` : ' (standard rate)'}`));

  const audioPath = file || await generateTone(seconds);
  if (!file) console.log(warn(`no file given — generated a ${seconds}s tone (a tone transcribes to nothing; pass a real recording to check accuracy)`));
  const audio = await fs.readFile(audioPath);
  console.log(ok(`input: ${path.basename(audioPath)} — ${(audio.length / 1048576).toFixed(2)} MB`));

  const t0 = Date.now();
  const pcm = await transcodePcm16k(audio);
  if (!pcm?.length) { console.log(bad('decode failed — ffmpeg could not read this file')); process.exit(1); }
  const duration = pcmDurationSeconds(pcm.length);
  console.log(ok(`decoded: ${(pcm.length / 1048576).toFixed(2)} MB PCM in ${Date.now() - t0}ms → ${duration.toFixed(1)}s exact duration`));

  // The two ceilings that used to make long recordings impossible.
  const inlineMB = pcm.length * 4 / 3 / 1048576;
  console.log(`  whole-file base64 would be ${inlineMB.toFixed(1)} MB `
    + `${inlineMB > 10 ? '→ OVER the ~10 MB inline limit, so it could never be sent in one call' : '(within the inline limit)'}`);
  console.log(`  duration ${duration.toFixed(0)}s ${duration > 60 ? '→ OVER the ~60s synchronous limit' : '(within the synchronous limit)'}`);

  const windows = planWindows(pcm);
  const sizes = windows.map((w) => (w.end - w.start) / BPS);
  const tooLong = sizes.filter((s) => s > 55);
  let contiguous = windows[0]?.start === 0 && windows[windows.length - 1]?.end === pcm.length;
  for (let i = 1; i < windows.length; i++) if (windows[i].start !== windows[i - 1].end) contiguous = false;

  console.log(ok(`window plan: ${windows.length} window(s) — ${sizes.map((s) => s.toFixed(1)).join(', ')} s`));
  console.log(tooLong.length ? bad(`${tooLong.length} window(s) exceed the 55s limit`) : ok('every window fits the synchronous limit'));
  console.log(contiguous ? ok('windows are contiguous and non-overlapping (no speech lost or doubled)') : bad('windows have a gap or overlap'));
  if (tooLong.length || !contiguous) process.exit(1);

  const cost = Math.ceil(duration / 15) * 15 / 60 * RATE_PER_MIN;
  if (!live) {
    console.log(`\nDry run complete — no API call made, nothing billed.`);
    console.log(`To verify against the real Google API (~$${cost.toFixed(3)} for this ${duration.toFixed(0)}s clip):`);
    console.log(`  node scripts/verify_asr.mjs ${file ? path.basename(audioPath) : '<your-recording>'} --live\n`);
    return;
  }

  console.log(`\n── LIVE call — billing ~$${cost.toFixed(3)} at $${RATE_PER_MIN}/min (${billed}) ──`);
  const t1 = Date.now();
  const r = await transcribePcm(pcm, { log: (l) => console.log(`  ${l}`) });
  const elapsed = Date.now() - t1;
  console.log(r.failedWindows ? warn(`${r.failedWindows}/${r.windows} window(s) failed`) : ok(`all ${r.windows} window(s) transcribed`));
  console.log(ok(`round trip ${(elapsed / 1000).toFixed(1)}s for ${duration.toFixed(0)}s of audio (RTF ${(elapsed / 1000 / duration).toFixed(2)})`));
  console.log(`\ntranscript (${r.text.length} chars):\n${r.text.slice(0, 2000)}${r.text.length > 2000 ? '\n…' : ''}\n`);
  if (!r.text && !file) console.log(warn('empty transcript is EXPECTED for a generated tone — there is no speech in it'));
};

main().catch((e) => { console.error(bad(e.message)); process.exit(1); });
