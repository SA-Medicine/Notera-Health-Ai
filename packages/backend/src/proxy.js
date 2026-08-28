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
const MODEL = () => process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_FLASH || 'gemini-3.7-flash';
const groqKey = () => process.env.GROQ_KEY_1 || process.env.GROQ_KEY_2 || process.env.GROQ_KEY || '';
const geminiKey = () => process.env.GEMINI_API_KEY || '';

// ── LLM backend selection: Vertex AI (HIPAA/BAA) vs AI Studio (API key) ──────
const isVertex = () => (process.env.LLM_BACKEND || 'ai_studio') === 'vertex';
let _vertexAuth = null;
async function vertexToken() {
  const { GoogleAuth } = await import('google-auth-library');
  _vertexAuth = _vertexAuth || new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  return _vertexAuth.getAccessToken();   // cached + auto-refreshed by the library
}
// Resolve the upstream {url, headers} for a model call, depending on the backend.
async function resolveTarget(model, { stream = false } = {}) {
  const verb = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  if (isVertex()) {
    const proj = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    const loc = process.env.VERTEX_LOCATION || 'us-central1';
    const host = loc === 'global' ? 'https://aiplatform.googleapis.com' : `https://${loc}-aiplatform.googleapis.com`;
    const url = `${host}/v1/projects/${proj}/locations/${loc}/publishers/google/models/${model}:${verb}`;
    const token = await vertexToken();
    return { url, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
  }
  const sep = verb.includes('?') ? '&' : '?';
  return { url: `${GEMINI_BASE}/${model}:${verb}${sep}key=${geminiKey()}`, headers: { 'Content-Type': 'application/json' } };
}

// Centralized model config from .env so gemini-3.5-flash is used to its full capacity,
// consistently, on every call. Fills only values the caller didn't set (maxOutputTokens
// is raised to the env floor; temperature/thinking added if configured).
function applyModelDefaults(body) {
  const b = body || {};
  b.generationConfig = b.generationConfig || {};
  const gc = b.generationConfig;
  const maxOut = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 65536;
  if (!gc.maxOutputTokens || gc.maxOutputTokens < maxOut) gc.maxOutputTokens = maxOut;
  const temp = process.env.GEMINI_TEMPERATURE;
  if (temp !== undefined && temp !== '' && gc.temperature === undefined) gc.temperature = Number(temp);
  // Reasoning depth from env (gemini-3.x): high|low|off. Defaults to no thinking.
  const thinkingLevel = process.env.GEMINI_THINKING_LEVEL;
  if (thinkingLevel && String(thinkingLevel).toLowerCase() !== 'off') gc.thinkingConfig = { thinkingLevel: String(thinkingLevel).toLowerCase() };
  else gc.thinkingConfig = { thinkingBudget: 0 };
  return b;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = Number(process.env.LLM_PROXY_RETRIES || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 8);
const keyTail = (k) => (k ? `…${k.slice(-4)} (${k.length})` : 'MISSING');

async function callGemini(url, bodyObj, { label = 'gemini', id = rid(), headers = { 'Content-Type': 'application/json' } } = {}) {
  const bodyStr = JSON.stringify(bodyObj);
  let attempts = 0, lastText = '', lastStatus = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    attempts++;
    try {
      const res = await fetch(url, { method: 'POST', headers, body: bodyStr });
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
    console.log(`[proxy ${id}] DIAG model=${model} backend=${isVertex() ? 'vertex' : 'ai_studio'} key=${keyTail(geminiKey())}`);
    const { url, headers } = await resolveTarget(model);
    const r = await callGemini(url,
      { contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }], generationConfig: { maxOutputTokens: 16 } },
      { label: 'diag', id, headers });
    if (r.ok) return res.json({ ok: true, model, backend: isVertex() ? 'vertex' : 'ai_studio', sample: r.text.slice(0, 200) });
    res.status(r.status).json({ ok: false, keyPresent: !!geminiKey(), ...errorPayload(id, model, r) });
  });

  app.post('/api/llm/generate', async (req, res) => {
    const id = rid(); const model = MODEL();
    const base = applyModelDefaults(req.body || {});
    const gc = base.generationConfig || {};
    console.log(`[proxy ${id}] generate model=${model} backend=${isVertex() ? 'vertex' : 'ai_studio'} `
      + `bodyKB=${(JSON.stringify(base).length / 1024).toFixed(1)} schema=${!!gc.responseSchema} maxTokens=${gc.maxOutputTokens || 'default'}`);
    const { url, headers } = await resolveTarget(model);
    let r = await callGemini(url, base, { label: 'generate', id, headers });
    if (!r.ok && r.status === 500 && gc.responseSchema) {
      console.warn(`[proxy ${id}] retrying generate WITHOUT responseSchema`);
      const b = structuredClone(base); delete b.generationConfig.responseSchema;
      r = await callGemini(url, b, { label: 'generate/no-schema', id, headers });
      if (!r.ok && r.status === 500) {
        console.warn(`[proxy ${id}] retrying generate with maxOutputTokens=8192`);
        b.generationConfig.maxOutputTokens = 8192;
        r = await callGemini(url, b, { label: 'generate/low-tokens', id, headers });
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
      const { url: streamUrl, headers: streamHeaders } = await resolveTarget(model, { stream: true });
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        upstream = await fetch(streamUrl,
          { method: 'POST', headers: streamHeaders, body: JSON.stringify(applyModelDefaults(req.body || {})) });
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

  // Medical ASR via Google Cloud Speech-to-Text (HIPAA-covered under your BAA; uses the
  // service-account ADC). Accepts the raw recorded audio bytes (MediaRecorder → WEBM/OPUS).
  // Synchronous recognize handles short clips (≤ ~1 min). Returns { transcript }.
  app.post('/api/asr', express.raw({ type: () => true, limit: '30mb' }), async (req, res) => {
    const id = rid();
    try {
      const audio = req.body;
      if (!audio || !audio.length) return res.status(400).json({ error: 'no audio received', requestId: id });
      const ct = String(req.headers['content-type'] || '');
      const encoding = /webm/i.test(ct) ? 'WEBM_OPUS' : /ogg/i.test(ct) ? 'OGG_OPUS' : /wav|l16|linear/i.test(ct) ? 'LINEAR16' : 'WEBM_OPUS';
      const speech = (await import('@google-cloud/speech')).default;
      const client = new speech.SpeechClient();
      const baseConfig = {
        languageCode: process.env.ASR_LANGUAGE || 'en-US',
        encoding,
        useEnhanced: true,
        enableAutomaticPunctuation: true,
      };
      if (encoding === 'LINEAR16') baseConfig.sampleRateHertz = Number(process.env.ASR_SAMPLE_RATE || 16000);
      else baseConfig.sampleRateHertz = Number(process.env.ASR_SAMPLE_RATE || 48000);   // MediaRecorder WEBM/OGG Opus is 48 kHz
      const primaryModel = process.env.ASR_MODEL || 'medical_conversation';
      const runRecognize = async (model) => client.recognize({ audio: { content: audio.toString('base64') }, config: { ...baseConfig, model } });
      console.log(`[proxy ${id}] asr(google-speech) bytes=${audio.length} enc=${encoding} model=${primaryModel}`);
      let response;
      try { [response] = await runRecognize(primaryModel); }
      catch (e) {
        // medical_conversation may not be enabled/available in every project → fall back.
        console.warn(`[proxy ${id}] asr model '${primaryModel}' failed (${e.message}); retrying with latest_long`);
        [response] = await runRecognize('latest_long');
      }
      const transcript = (response.results || []).map((r) => r.alternatives?.[0]?.transcript || '').join(' ').replace(/\s+/g, ' ').trim();
      res.json({ transcript, requestId: id });
    } catch (err) {
      console.error(`[proxy ${id}] asr(google-speech) error: ${err.message}`);
      const hint = /too long|sync input|exceeds|duration/i.test(err.message)
        ? 'Recording too long for instant transcription (≈1 min max). Record in shorter segments, or ask to enable long-audio transcription.'
        : undefined;
      res.status(502).json({ error: 'ASR failed: ' + err.message, requestId: id, hint });
    }
  });
}
