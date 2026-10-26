// ─────────────────────────────────────────────────────────────────────────────
// Notera — unified backend (Express). One service for BOTH audiences:
//   • product API  (/api/consults, pipeline, approve) — clinician app
//   • admin/lab API (/api/runs, /api/results, /api/prompts, /api/patients,
//                    /api/lab/*, /api/scripts, /api/session, /api/judge, …)
//
// The admin/lab handler reads the raw request stream itself, so express.json() is
// applied ONLY to the product routes; admin prefixes are dispatched before it.
// The unified Next app serves all UI — this service is API-only.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import './src/loadEnv.js';
import express from 'express';
import { config } from './src/config.js';
import { generateNote, approveNote } from './src/orchestrator/generateNote.js';
import { store, audit } from './src/firestore/store.js';
import { mountProxy } from './src/proxy.js';
import { mountAuth, requireAuth } from './src/auth/authRoutes.js';
import { noteQuotaGate, asrQuotaGate, refundIfReserved } from './src/auth/quota.js';
import { mountLibrary } from './src/library/libraryRoutes.js';
import { mountOps } from './src/ops/opsRoutes.js';
import { mountPanel } from './src/admin/panelRoutes.js';
import { mountStudioInvite } from './src/studio/invite.js';
import { ensureOpsSchema, checkAlerts, recordAudioEvent } from './src/ops/opsLog.js';
import path from 'node:path';

const app = express();
app.set('trust proxy', 1);   // behind Caddy / Vercel proxy — needed for correct req.ip & Secure cookies
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');

// Admin/Testing-Lab is a DEVELOPER tool — mounted ONLY when ENABLE_ADMIN=1 (never in prod).
// It's also LAZY-loaded: its module writes a logs directory at import time, which a non-root
// production container can't do, so we only import it when actually enabled.
const ADMIN_ENABLED = process.env.ENABLE_ADMIN === '1';
let adminHandler = null;
if (ADMIN_ENABLED) ({ adminHandler } = await import('./src/admin/handler.js'));

// CORS — in production, allow ONLY the Vercel frontend origin (credentials on). In dev, reflect origin.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allow = CORS_ORIGIN
    ? (origin === CORS_ORIGIN ? CORS_ORIGIN : CORS_ORIGIN)   // pin to the single allowed origin
    : (origin || '*');                                       // dev: reflect
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Self-hosted email/password auth (login/logout/me/reset). Always mounted.
mountAuth(app, DATA_DIR);

// Per-user Library: durable history (consults + transcripts + notes) and audio
// storage/download. Each route is gated by a valid session and scoped to the user.
mountLibrary(app, requireAuth(DATA_DIR));

// Monitoring API (/api/ops/*): admin-only reads + authenticated intake. Backs monitor.aitoolsfordoctor.com.
mountOps(app, requireAuth(DATA_DIR));

// Admin console API (/api/console/*): admin-only, read-only, PHI views audited. Backs the standalone admin site.
mountPanel(app, requireAuth(DATA_DIR));

// Style Interview invitation status (read-only): lets the main app show a banner/menu link to Notera Studio for invited accounts.
mountStudioInvite(app, requireAuth(DATA_DIR));

// Production admin console (/api/console/*): admin role only — users, plans, every consult's transcript, SOAP note and audio.

// ── Admin / Testing-Lab API ──────────────────────────────────────────────────
// Dispatched BEFORE express.json so the handler owns the request stream (SSE,
// large JSON imports, its own body parser). It calls next() for non-admin paths.
const ADMIN_PREFIXES = [
  '/api/login', '/api/logout', '/api/session', '/api/scripts', '/api/runs',
  '/api/run-patients', '/api/results', '/api/metrics', '/api/prompts', '/api/patients',
  '/api/lab', '/api/sessions', '/api/judge', '/api/config',
];
app.use((req, res, next) => {
  const isAdminPath = ADMIN_PREFIXES.some((pre) => req.path === pre || req.path.startsWith(pre + '/'));
  if (!isAdminPath) return next();
  if (ADMIN_ENABLED) return adminHandler(req, res, next);   // dev only
  return res.status(404).json({ error: 'not found' });      // prod: admin surface does not exist
});

// ── Product API (clinician) ──────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// Product (clinician) auth gate. Every PHI route requires a valid SESSION cookie
// (from /api/auth/login). Service-token bearer auth is still accepted for trusted
// server-to-server callers. The old "production → allow all" bypass is REMOVED.
const _requireAuth = requireAuth(DATA_DIR);
app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  if (req.path.startsWith('/api/auth')) return next();            // login/reset are public
  if (!config.requireAuth) return next();                          // dev convenience (REQUIRE_AUTH=false)
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (config.serviceTokens.length && token && config.serviceTokens.includes(token)) return next();
  return _requireAuth(req, res, next);                             // else require a real session
});

// Key-safe passthrough proxy (/api/asr, /api/llm/*). Mounted AFTER the auth gate: it spends Google
// credits, so it needs a signed-in user (or service token). Out-of-quota free users are stopped at ASR too.
app.use('/api/asr', asrQuotaGate);
mountProxy(app);

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'notera-backend', version: config.pipelineVersion }));

// Audio safety: an empty/whitespace transcript means the mic caught no speech (left on by
// mistake, etc.). NEVER run the LLM pipeline on it — that's the real cost saver. Log the event.
const isBlankTranscript = (t) => typeof t === 'string' && t.trim().length < 2;

app.post('/api/consults', noteQuotaGate, async (req, res) => {
  try {
    const { transcript, audioUri, specialty, noteType, clinicianId, templateSystemPrompt, deidMode } = req.body || {};
  const patientMeds = Array.isArray(req.body?.patientMeds) ? req.body.patientMeds.map(String).slice(0, 60) : [];   // the patient's medication list from the EHR, when the clinician gives it: used to check drug names
    if (!transcript && !audioUri) return res.status(400).json({ error: 'transcript or audioUri required' });
    if (!audioUri && isBlankTranscript(transcript)) {
      refundIfReserved(req);
      recordAudioEvent({ clinicianId, reason: 'empty_transcript', meta: { via: 'sync' } });
      return res.status(422).json({ error: 'empty_transcript', message: 'No speech detected — nothing to write a note from.' });
    }
    const result = await generateNote(
      { transcript, audioUri, specialty, noteType, clinicianId, templateSystemPrompt, patientMeds },
      { deidMode, includeLogs: !!req.body?.includeLogs }
    );
    res.json(result);
  } catch (err) { refundIfReserved(req); console.error('[/api/consults] error', err); res.status(500).json({ error: err.message }); }
});

// ── Async note generation (avoids the Cloudflare ~100s edge timeout) ─────────
// The synchronous POST /api/consults above holds the connection open for the whole
// pipeline (can be >100s on long transcripts) and dies at the CDN edge. Instead:
//   POST /api/consults/async  → returns { jobId } immediately, runs in background
//   GET  /api/consults/job/:jobId → { status: pending|done|error, result?, error? }
// Each request is tiny, so no single call ever approaches the edge timeout, and the
// client can poll for up to 5 minutes (or longer) with no risk of a 524.
const _jobs = new Map();   // jobId -> { status, result, error, createdAt, consultId, owner }
const _byConsult = new Map();   // "<user>|<consultId>" -> jobId (one note job per consult)
const JOB_TTL_MS = 15 * 60 * 1000;
setInterval(() => { const now = Date.now(); for (const [id, j] of _jobs) if (now - j.createdAt > JOB_TTL_MS) { _jobs.delete(id); for (const [k, v] of _byConsult) if (v === id) _byConsult.delete(k); } }, 60_000).unref?.();

app.post('/api/consults/async', noteQuotaGate, async (req, res) => {
  const { transcript, audioUri, specialty, noteType, clinicianId, templateSystemPrompt, deidMode } = req.body || {};
  const patientMeds = Array.isArray(req.body?.patientMeds) ? req.body.patientMeds.map(String).slice(0, 60) : [];   // the patient's medication list from the EHR, when the clinician gives it: used to check drug names
  if (!transcript && !audioUri) { refundIfReserved(req); return res.status(400).json({ error: 'transcript or audioUri required' }); }
  if (!audioUri && isBlankTranscript(transcript)) {
    refundIfReserved(req);
    recordAudioEvent({ clinicianId, reason: 'empty_transcript', meta: { via: 'async' } });
    return res.status(422).json({ error: 'empty_transcript', message: 'No speech detected — nothing to write a note from.' });
  }
  // The browser names the consult (consultId) when the recording starts, saves the consult and its recording BEFORE asking for the note, and sends the
  // same id here. A second request for the same consult (a double click, a retry after a refresh) gets the job that is already running or finished,
  // instead of writing a second note: three notes were written from one recording in 0.2 s on 2026-10-26.
  const owner = req.user?.id || clinicianId;
  const cid = /^[A-Za-z0-9_-]{6,80}$/.test(String(req.body?.consultId || '')) ? String(req.body.consultId) : null;
  if (cid) {
    const prev = _byConsult.get(`${owner}|${cid}`); const pj = prev && _jobs.get(prev);
    if (pj && pj.status !== 'error') { refundIfReserved(req); return res.status(202).json({ jobId: prev, consultId: cid, reused: true }); }
  }
  // the job is registered BEFORE any await, so two requests arriving at the same instant cannot both start a note
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  _jobs.set(jobId, { status: 'pending', createdAt: Date.now(), consultId: cid, owner });
  if (cid) _byConsult.set(`${owner}|${cid}`, jobId);
  if (cid) {
    const row = await store.getConsult(cid).catch(() => null);
    if (row?.clinician_id && req.user?.id && row.clinician_id !== req.user.id) { _jobs.delete(jobId); _byConsult.delete(`${owner}|${cid}`); refundIfReserved(req); return res.status(403).json({ error: 'forbidden' }); }
  }
  res.status(202).json({ jobId, consultId: cid });   // respond instantly
  // Run the pipeline AFTER responding — never blocks the request.
  (async () => {
    try {
      const result = await generateNote(
        { transcript, audioUri, specialty, noteType, clinicianId: req.user?.id || clinicianId, templateSystemPrompt, patientMeds, ...(cid ? { consultId: cid } : {}) },
        { deidMode, includeLogs: !!req.body?.includeLogs }
      );
      _jobs.set(jobId, { status: 'done', result, createdAt: Date.now(), consultId: result?.consultId || cid, owner });
    } catch (err) {
      console.error('[/api/consults/async] error', err);
      refundIfReserved(req);   // a failed note doesn't count against the free quota
      _jobs.set(jobId, { status: 'error', error: err.message, createdAt: Date.now(), consultId: cid, owner });
    }
  })();
});

// The note as saved in the database, for a job this server no longer holds (it restarted, or the job aged out).
async function savedNote(consultId, userId) {
  const c = await store.getConsult(consultId).catch(() => null);
  if (!c || (userId && c.clinician_id && c.clinician_id !== userId)) return null;
  const d = [...(c.drafts || [])].reverse().find((x) => x?.rendered_note || x?.note?.rendered || x?.renderedNote);
  if (!d) return { status: c.status === 'processing' ? 'lost' : 'none', consultId };
  return { status: 'done', result: { consultId, renderedNote: d.rendered_note || d.renderedNote || d.note?.rendered || '', flags: d.flags || d.note?.metadata?.flags || [], detectedSpecialty: c.specialty || null } };
}

app.get('/api/consults/job/:jobId', async (req, res) => {
  const j = _jobs.get(req.params.jobId);
  const consultId = j?.consultId || (/^[A-Za-z0-9_-]{6,80}$/.test(String(req.query.consultId || '')) ? String(req.query.consultId) : null);
  if (j?.status === 'done') return res.json({ status: 'done', consultId, result: j.result });
  if (j?.status === 'error') return res.json({ status: 'error', consultId, error: j.error });
  if (j) return res.json({ status: 'pending', consultId, startedAt: j.createdAt });
  // not in memory: the server restarted or the job aged out. The note may already be saved; if it is not, say the job was lost so the page can start it again.
  if (consultId) { const s = await savedNote(consultId, req.user?.id); if (s?.status === 'done') return res.json(s); if (s) return res.json({ status: 'lost', consultId }); }
  return res.status(404).json({ status: 'lost', error: 'job not found or expired' });
});

app.get('/api/consults/:id', async (req, res) => {
  try {
    const c = await store.getConsult(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    await audit({ consultId: c.consultId, actor: req.header('x-clinician-id') || 'unknown', action: 'consult.viewed' });
    res.json(c);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/consults', async (req, res) => {
  try { res.json({ consults: await store.listConsults(Number(req.query.limit) || 50) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/consults/:id/approve', async (req, res) => {
  try {
    const { draftId, finalNote, clinicianId } = req.body || {};
    if (!finalNote) return res.status(400).json({ error: 'finalNote required' });
    const result = await approveNote({ consultId: req.params.id, draftId, finalNote, clinicianId });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Catch-all: any unmatched /api/* route returns JSON (never Express's default HTML page),
// so the frontend never receives "<!DOCTYPE …" where it expects JSON.
app.use('/api', (req, res) => res.status(404).json({ error: `no such endpoint: ${req.method} ${req.originalUrl}` }));

const port = config.port;
const server = app.listen(port, () => {
  // Report the ACTUAL store backend (STORE_BACKEND wins; FIRESTORE_DRIVER is the legacy fallback).
  const storeBackend = process.env.STORE_BACKEND || (config.firestoreDriver === 'firestore' ? 'firestore' : 'memory');
  console.log(`Notera backend (unified) on :${port}  — product + admin/lab API  (llm=${config.llmBackend}, store=${storeBackend})`);
  // RxNorm medication verification (upgrade D-Tier2): ping the source at startup so its
  // availability is visible in the logs. Enabled with RXNORM_VERIFY=1; never blocks boot.
  import('./src/services/rxnorm.js').then(({ rxnormEnabled, initRxNorm }) => {
    if (rxnormEnabled()) initRxNorm();
    else console.log('[rxnorm] medication verification is OFF (set RXNORM_VERIFY=1 to enable).');
  }).catch(() => {});
  // ASR: Google Speech-to-Text. Audio longer than the API's ~60s synchronous limit is
  // decoded to PCM and split into windows server-side, so recordings of any length work.
  Promise.all([
    import('./src/asr/googleSpeech.js'),
    import('./src/asr/audio.js'),
  ]).then(async ([{ billableModel }, { ffmpegAvailable }]) => {
    const raw = process.env.ASR_MODEL || 'latest_long';
    const billed = billableModel(raw);
    console.log(`[asr] Google Speech-to-Text — model=${raw}${billed !== raw ? ` → billed as ${billed} (cost guard)` : ''} `
      + `lang=${process.env.ASR_LANGUAGE || 'en-US'} window=${process.env.ASR_WINDOW_SECONDS || 50}s`);
    // ffmpeg is REQUIRED for long recordings: without it the audio can't be decoded to
    // PCM, so it can't be split into windows and anything over ~60s fails again.
    const ff = await ffmpegAvailable();
    if (ff) console.log(`[asr] ✓ ${ff} — long recordings will be windowed`);
    else console.error('[asr] ✗ ffmpeg NOT FOUND on PATH — recordings longer than ~60s WILL FAIL. Install ffmpeg.');
    // Credentials for Speech-to-Text. Without them every ASR request fails at the call.
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credPath) {
      const { existsSync } = await import('node:fs');
      if (existsSync(credPath)) console.log(`[asr] ✓ GCP credentials: ${credPath}`);
      else console.error(`[asr] ✗ GOOGLE_APPLICATION_CREDENTIALS points at a missing file: ${credPath}`);
    } else {
      console.warn('[asr] GOOGLE_APPLICATION_CREDENTIALS is unset — relying on ambient GCP credentials (metadata server / gcloud login).');
    }
  }).catch((e) => console.warn(`[asr] startup check skipped: ${e.message}`));
  // Monitoring: ensure the ops.* schema exists, then run the alert checker on an interval.
  ensureOpsSchema().catch(() => {});
  if (process.env.OPS_ALERTS === '1') {
    const every = Number(process.env.OPS_ALERT_INTERVAL_MS) || 5 * 60_000;
    setInterval(() => checkAlerts().catch(() => {}), every).unref?.();
    console.log(`[ops] alerting ON — checking every ${Math.round(every / 1000)}s, email → ${process.env.OPS_ALERT_EMAIL || process.env.SUPPORT_EMAIL || process.env.SMTP_USER || '(unset)'}`);
  }
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;

// Fail with a clear, actionable message instead of an unhandled 'error' crash-loop when
// the port is already taken (a previous backend is still running). Common in dev on Windows.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n[backend] Port ${port} is already in use — another backend is still running.`);
    console.error(`[backend] Free it, then restart:`);
    console.error(`[backend]   Windows : npx kill-port ${port}   (or)  netstat -ano | findstr :${port}  →  taskkill /PID <pid> /F`);
    console.error(`[backend]   macOS/Linux: lsof -ti:${port} | xargs kill -9`);
    console.error(`[backend]   or set a different port:  PORT=8081 npm run dev:backend\n`);
    process.exit(1);
  }
  console.error('[backend] server error:', err);
  process.exit(1);
});

export { app };
