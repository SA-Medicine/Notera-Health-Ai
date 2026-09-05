// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Key-safe passthrough proxy (keeps ALL API keys in .env)
//
// Verbose error handling + centralized model config. Endpoints:
//   POST /api/llm/generate?model=…   → Gemini generateContent (retry 5xx + schema/token fallbacks)
//   POST /api/llm/stream?model=…      → Gemini streamGenerateContent (SSE)
//   POST /api/asr                     → ASR transcription (local Whisper or Google rollback)
//   GET  /api/llm/diag                → one-shot health probe (safe to call from the browser)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import express from 'express';
import { cleanupTempDir, extractMultipartFile, normalizeBufferToWav16k, transcodePcm16k } from './asr/audio.js';
import { localWhisperEnabled, transcribeLocalAudioFile } from './asr/localWhisper.js';

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

  // Medical ASR. Default is the existing Google Speech path for rollback compatibility.
  // Set ASR_PROVIDER=whisper_local to use local faster-whisper.
  // Accepts raw recorded audio bytes (MediaRecorder → WEBM/OPUS) or multipart field "file".
  // Returns { text, transcript, requestId, latencyMs } for frontend compatibility.
  app.post('/api/asr', express.raw({ type: () => true, limit: '30mb' }), async (req, res) => {
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
      if (localWhisperEnabled()) {
        let normalized = null;
        try {
          const tNormStart = Date.now();
          normalized = await normalizeBufferToWav16k(audio);
          const tNormMs = Date.now() - tNormStart;

          const tInferStart = Date.now();
          const r = await transcribeLocalAudioFile(normalized.wavPath, { requestId: id });
          const tInferMs = r.latency_ms ?? (Date.now() - tInferStart);

          const tTotalMs = Date.now() - t0;
          const audioSec = normalized.durationSeconds || r.duration || 0;
          const rtf = audioSec > 0 ? tInferMs / 1000 / audioSec : null;
          const endTimeStr = new Date().toISOString().slice(11, 23);

          console.log(`[proxy ${id}] ✅ ASR finished at ${endTimeStr} | audio=${audioSec.toFixed(2)}s | total=${tTotalMs}ms (norm=${tNormMs}ms infer=${tInferMs}ms) | RTF=${rtf == null ? 'n/a' : rtf.toFixed(3)} | model=${r.model} (${r.device}/${r.compute_type})`);
          const transcript = String(r.text || '').replace(/\s+/g, ' ').trim();
          return res.json({ text: transcript, transcript, requestId: id, latencyMs: tTotalMs });
        } finally {
          await cleanupTempDir(normalized?.tmpDir);
        }
      }
      // PRIMARY PATH: transcode to headerless 16 kHz mono PCM so Google reads an exact duration.
      // This is what makes short WebM/Opus clips work reliably (the container has no duration).
      let encoding, content;
      const pcm = await transcodePcm16k(audio);
      if (pcm && pcm.length) {
        encoding = 'LINEAR16';
        content = pcm.toString('base64');
      } else {
        // Fallback (ffmpeg unavailable): sniff the container from magic bytes and send as-is.
        //   WEBM/Matroska → 1A 45 DF A3;  OGG → "OggS";  WAV → "RIFF".
        encoding = 'WEBM_OPUS';
        if (audio[0] === 0x1a && audio[1] === 0x45 && audio[2] === 0xdf && audio[3] === 0xa3) encoding = 'WEBM_OPUS';
        else if (audio.slice(0, 4).toString() === 'OggS') encoding = 'OGG_OPUS';
        else if (audio.slice(0, 4).toString() === 'RIFF') encoding = 'LINEAR16';
        content = audio.toString('base64');
      }
      // ── Chirp 2 (Speech-to-Text V2) ─────────────────────────────────────────
      // Billed at the STANDARD $0.016/min (same as latest_long) but much more accurate
      // on conversational/accented medical speech — the single best value for a scribe.
      // Regional endpoint only (default us-central1). Falls back to the proven V1 path
      // below on ANY error, so transcription never breaks even if Chirp is unavailable.
      const asrModel = process.env.ASR_MODEL || 'latest_long';
      if (/^chirp/i.test(asrModel) && encoding === 'LINEAR16' && pcm && pcm.length) {
        try {
          const loc = process.env.ASR_V2_LOCATION || 'us-central1';
          const { SpeechClient: SpeechClientV2 } = (await import('@google-cloud/speech')).v2;
          const v2 = new SpeechClientV2({ apiEndpoint: `${loc}-speech.googleapis.com` });
          const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || await v2.getProjectId();
          const recognizer = `projects/${projectId}/locations/${loc}/recognizers/_`;
          const [r] = await v2.recognize({
            recognizer,
            config: {
              model: asrModel,   // 'chirp_2' (recommended) or 'chirp'
              languageCodes: [process.env.ASR_LANGUAGE || 'en-US'],
              features: { enableAutomaticPunctuation: true },
              explicitDecodingConfig: { encoding: 'LINEAR16', sampleRateHertz: 16000, audioChannelCount: 1 },
            },
            content: pcm,
          });
          const text = (r.results || []).map((x) => x.alternatives?.[0]?.transcript || '').join(' ').replace(/\s+/g, ' ').trim();
          console.log(`[proxy ${id}] asr(chirp v2) model=${asrModel} loc=${loc} → ${text.length} chars`);
          return res.json({ text, transcript: text, requestId: id });
        } catch (e) {
          console.warn(`[proxy ${id}] Chirp v2 failed (${e.message}); falling back to V1 latest_long`);
        }
      }
      const speech = (await import('@google-cloud/speech')).default;
      const client = new speech.SpeechClient();
      const baseConfig = {
        languageCode: process.env.ASR_LANGUAGE || 'en-US',
        encoding,
        useEnhanced: true,
        enableAutomaticPunctuation: true,
      };
      // PCM path is fixed at 16 kHz; the raw-fallback Opus path is 48 kHz.
      baseConfig.sampleRateHertz = encoding === 'LINEAR16'
        ? Number(process.env.ASR_SAMPLE_RATE || 16000)
        : Number(process.env.ASR_SAMPLE_RATE || 48000);
      // V1 path (fallback for Chirp, or when ASR_MODEL is a V1 model). ALWAYS standard-priced:
      // both 'chirp*' and any 'medical*' value are forced to 'latest_long' ($0.016/min) so the
      // premium 'medical_conversation' (~$0.078/min, 5×) can NEVER be billed, even by mistake.
      const primaryModel = /^chirp|medical/i.test(asrModel) ? 'latest_long' : asrModel;
      const runRecognize = async (model) => client.recognize({ audio: { content }, config: { ...baseConfig, model } });
      // LongRunningRecognize has NO 60s sync cap and accepts the same inline content (<10MB),
      // so it transcribes any segment length; we await its operation (a few seconds for a clip).
      const runLong = async (model) => {
        // Retry once on transient "14 UNAVAILABLE / Policy checks are unavailable".
        for (let attempt = 0; ; attempt++) {
          try {
            const [op] = await client.longRunningRecognize({ audio: { content }, config: { ...baseConfig, model } });
            const [r] = await op.promise();
            return r;
          } catch (e) {
            if (attempt < 1 && /UNAVAILABLE|Policy checks|deadline|internal/i.test(e.message)) {
              console.warn(`[proxy ${id}] longRunningRecognize transient (${e.message}); retrying once`);
              await new Promise((r) => setTimeout(r, 800)); continue;
            }
            throw e;
          }
        }
      };
      const approxSec = encoding === 'LINEAR16' && content ? Math.round(Buffer.byteLength(content, 'base64') / 2 / 16000) : null;
      console.log(`[proxy ${id}] asr(google-speech) in=${audio.length}B enc=${encoding}${approxSec != null ? ` ~${approxSec}s` : ''} model=${primaryModel}`);
      let response;
      try { [response] = await runRecognize(primaryModel); }
      catch (e) {
        const tooLong = /too long|sync input|exceeds|1 min|duration/i.test(e.message);
        if (tooLong) {
          // Audio > 60s → sync can't handle it; use LongRunningRecognize (latest_long).
          console.warn(`[proxy ${id}] asr sync too long — using longRunningRecognize`);
          response = await runLong('latest_long');
        } else {
          // medical_conversation may not be enabled/available in every project → fall back.
          console.warn(`[proxy ${id}] asr model '${primaryModel}' failed (${e.message}); retrying with latest_long`);
          try { [response] = await runRecognize('latest_long'); }
          catch (e2) { console.warn(`[proxy ${id}] latest_long sync failed (${e2.message}); using longRunningRecognize`); response = await runLong('latest_long'); }
        }
      }
      const transcript = (response.results || []).map((r) => r.alternatives?.[0]?.transcript || '').join(' ').replace(/\s+/g, ' ').trim();
      // Return BOTH keys so every client works: the DAS webapp reads `text`, others read `transcript`.
      res.json({ text: transcript, transcript, requestId: id });
    } catch (err) {
      const provider = localWhisperEnabled() ? 'whisper-local' : 'google-speech';
      console.error(`[proxy ${id}] asr(${provider}) error: ${err.message}`);
      // Monitoring: log ASR failures to the ops error log (fire-and-forget).
      try {
        const code = /timed out|timeout/i.test(err.message) ? 'ASR_TIMEOUT' : 'ASR_ERROR';
        import('./ops/opsLog.js').then(({ recordError }) => recordError({
          source: 'asr', level: 'error', code, message: err.message, context: { provider, requestId: id },
        })).catch(() => {});
      } catch { /* never break */ }
      const hint = /too long|sync input|exceeds|duration/i.test(err.message)
        ? 'Recording too long for instant transcription (≈1 min max). Record in shorter segments, or ask to enable long-audio transcription.'
        : undefined;
      const localReason = /ffmpeg|codec|invalid data|conversion/i.test(err.message) ? 'audio conversion failed'
        : /timed out|timeout/i.test(err.message) ? 'transcription timed out'
        : /worker|model|faster|whisper|python/i.test(err.message) ? 'local ASR unavailable'
        : 'transcription failed';
      res.status(502).json({ error: provider === 'whisper-local' ? `ASR failed: ${localReason}` : 'ASR failed: ' + err.message, requestId: id, hint });
    }
  });
}
