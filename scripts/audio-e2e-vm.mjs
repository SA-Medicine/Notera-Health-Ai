#!/usr/bin/env node
// Audio → transcript → SOAP note, using the SAME code the deployed backend runs (ffmpeg decode, Google Speech-to-Text,
// v2 note pipeline). Run INSIDE the backend container so it uses the VM's credentials and settings:
//   docker cp <files> notera-backend:/tmp/audio/ && docker cp scripts/audio-e2e-vm.mjs notera-backend:/app/packages/backend/audio-e2e-vm.mjs
//   docker exec -w /app/packages/backend notera-backend node audio-e2e-vm.mjs /tmp/audio/CAR0001.mp3 ...   → JSON lines on stdout
// Nothing is saved to the database (persist:false).
import fs from 'node:fs';
import path from 'node:path';
import { transcodePcm16k } from './src/asr/audio.js';
import { transcribePcm, billableModel } from './src/asr/googleSpeech.js';
import { generateNote } from './src/orchestrator/generateNote.js';

const files = process.argv.slice(2);
const model = billableModel(process.env.ASR_MODEL && !/^chirp/i.test(process.env.ASR_MODEL) ? process.env.ASR_MODEL : 'latest_long');
for (const f of files) {
  const out = { file: path.basename(f), bytes: fs.statSync(f).size };
  try {
    let t0 = Date.now(); const pcm = await transcodePcm16k(fs.readFileSync(f)); out.audio_s = Math.round(pcm.length / 32000); out.decode_ms = Date.now() - t0;
    t0 = Date.now(); const r = await transcribePcm(pcm, { languageCode: process.env.ASR_LANGUAGE || 'en-US', model }); out.asr_ms = Date.now() - t0;
    const transcript = (typeof r === 'string' ? r : r.transcript || r.text || '').trim(); out.transcript = transcript; out.words = transcript.split(/\s+/).filter(Boolean).length;
    t0 = Date.now(); const lg = []; const trace = {};
    const n = await generateNote({ transcript, specialty: 'auto', noteType: 'consultation', clinicianId: 'audio-e2e' }, { persist: false, mode: 'v2', onLog: (l) => { if (lg.length < 200) lg.push(l); }, trace });
    out.note_ms = Date.now() - t0; out.note = n.renderedNote || ''; out.flags = (n.flags || []).length; out.log = lg.filter((l) => !/Timing\]/.test(l)); out.trace = { used: trace.used, timings: trace.timings };
    out.ok = !!out.note && out.words > 20;
  } catch (e) { out.ok = false; out.error = String(e.message || e).slice(0, 300); }
  console.log(JSON.stringify(out));
}
process.exit(0);
