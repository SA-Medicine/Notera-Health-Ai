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
import { adminHandler } from './src/admin/handler.js';

const app = express();

// CORS (dev): the Next app on :3000 may call the backend directly.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Admin / Testing-Lab API ──────────────────────────────────────────────────
// Dispatched BEFORE express.json so the handler owns the request stream (SSE,
// large JSON imports, its own body parser). It calls next() for non-admin paths.
const ADMIN_PREFIXES = [
  '/api/login', '/api/logout', '/api/session', '/api/scripts', '/api/runs',
  '/api/results', '/api/metrics', '/api/prompts', '/api/patients', '/api/lab',
  '/api/sessions', '/api/judge', '/api/config',
];
app.use((req, res, next) => {
  if (ADMIN_PREFIXES.some((pre) => req.path === pre || req.path.startsWith(pre + '/'))) {
    return adminHandler(req, res, next);
  }
  next();
});

// ── Product API (clinician) ──────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// Key-safe passthrough proxy for the embedded client app (keys stay in .env).
mountProxy(app);

app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  if (req.path.startsWith('/api/llm') || req.path.startsWith('/api/asr')) return next();
  if (!config.requireAuth) return next();
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (config.serviceTokens.length && config.serviceTokens.includes(token)) return next();
  if (config.nodeEnv === 'production') return next();
  return res.status(401).json({ error: 'unauthorized' });
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
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;

export { app };
