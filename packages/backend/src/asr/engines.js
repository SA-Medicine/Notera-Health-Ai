// Speech-to-text ENGINE CHAIN: a primary engine, ordered fallbacks and a switch the owner controls from the admin console.
//
//   engines   chirp_3 (Google's newest, V2)  ·  chirp_2 (V2)  ·  latest_long (V1 standard, cheapest Google model)
//             gemini-2.5-flash / gemini-3.7-flash (multimodal audio transcription)
//   chain     primary -> fallback 1 -> fallback 2 ...   An engine is skipped while its circuit breaker is open.
//   fallback  on an error or timeout, AND when an engine returns NOTHING for audio that clearly contains speech (a silent failure that a
//             plain try/catch never sees).
//   guard     an engine whose output is impossible (more than ~260 words a minute, or the same phrase over and over) counts as FAILED: Chirp 3 once
//             produced a 10,000-word repetition loop on an 11-minute real recording.
//   default   ASR_MODEL (chirp_2) first, then Gemini 2.5 Flash (a different provider path, equally accurate, ~8× cheaper), then latest_long.
//
// Settings live in ops.asr_settings (editable in the admin console, cached 30 s); health counters are in memory. The cost guard in
// googleSpeech.js still applies to every Google V1 request. Never logs audio or transcript text.
'use strict';

import { query, one } from '../db/pool.js';
import { transcribeChirpPcm, transcribePcm, planWindows, pcmDurationSeconds, _BYTES_PER_SECOND } from './googleSpeech.js';

export const ENGINES = {
  chirp_3:            { label: 'Chirp 3', provider: 'Google Speech-to-Text V2', kind: 'v2', price_per_min: 0.016, note: 'Google’s newest model; V2 multi-region "us". Slightly more accurate than Chirp 2 in the benchmark, but looped on one real recording: keep it behind the output guard.' },
  chirp_2:            { label: 'Chirp 2', provider: 'Google Speech-to-Text V2', kind: 'v2', price_per_min: 0.016, note: 'Google’s previous flagship; production default.' },
  latest_long:        { label: 'Latest Long', provider: 'Google Speech-to-Text V1', kind: 'v1', price_per_min: 0.016, note: 'Cheapest standard Google model.' },
  'gemini-2.5-flash': { label: 'Gemini 2.5 Flash (audio)', provider: 'Vertex AI Gemini', kind: 'gemini', price_per_min: 0.002, note: 'General multimodal model used for transcription; about 8× cheaper than Google STT.' },
  'gemini-3.7-flash': { label: 'Gemini 3.7 Flash (audio)', provider: 'Vertex AI Gemini', kind: 'gemini', price_per_min: 0.002, note: 'Newest Gemini Flash; transcription by prompt.' },
};
export const isEngine = (n) => Object.prototype.hasOwnProperty.call(ENGINES, n);

// ── settings ──
export function defaultSettings(env = process.env) {
  const asr = String(env.ASR_MODEL || 'latest_long');
  const primary = isEngine(asr) ? asr : 'latest_long';
  const fallbacks = primary === 'latest_long' ? [] : primary.startsWith('gemini') ? ['latest_long'] : ['gemini-2.5-flash', 'latest_long'];
  return { primary, fallbacks, timeoutMs: 60000, breakerFailures: 3, breakerCooldownMs: 300000, speechCheck: true };
}
export function validateSettings(raw, base = defaultSettings()) {
  const s = { ...base, ...(raw || {}) };
  if (!isEngine(s.primary)) throw new Error(`unknown engine "${s.primary}"`);
  s.fallbacks = [...new Set((Array.isArray(s.fallbacks) ? s.fallbacks : []).filter((e) => e !== s.primary))];
  for (const f of s.fallbacks) if (!isEngine(f)) throw new Error(`unknown engine "${f}"`);
  if (s.fallbacks.length > 3) throw new Error('at most three fallbacks');
  const num = (v, lo, hi, k) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be between ${lo} and ${hi}`); return n; };
  s.timeoutMs = num(s.timeoutMs, 5000, 180000, 'timeoutMs'); s.breakerFailures = num(s.breakerFailures, 1, 20, 'breakerFailures'); s.breakerCooldownMs = num(s.breakerCooldownMs, 10000, 3600000, 'breakerCooldownMs');
  s.speechCheck = !!s.speechCheck;
  return s;
}

let _ready = null;
const ensure = () => (_ready ||= query(`CREATE SCHEMA IF NOT EXISTS ops; CREATE TABLE IF NOT EXISTS ops.asr_settings (id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), value JSONB NOT NULL, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`).catch((e) => { _ready = null; throw e; }));
let _cache = { at: 0, value: null };
export function clearAsrSettingsCache() { _cache = { at: 0, value: null }; }

export async function getSettings() {
  if (_cache.value && Date.now() - _cache.at < 30_000) return _cache.value;
  let v = defaultSettings();
  try {
    if (process.env.DATABASE_URL) { await ensure(); const row = await one(`SELECT value FROM ops.asr_settings WHERE id = 1`); if (row?.value) v = validateSettings(row.value); }
  } catch { /* database trouble or a bad stored value: keep the defaults, never fail a transcription */ }
  _cache = { at: Date.now(), value: v }; return v;
}
export async function saveSettings(raw, by = '') {
  const v = validateSettings(raw); await ensure();
  await query(`INSERT INTO ops.asr_settings (id, value, updated_by, updated_at) VALUES (1, $1::jsonb, $2, now()) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [JSON.stringify(v), by]);
  clearAsrSettingsCache(); return v;
}
/** The "re-transcribe from the saved recording" pass: Gemini 2.5 Flash first (about 8x cheaper than Google STT and as accurate), Chirp 2 only if Gemini fails. Fits inside the 100 s proxy limit. */
export function rerunSettings(base = defaultSettings()) { return validateSettings({ ...base, primary: 'gemini-2.5-flash', fallbacks: ['chirp_2'], timeoutMs: 85000, speechCheck: true }, base); }
export async function resetSettings() { await ensure(); await query(`DELETE FROM ops.asr_settings WHERE id = 1`); clearAsrSettingsCache(); return defaultSettings(); }
export async function settingsMeta() { try { await ensure(); return await one(`SELECT updated_by, updated_at FROM ops.asr_settings WHERE id = 1`); } catch { return null; } }

// ── health (in memory) ──
const HEALTH = {};
const H = (e) => (HEALTH[e] ||= { calls: 0, ok: 0, fail: 0, empty: 0, fallbackServed: 0, consecutiveFail: 0, openUntil: 0, lastError: '', lastAt: 0, msSum: 0 });
export const breakerOpen = (e, now = Date.now()) => H(e).openUntil > now;
export function healthSnapshot(now = Date.now()) { return Object.fromEntries(Object.keys(ENGINES).map((e) => { const h = H(e); return [e, { ...h, avgMs: h.ok ? Math.round(h.msSum / h.ok) : null, breakerOpen: h.openUntil > now, openForMs: Math.max(0, h.openUntil - now) }]; })); }
export function resetHealth(engine) { if (engine) delete HEALTH[engine]; else for (const k of Object.keys(HEALTH)) delete HEALTH[k]; }
function note(engine, kind, { ms = 0, error = '', s, now = Date.now() } = {}) {
  const h = H(engine); h.lastAt = now; h.calls += 1;
  if (kind === 'ok') { h.ok += 1; h.consecutiveFail = 0; h.msSum += ms; }
  else if (kind === 'empty') { h.empty += 1; }
  else { h.fail += 1; h.consecutiveFail += 1; h.lastError = String(error).slice(0, 160); if (s && h.consecutiveFail >= s.breakerFailures) h.openUntil = now + s.breakerCooldownMs; }
}

/** Is this transcript humanly possible for this much audio? Returns '' when fine, otherwise the reason (used to reject loops and run-ons). */
export function implausible(text, seconds) {
  const w = String(text || '').toLowerCase().match(/[a-z0-9']+/g) || []; if (w.length < 60) return '';
  if (seconds >= 10 && w.length / (seconds / 60) > 260) return `${Math.round(w.length / (seconds / 60))} words a minute`;
  if (w.length >= 150) { const grams = new Set(); for (let i = 0; i + 4 <= w.length; i++) grams.add(w.slice(i, i + 4).join(' ')); if (grams.size / (w.length - 3) < 0.3) return 'the same phrase repeated over and over'; }
  return '';
}

/** Does this audio clearly contain speech? (mean absolute amplitude of 16-bit PCM, sampled; silence and room noise stay below the threshold) */
export function speechLike(pcm, { threshold = 500, minSeconds = 3 } = {}) {
  if (!pcm || pcm.length < minSeconds * _BYTES_PER_SECOND) return false;
  let sum = 0, n = 0; for (let i = 0; i + 1 < pcm.length; i += 2 * 32) { sum += Math.abs(pcm.readInt16LE(i)); n++; }
  return n > 0 && sum / n >= threshold;
}

// ── engine runners ──
function pcmToWav(pcm) {
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]);
}
const GEMINI_PROMPT = 'Transcribe this recorded medical consultation word for word, in English, as plain text without speaker labels. Write numbers, doses and drug names exactly as spoken. Do not summarise, correct, explain or add anything. If there is no speech, output nothing.';
async function geminiRunner(pcm, model, log) {
  const { createGeminiService } = await import('../services/LLMService.js');
  const svc = await createGeminiService(null, { model }); const url = svc._endpoint(false, model); const durationSeconds = pcmDurationSeconds(pcm.length);
  const windows = planWindows(pcm, { windowSeconds: 120 }); const parts = new Array(windows.length).fill(''); let failed = 0; let next = 0;
  const one = async (i) => {
    const body = { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: pcmToWav(pcm.subarray(windows[i].start, windows[i].end)).toString('base64') } }, { text: GEMINI_PROMPT }] }], generationConfig: { temperature: 0, maxOutputTokens: 16000, thinkingConfig: { thinkingBudget: 0 } } };
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = await svc._authHeaders(); const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(80000) }); const j = await r.json();
      if (r.status === 429 && attempt < 2) { await new Promise((res) => setTimeout(res, 3000 * (attempt + 1))); continue; }   // quota: wait and retry
      if (!r.ok) throw new Error(`gemini ${r.status}: ${JSON.stringify(j).slice(0, 140)}`);
      return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(' ').replace(/\s+/g, ' ').trim();
    }
    return '';
  };
  await Promise.all(Array.from({ length: Math.min(3, windows.length) }, async () => {
    while (next < windows.length) { const i = next++; try { parts[i] = await one(i); } catch (e) { failed++; log(`gemini-asr window ${i + 1}/${windows.length} failed (${String(e.message).slice(0, 120)})`); } }
  }));
  const text = parts.filter(Boolean).join(' ').trim();
  if (!text && failed === windows.length) throw new Error(`Gemini transcription failed for all ${windows.length} window(s)`);
  return { text, windows: windows.length, durationSeconds, failedWindows: failed };
}
export const defaultRunners = {
  v2: (pcm, engine, log) => transcribeChirpPcm(pcm, { model: engine, location: engine === 'chirp_3' ? (process.env.ASR_V3_LOCATION || 'us') : (process.env.ASR_V2_LOCATION || 'us-central1'), log }),
  v1: (pcm, engine, log) => transcribePcm(pcm, { model: 'latest_long', languageCode: process.env.ASR_LANGUAGE || 'en-US', log }),
  gemini: (pcm, engine, log) => geminiRunner(pcm, engine, log),
};
const withTimeout = (p, ms, label) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms); p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });

/**
 * Transcribe 16 kHz mono PCM through the chain.
 * → { text, windows, durationSeconds, failedWindows, engine, fellBack, tried:[{engine, ok, ms, error?, empty?}] }
 * `runners` and `settings` are injectable for tests.
 */
export async function transcribeWithChain(pcm, { log = () => {}, runners = defaultRunners, settings = null, now = Date.now } = {}) {
  const s = settings || await getSettings();
  const order = [s.primary, ...s.fallbacks]; const tried = []; let emptyResult = null; let lastErr = null;
  const usable = order.filter((e) => !breakerOpen(e, now()));
  const attempts = usable.length ? usable : order.slice(0, 1);          // everything tripped: still try the primary rather than fail outright
  if (usable.length < order.length) log(`asr: skipping ${order.filter((e) => !usable.includes(e)).join(', ')} (circuit breaker open)`);
  for (let i = 0; i < attempts.length; i++) {
    const engine = attempts[i]; const t0 = now();
    try {
      const run = runners[ENGINES[engine].kind]; if (!run) throw new Error(`no runner for ${engine}`);
      const r = await withTimeout(Promise.resolve(run(pcm, engine, log)), s.timeoutMs, engine); const ms = now() - t0; const text = String(r.text || '').trim();
      const odd = implausible(text, pcmDurationSeconds(pcm.length)); if (odd) throw new Error(`implausible output (${odd})`);
      if (!text && s.speechCheck && i < attempts.length - 1 && speechLike(pcm)) {   // silent failure: speech in, nothing out
        note(engine, 'empty'); tried.push({ engine, ok: false, empty: true, ms }); emptyResult = { ...r, engine }; log(`asr: ${engine} returned nothing for audio that contains speech — trying ${attempts[i + 1]}`); continue;
      }
      note(engine, 'ok', { ms }); tried.push({ engine, ok: true, ms }); if (i > 0) H(engine).fallbackServed += 1;
      return { ...r, text, engine, fellBack: i > 0 || usable.length < order.length && engine !== s.primary, tried };
    } catch (e) {
      lastErr = e; note(engine, 'fail', { error: e.message, s, now: now() }); tried.push({ engine, ok: false, ms: now() - t0, error: String(e.message).slice(0, 160) });
      log(`asr: ${engine} failed (${String(e.message).slice(0, 140)})${i < attempts.length - 1 ? ` — falling back to ${attempts[i + 1]}` : ''}`);
    }
  }
  if (emptyResult) return { ...emptyResult, text: '', fellBack: false, tried };   // every engine agreed there was nothing to transcribe
  throw lastErr || new Error('no speech engine available');
}
