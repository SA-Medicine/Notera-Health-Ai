// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Backend/API (private Cloud Run service; doc 07 §3, 10 §10)
//
// The orchestrator. Receives transcript/audio from the Next.js server, runs the
// deid → NER → pipeline → structure → guardrails flow, persists to Firestore.
// Stays PRIVATE — only the web app's service account can invoke it (doc 07 §3).
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

// Key-safe passthrough proxy for the embedded client app (keys stay in .env).
mountProxy(app);

// ── Auth: bearer token in dev; behind Cloud Run IAM in prod ──────────────────
app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  if (!config.requireAuth) return next();
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (config.serviceTokens.length && config.serviceTokens.includes(token)) return next();
  // In prod, Cloud Run IAM already validated the Google ID token before reaching us.
  if (config.nodeEnv === 'production') return next();
  return res.status(401).json({ error: 'unauthorized' });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'notera-backend', version: config.pipelineVersion }));

// Generate a draft note from a transcript (or GCS audio URI).
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

// Fetch a consult (draft + status) for the review screen.
app.get('/api/consults/:id', async (req, res) => {
  try {
    const c = await store.getConsult(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    await audit({ consultId: c.consultId, actor: req.header('x-clinician-id') || 'unknown', action: 'consult.viewed' });
    res.json(c);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List recent consults (history screen).
app.get('/api/consults', async (req, res) => {
  try { res.json({ consults: await store.listConsults(Number(req.query.limit) || 50) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Clinician sign-off — writes finals + captures the edit diff (feedback).
app.post('/api/consults/:id/approve', async (req, res) => {
  try {
    const { draftId, finalNote, clinicianId } = req.body || {};
    if (!finalNote) return res.status(400).json({ error: 'finalNote required' });
    const result = await approveNote({ consultId: req.params.id, draftId, finalNote, clinicianId });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const port = config.port;
app.listen(port, () => {
  console.log('Notera backend listening on :' + port + ' (llm=' + config.llmBackend + ', firestore=' + config.firestoreDriver + ')');
});

export { app };
