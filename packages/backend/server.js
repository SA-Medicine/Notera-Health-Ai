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

// Key-safe passthrough proxy for the embedded client app (keys stay in .env).
mountProxy(app);

// Product (clinician) auth gate. Every PHI route requires a valid SESSION cookie
// (from /api/auth/login). Service-token bearer auth is still accepted for trusted
// server-to-server callers. The old "production → allow all" bypass is REMOVED.
const _requireAuth = requireAuth(DATA_DIR);
app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  if (req.path.startsWith('/api/auth')) return next();            // login/reset are public
  if (req.path.startsWith('/api/llm') || req.path.startsWith('/api/asr')) return next(); // key-safe proxy
  if (!config.requireAuth) return next();                          // dev convenience (REQUIRE_AUTH=false)
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (config.serviceTokens.length && token && config.serviceTokens.includes(token)) return next();
  return _requireAuth(req, res, next);                             // else require a real session
});

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'notera-backend', version: config.pipelineVersion }));

app.post('/api/consults', async (req, res) => {
  try {
    const { transcript, audioUri, specialty, noteType, clinicianId, templateSystemPrompt, deidMode } = req.body || {};
    if (!transcript && !audioUri) return res.status(400).json({ error: 'transcript or audioUri required' });
    const result = await generateNote(
      { transcript, audioUri, specialty, noteType, clinicianId, templateSystemPrompt },
      { deidMode, includeLogs: !!req.body?.includeLogs }
    );
    res.json(result);
  } catch (err) { console.error('[/api/consults] error', err); res.status(500).json({ error: err.message }); }
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

const port = config.port;
const server = app.listen(port, () => {
  console.log(`Notera backend (unified) on :${port}  — product + admin/lab API  (llm=${config.llmBackend}, store=${config.firestoreDriver})`);
  // RxNorm medication verification (upgrade D-Tier2): ping the source at startup so its
  // availability is visible in the logs. Enabled with RXNORM_VERIFY=1; never blocks boot.
  import('./src/services/rxnorm.js').then(({ rxnormEnabled, initRxNorm }) => {
    if (rxnormEnabled()) initRxNorm();
    else console.log('[rxnorm] medication verification is OFF (set RXNORM_VERIFY=1 to enable).');
  }).catch(() => {});
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
