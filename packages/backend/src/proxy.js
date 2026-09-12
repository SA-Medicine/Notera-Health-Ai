// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Key-safe passthrough proxy (keeps ALL API keys in .env)
//
// Verbose error handling + centralized model config. Endpoints:
//   POST /api/llm/generate?model=…   → Gemini generateContent (retry 5xx + schema/token fallbacks)
//   POST /api/llm/stream?model=…      → Gemini streamGenerateContent (SSE)
//   POST /api/asr                     → ASR transcription (Google Speech-to-Text, any length)
//   GET  /api/llm/diag                → one-shot health probe (safe to call from the browser)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import express from 'express';
import { extractMultipartFile, transcodePcm16k } from './asr/audio.js';
import { billableModel, transcribeChirpPcm, transcribePcm } from './asr/googleSpeech.js';
import { collapseRepetitions } from './validation/textSimilarity.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = () => process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_FLASH || 'gemini-3.7-flash';
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

  // ── Medical ASR (Google Speech-to-Text) ────────────────────────────────────
  // Accepts raw recorded audio bytes (MediaRecorder → WEBM/OPUS) or multipart field
  // "file", of ANY length: the audio is decoded to 16 kHz mono PCM and, when it is
  // longer than the API's ~60s synchronous limit, split into windows and stitched back
  // together. Returns { text, transcript, requestId, latencyMs } for frontend compatibility.
  //
  // The upload limit has to cover a WHOLE consult, not just a 20s chunk: after a long
  // session the client may re-send the full recording to recover segments that failed.
  // WebM/Opus is ~0.5 MB/minute, so 120 MB is roughly four hours.
  app.post('/api/asr', express.raw({ type: () => true, limit: process.env.ASR_MAX_UPLOAD || '120mb' }), async (req, res) => {
    const id = rid();
    const t0 = Date.now();
    const startTimeStr = new Date(t0).toISOString().slice(11, 23);
    try {
      let audio = req.body;
      if (!audio || !audio.length) return res.status(400).json({ error: 'no audio received', requestId: id });
      const ct = String(req.headers['content-type'] || '');
      // The DAS webapp sends multipart/form-data (field "file"); extract the raw audio bytes.
      if (/multipart\/form-data/i.test(ct)) {
        const extracted = extractMultipartFile(audio, ct);
        if (extracted) audio = extracted;
      }
      console.log(`[proxy ${id}] 🎙️ ASR received at ${startTimeStr} | bytes=${audio.length}B`);

      // Decode to headerless 16 kHz mono PCM. This is what makes the duration EXACT
      // (WebM/Opus carries no duration, which is why short clips used to be rejected as
      // "sync input too long") and it is the only form we can window reliably.
      const tDecode = Date.now();
      const pcm = await transcodePcm16k(audio);
      const decodeMs = Date.now() - tDecode;

      // Cost guard: billableModel() forces any premium model down to the cheapest
      // standard one ($0.016/min), which is what production bills. It is enforced again
      // inside googleSpeech.js at the point the request is issued, so the premium
      // 'medical_conversation' (~5×) can never be billed by any path.
      const asrModel = process.env.ASR_MODEL || 'latest_long';
      const model = billableModel(asrModel, (l) => console.log(`[proxy ${id}] ${l}`));

      if (pcm && pcm.length) {
        // Chirp 2 (Speech-to-Text V2): standard-priced and much more accurate on
        // conversational/accented medical speech. It shares V1's ~60s synchronous limit,
        // so it is windowed exactly the same way — a long recording keeps the model it was
        // configured with instead of silently dropping to latest_long. Any failure falls
        // back to the V1 path below.
        if (/^chirp/i.test(asrModel)) {
          try {
            const r = await transcribeChirpPcm(pcm, {
              model: asrModel,
              languageCode: process.env.ASR_LANGUAGE || 'en-US',
              log: (l) => console.log(`[proxy ${id}] ${l}`),
            });
            const text = collapseRepetitions(r.text);
            const totalMs = Date.now() - t0;
            console.log(`[proxy ${id}] ✅ ASR finished | chirp v2 ${asrModel} | audio=${r.durationSeconds.toFixed(1)}s `
              + `| total=${totalMs}ms (decode=${decodeMs}ms) | windows=${r.windows}${r.failedWindows ? ` (${r.failedWindows} failed)` : ''} | ${text.length} chars`);
            return res.json({
              text, transcript: text, requestId: id, latencyMs: totalMs,
              durationSeconds: r.durationSeconds, windows: r.windows, failedWindows: r.failedWindows,
            });
          } catch (e) {
            console.warn(`[proxy ${id}] Chirp v2 failed (${e.message}); falling back to V1 ${model}`);
          }
        }

        const r = await transcribePcm(pcm, {
          model,
          languageCode: process.env.ASR_LANGUAGE || 'en-US',
          log: (l) => console.log(`[proxy ${id}] ${l}`),
        });
        // A decoder can repeat a phrase over and over; collapse those runs so the
        // artefact never reaches the note as duplicated content.
        const text = collapseRepetitions(r.text);
        const totalMs = Date.now() - t0;
        const rtf = r.durationSeconds > 0 ? totalMs / 1000 / r.durationSeconds : null;
        console.log(`[proxy ${id}] ✅ ASR finished at ${new Date().toISOString().slice(11, 23)} `
          + `| audio=${r.durationSeconds.toFixed(1)}s | total=${totalMs}ms (decode=${decodeMs}ms) `
          + `| windows=${r.windows}${r.failedWindows ? ` (${r.failedWindows} failed)` : ''} `
          + `| RTF=${rtf == null ? 'n/a' : rtf.toFixed(3)} | model=${model}`);
        return res.json({
          text, transcript: text, requestId: id, latencyMs: totalMs,
          durationSeconds: r.durationSeconds, windows: r.windows, failedWindows: r.failedWindows,
        });
      }

      // FALLBACK: ffmpeg unavailable. Send the container as-is and let Google decode it.
      // Duration is unknown here, so this path is limited to what sync recognize accepts.
      let encoding = 'WEBM_OPUS';
      if (audio[0] === 0x1a && audio[1] === 0x45 && audio[2] === 0xdf && audio[3] === 0xa3) encoding = 'WEBM_OPUS';
      else if (audio.slice(0, 4).toString() === 'OggS') encoding = 'OGG_OPUS';
      else if (audio.slice(0, 4).toString() === 'RIFF') encoding = 'LINEAR16';
      console.warn(`[proxy ${id}] ffmpeg unavailable — sending ${encoding} container as-is (long audio cannot be windowed on this path)`);
      const speech = (await import('@google-cloud/speech')).default;
      const client = new speech.SpeechClient();
      const [response] = await client.recognize({
        audio: { content: audio.toString('base64') },
        config: {
          languageCode: process.env.ASR_LANGUAGE || 'en-US',
          encoding,
          useEnhanced: true,
          enableAutomaticPunctuation: true,
          sampleRateHertz: encoding === 'LINEAR16'
            ? Number(process.env.ASR_SAMPLE_RATE || 16000)
            : Number(process.env.ASR_SAMPLE_RATE || 48000),
          model,
        },
      });
      const raw = (response.results || []).map((r) => r.alternatives?.[0]?.transcript || '').join(' ').replace(/\s+/g, ' ').trim();
      const text = collapseRepetitions(raw);
      // Return BOTH keys so every client works: the DAS webapp reads `text`, others read `transcript`.
      res.json({ text, transcript: text, requestId: id, latencyMs: Date.now() - t0 });
    } catch (err) {
      console.error(`[proxy ${id}] asr(google-speech) error: ${err.message}`);
      // Monitoring: log ASR failures to the ops error log (fire-and-forget).
      try {
        const code = /timed out|timeout|deadline/i.test(err.message) ? 'ASR_TIMEOUT' : 'ASR_ERROR';
        import('./ops/opsLog.js').then(({ recordError }) => recordError({
          source: 'asr', level: 'error', code, message: err.message, context: { provider: 'google-speech', requestId: id },
        })).catch(() => {});
      } catch { /* never break */ }
      // Transient upstream trouble (quota, UNAVAILABLE, a deadline) is RETRIABLE: answer
      // 503 with Retry-After so the client re-sends that segment instead of writing the
      // audio off as lost. The old handler returned 502 for everything, and the recorder
      // counted each one as silence — which is how a long consult ended up with no
      // transcript at all.
      const transient = /UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE|deadline|internal|Policy checks|429|503|504|ECONNRESET|ETIMEDOUT|socket hang up|timed out|timeout/i.test(err.message);
      const hint = /ffmpeg/i.test(err.message)
        ? 'Audio conversion failed on the server (is ffmpeg installed?).'
        : transient ? 'Speech service was briefly unavailable — retrying usually succeeds.'
        : undefined;
      if (transient) res.setHeader('Retry-After', '5');
      res.status(transient ? 503 : 502).json({
        error: 'ASR failed: ' + err.message, requestId: id, hint, retriable: transient,
      });
    }
  });
}
