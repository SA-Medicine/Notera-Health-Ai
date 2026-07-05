// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Key-safe passthrough proxy (keeps ALL API keys in .env)
//
// The embedded client app (web/public/das) calls these instead of Google/Groq
// directly, so no API key ever lives in the frontend. Each route injects the
// server-side .env key and forwards the request verbatim.
//   POST /api/llm/generate?model=…   → Gemini generateContent
//   POST /api/llm/stream?model=…      → Gemini streamGenerateContent (SSE)
//   POST /api/asr                     → Groq Whisper transcription (multipart)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import express from 'express';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// One model for everything (no Pro tier). Client-sent model names are ignored so
// stale/preview names can never cause a 404 — the .env value is the single truth.
const MODEL = () => process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_FLASH || 'gemini-3-flash-preview';
const groqKey = () => process.env.GROQ_KEY_1 || process.env.GROQ_KEY_2 || process.env.GROQ_KEY || '';
const geminiKey = () => process.env.GEMINI_API_KEY || '';

export function mountProxy(app) {
  // Gemini — single-shot
  app.post('/api/llm/generate', async (req, res) => {
    try {
      const model = MODEL();
      const r = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${geminiKey()}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
      });
      const text = await r.text();
      res.status(r.status).type('application/json').send(text);
    } catch (err) { res.status(502).json({ error: 'llm proxy: ' + err.message }); }
  });

  // Gemini — streaming (SSE passthrough)
  app.post('/api/llm/stream', async (req, res) => {
    try {
      const model = MODEL();
      const upstream = await fetch(`${GEMINI_BASE}/${model}:streamGenerateContent?alt=sse&key=${geminiKey()}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
      });
      res.status(upstream.status);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      if (!upstream.body) return res.end();
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(dec.decode(value, { stream: true }));
      }
      res.end();
    } catch (err) { res.status(502).end('llm stream proxy: ' + err.message); }
  });

  // Groq Whisper — multipart passthrough (raw body forwarded verbatim with .env key)
  app.post('/api/asr', express.raw({ type: () => true, limit: '30mb' }), async (req, res) => {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqKey()}`, 'Content-Type': req.headers['content-type'] || 'multipart/form-data' },
        body: req.body,
      });
      const text = await r.text();
      res.status(r.status).type('application/json').send(text);
    } catch (err) { res.status(502).json({ error: 'asr proxy: ' + err.message }); }
  });
}
