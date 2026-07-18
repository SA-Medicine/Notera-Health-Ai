// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Key-safe passthrough proxy (keeps ALL API keys in .env)
//
// Verbose error handling + centralized model config. Endpoints:
//   POST /api/llm/generate?model=…   → Gemini generateContent (retry 5xx + schema/token fallbacks)
//   POST /api/llm/stream?model=…      → Gemini streamGenerateContent (SSE)
//   POST /api/asr                     → Groq Whisper transcription (multipart)
//   GET  /api/llm/diag                → one-shot health probe (safe to call from the browser)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import express from 'express';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = () => process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_FLASH || 'gemini-3.5-flash';
const groqKey = () => process.env.GROQ_KEY_1 || process.env.GROQ_KEY_2 || process.env.GROQ_KEY || '';
const geminiKey = () => process.env.GEMINI_API_KEY || '';

// Centralized model config from .env so gemini-3.5-flash is used to its full capacity,
// consistently, on every call. Fills only values the caller didn't set (maxOutputTokens
// is raised to the env floor; temperature/thinking added if configured).
function applyModelDefaults(body) {
  const b = body || {};
  b.generationConfig = b.generationConfig || {};
  const gc = b.generationConfig;
  const maxOut = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 0);
  if (maxOut && (!gc.maxOutputTokens || gc.maxOutputTokens < maxOut)) gc.maxOutputTokens = maxOut;
  const temp = process.env.GEMINI_TEMPERATURE;
  if (temp !== undefined && temp !== '' && gc.temperature === undefined) gc.temperature = Number(temp);
  // Thinking is DISABLED — do not use thinking (force budget 0 on every call).
  gc.thinkingConfig = { thinkingBudget: 0 };
  return b;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = Number(process.env.LLM_PROXY_RETRIES || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 8);
const keyTail = (k) => (k ? `…${k.slice(-4)} (${k.length})` : 'MISSING');

async function callGemini(url, bodyObj, { label = 'gemini', id = rid() } = {}) {
  const bodyStr = JSON.stringify(bodyObj);
  let attempts = 0, lastText = '', lastStatus = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    attempts++;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyStr });
      const text = await res.text();
      lastText = text; lastStatus = res.status;
      if (res.ok) return { ok: true, status: res.status, text, attempts };
      console.error(`[proxy ${id}] ${label} attempt ${attempt + 1}/${MAX_RETRIES + 1} → ${res.status} ${res.statusText}`);
      console.error(`[proxy ${id}]   upstream body: ${text ? text.slice(0, 600) : '(empty)'}`);
      if (!RETRY_STATUS.has(res.status) || attempt === MAX_RETRIES) return { ok: false, status: res.status, text, attempts };
    } catch (err) {
      lastText = err.message; lastStatus = 0;
      console.error(`[proxy ${id}] ${label} attempt ${attempt + 1} network error: ${err.message}`);
      if (attempt === MAX_RETRIES) return { ok: false, status: 502, text: err.message, attempts, network: true };
    }
    await sleep(Math.min(500 * 2 ** attempt, 2000) + Math.random() * 150);
  }
  return { ok: false, status: lastStatus || 502, text: lastText, attempts };
}

function errorPayload(id, model, r, extra = {}) {
  let upstream;
  try { upstream = r.text ? JSON.parse(r.text) : null; } catch { upstream = r.text || null; }
  return {
    error: `Gemini upstream ${r.status}${r.network ? ' (network)' : ''}`,
    requestId: id, model, upstreamStatus: r.status, attempts: r.attempts,
    upstream: upstream || '(empty body from Gemini)',
    hint: r.status === 500 ? 'Gemini 500 — transient load / oversized schema / token limit. Client auto-retries without schema + lower tokens.'
      : r.status === 429 ? 'Rate limited — check quota.'
      : r.status === 404 ? 'Model not found for this key — check GEMINI_MODEL in .env.'
      : r.status === 400 ? 'Bad request — check model + request size.' : undefined,
    ...extra,
  };
}

export function mountProxy(app) {
  app.get('/api/llm/diag', async (_req, res) => {
    const id = rid(); const model = MODEL();
    console.log(`[proxy ${id}] DIAG model=${model} key=${keyTail(geminiKey())}`);
    const r = await callGemini(`${GEMINI_BASE}/${model}:generateContent?key=${geminiKey()}`,
      { contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }], generationConfig: { maxOutputTokens: 16 } },
      { label: 'diag', id });
    if (r.ok) return res.json({ ok: true, model, keyPresent: !!geminiKey(), sample: r.text.slice(0, 200) });
    res.status(r.status).json({ ok: false, keyPresent: !!geminiKey(), ...errorPayload(id, model, r) });
  });

  app.post('/api/llm/generate', async (req, res) => {
    const id = rid(); const model = MODEL();
    const base = applyModelDefaults(req.body || {});
    const gc = base.generationConfig || {};
    console.log(`[proxy ${id}] generate model=${model} key=${keyTail(geminiKey())} `
      + `bodyKB=${(JSON.stringify(base).length / 1024).toFixed(1)} schema=${!!gc.responseSchema} maxTokens=${gc.maxOutputTokens || 'default'}`);
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${geminiKey()}`;
    let r = await callGemini(url, base, { label: 'generate', id });
    if (!r.ok && r.status === 500 && gc.responseSchema) {
      console.warn(`[proxy ${id}] retrying generate WITHOUT responseSchema`);
      const b = structuredClone(base); delete b.generationConfig.responseSchema;
      r = await callGemini(url, b, { label: 'generate/no-schema', id });
      if (!r.ok && r.status === 500) {
        console.warn(`[proxy ${id}] retrying generate with maxOutputTokens=8192`);
        b.generationConfig.maxOutputTokens = 8192;
        r = await callGemini(url, b, { label: 'generate/low-tokens', id });
      }
    }
    if (r.ok) return res.status(200).type('application/json').send(r.text);
    console.error(`[proxy ${id}] generate FAILED after ${r.attempts} attempts → ${r.status}`);
    res.status(r.status).json(errorPayload(id, model, r));
  });

  app.post('/api/llm/stream', async (req, res) => {
    const id = rid(); const model = MODEL();
    try {
      let upstream, lastText = '', lastStatus = 0;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        upstream = await fetch(`${GEMINI_BASE}/${model}:streamGenerateContent?alt=sse&key=${geminiKey()}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(applyModelDefaults(req.body || {})) });
        if (upstream.ok) break;
        lastText = await upstream.text().catch(() => ''); lastStatus = upstream.status;
        console.error(`[proxy ${id}] stream attempt ${attempt + 1} → ${upstream.status}: ${lastText.slice(0, 400)}`);
        if (!RETRY_STATUS.has(upstream.status) || attempt === MAX_RETRIES) {
          return res.status(upstream.status).json(errorPayload(id, model, { status: lastStatus, text: lastText, attempts: attempt + 1 }));
        }
        await sleep(Math.min(500 * 2 ** attempt, 2000));
      }
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(dec.decode(value, { stream: true })); }
      res.end();
    } catch (err) {
      console.error(`[proxy ${id}] stream exception: ${err.message}`);
      if (!res.headersSent) res.status(502).json({ error: 'stream proxy: ' + err.message, requestId: id }); else res.end();
    }
  });

  app.post('/api/asr', express.raw({ type: () => true, limit: '30mb' }), async (req, res) => {
    const id = rid();
    try {
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqKey()}`, 'Content-Type': req.headers['content-type'] || 'multipart/form-data' },
        body: req.body,
      });
      const text = await r.text();
      if (!r.ok) console.error(`[proxy ${id}] asr ${r.status}: ${text.slice(0, 300)}`);
      res.status(r.status).type('application/json').send(text || `{"error":"groq ${r.status}","requestId":"${id}"}`);
    } catch (err) {
      console.error(`[proxy ${id}] asr exception: ${err.message}`);
      res.status(502).json({ error: 'asr proxy: ' + err.message, requestId: id });
    }
  });
}
