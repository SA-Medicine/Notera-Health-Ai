#!/usr/bin/env node
// End-to-end long-audio test: audio file → 20s WebM/Opus chunks (what the browser sends)
// → POST /api/asr (2 in flight, like Scribe.tsx) → stitched transcript → POST
// /api/consults/async + poll → SOAP note. Prints per-phase timings and errors.
//
//   node scripts/e2e-long-audio.mjs <audio.mp3> [more files...]
//   BASE=http://localhost:8080  SEG=20  INFLIGHT=2  SKIP_NOTE=1  COOKIE='notera_session=...'
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const BASE = (process.env.BASE || 'http://localhost:8080').replace(/\/+$/, '');
const SEG = Number(process.env.SEG || 20);
const INFLIGHT = Number(process.env.INFLIGHT || 2);
// /api/asr and the note routes now require a session cookie (COOKIE=...) or a service token (AUTH_BEARER=...).
const headers = { ...(process.env.COOKIE ? { Cookie: process.env.COOKIE } : {}), ...(process.env.AUTH_BEARER ? { Authorization: `Bearer ${process.env.AUTH_BEARER}` } : {}) };
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: e2e-long-audio.mjs <audio files>'); process.exit(2); }

const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(file) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '24k',
    '-f', 'segment', '-segment_time', String(SEG), '-segment_format', 'webm', join(dir, 'seg%04d.webm')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return { dir, parts: readdirSync(dir).sort().map((f) => join(dir, f)) };
}

async function asrChunk(path, i) {
  const body = readFileSync(path);
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/api/asr`, { method: 'POST', headers: { 'Content-Type': 'audio/webm', ...headers }, body, signal: AbortSignal.timeout(60_000) });
      const txt = await res.text();
      if (res.ok) { const j = JSON.parse(txt); return { i, ok: true, ms: Date.now() - t0, text: j.text || j.transcript || '', attempt }; }
      if (![429, 502, 503, 504].includes(res.status)) return { i, ok: false, ms: Date.now() - t0, status: res.status, err: txt.slice(0, 160), attempt };
    } catch (e) { if (attempt === 2) return { i, ok: false, ms: Date.now() - t0, err: String(e.message || e), attempt }; }
    await sleep([1000, 4000, 10000][attempt]);
  }
  return { i, ok: false, err: 'retries exhausted' };
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); } }));
  return out;
}

async function run(file) {
  console.log(`\n=== ${basename(file)} ===`);
  const t0 = Date.now();
  const { dir, parts } = chunk(file);
  console.log(`chunked into ${parts.length} × ${SEG}s segments in ${fmt(Date.now() - t0)}`);
  // ASR phase — emulate live recording: chunks are produced in real time in the browser, so the
  // only latency that matters after "Stop" is the LAST chunk. We send as fast as 2-in-flight allows
  // and report per-chunk latency + failures.
  const tAsr = Date.now();
  const res = await pool(parts, INFLIGHT, (p, i) => asrChunk(p, i));
  rmSync(dir, { recursive: true, force: true });
  const fails = res.filter((r) => !r.ok);
  const lat = res.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const transcript = res.map((r) => (r.ok ? r.text.trim() : '')).filter(Boolean).join('\n');
  console.log(`ASR: ${res.length - fails.length}/${res.length} chunks ok, wall ${fmt(Date.now() - tAsr)}, p50 ${lat[Math.floor(lat.length / 2)] ?? '-'}ms, max ${lat[lat.length - 1] ?? '-'}ms, retried ${res.filter((r) => r.attempt > 0).length}`);
  fails.forEach((f) => console.log(`  ✗ chunk ${f.i}: ${f.status || ''} ${f.err}`));
  console.log(`transcript: ${transcript.split(/\s+/).length} words`);
  if (process.env.SKIP_NOTE || !transcript.trim()) return { file, asrFails: fails.length };

  const tNote = Date.now();
  if (process.env.DIRECT) {
    // Runs the real pipeline in-process (no auth needed) — use inside the backend container.
    const { generateNote } = await import(process.env.GEN_PATH || '/app/packages/backend/src/orchestrator/generateNote.js');
    try {
      const r = await generateNote({ transcript, specialty: 'auto', noteType: 'consultation', clinicianId: 'e2e-test' }, { persist: false });
      const md = r.renderedNote || r.rawRenderedNote || '';
      console.log(`NOTE: done in ${fmt(Date.now() - tNote)} — ${md.split(/\s+/).length} words, ${md.split('\n').length} lines`);
      if (process.env.PRINT_NOTE) console.log(md);
      return { file, asrFails: fails.length, noteOk: true, noteMs: Date.now() - tNote };
    } catch (e) { console.log(`NOTE: ERROR after ${fmt(Date.now() - tNote)}: ${e.message}`); return { file, asrFails: fails.length, noteOk: false }; }
  }
  const start = await fetch(`${BASE}/api/consults/async`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ transcript, specialty: 'auto', noteType: 'consultation', clinicianId: 'e2e-test' }) });
  const sj = await start.json().catch(() => ({}));
  if (!sj.jobId) { console.log(`NOTE: could not start (${start.status}) ${JSON.stringify(sj).slice(0, 200)}`); return { file, asrFails: fails.length, noteOk: false }; }
  for (;;) {
    await sleep(2000);
    const j = await fetch(`${BASE}/api/consults/job/${sj.jobId}`, { headers }).then((r) => r.json()).catch(() => ({ status: 'pending' }));
    if (j.status === 'done') {
      const md = j.result?.renderedNote || j.result?.rawRenderedNote || '';
      console.log(`NOTE: done in ${fmt(Date.now() - tNote)} — ${md.split(/\s+/).length} words, ${md.split('\n').length} lines`);
      if (process.env.PRINT_NOTE) console.log(md);
      return { file, asrFails: fails.length, noteOk: true, noteMs: Date.now() - tNote };
    }
    if (j.status === 'error') { console.log(`NOTE: ERROR after ${fmt(Date.now() - tNote)}: ${j.error}`); return { file, asrFails: fails.length, noteOk: false }; }
    if (Date.now() - tNote > 10 * 60_000) { console.log('NOTE: gave up after 10 min'); return { file, noteOk: false }; }
  }
}

const summary = [];
for (const f of files) summary.push(await run(f));
console.log('\nSUMMARY', JSON.stringify(summary));
