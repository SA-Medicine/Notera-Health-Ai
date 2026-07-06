// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Backend/API (private Cloud Run service; doc 07 §3, 10 §10)
// Orchestrator + key-safe LLM/ASR proxy. Stays PRIVATE in prod (Cloud Run IAM).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import './src/loadEnv.js'; // populate process.env from .env before anything reads it
import express from 'express';
import { config } from './src/config.js';
import { generateNote, approveNote } from './src/orchestrator/generateNote.js';
import { store, audit } from './src/firestore/store.js';
import { mountProxy } from './src/proxy.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS for /api — lets the embedded app (served by Next on :3000) call the backend
// DIRECTLY in dev, bypassing the Next rewrite proxy (whose socket timeout was
// killing the slow ~90s extraction call and returning a generic 500).
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Key-safe passthrough proxy for the embedded client app (keys stay in .env).
mountProxy(app);

// ── Auth: bearer token in dev; behind Cloud Run IAM in prod ──────────────────
app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  if (req.path.startsWith('/api/llm') || req.path.startsWith('/api/asr')) return next(); // proxy handled above
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
  } catch (err) {
    console.error('[/api/consults] error', err);
    res.status(500).json({ error: err.message });
  }
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
  console.log('Notera backend listening on :' + port + ' (llm=' + config.llmBackend + ', firestore=' + config.firestoreDriver + ')');
});
// The LLM extraction step can take ~90s — disable Node's request/headers timeouts
// so long generations are never killed mid-flight.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;

export { app };
