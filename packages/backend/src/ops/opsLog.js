// ─────────────────────────────────────────────────────────────────────────────
// Notera — operational logging & alerting (ops.*).
//
// Built from scratch for Notera (no third-party tools). Fire-and-forget writes of:
//   • pipeline runs  (per note generation: tokens, cost, timings, status)
//   • errors         (a SEPARATE error log — pipeline/asr/api/frontend)
//   • audio events   (the silence / empty-transcript safety rule)
// Plus checkAlerts(), which emails support when thresholds are breached.
//
// PHI-safe: stores ids, counts, codes, timings — never transcript/note text.
// Every function is try/catch-wrapped and a no-op when OPS_LOGGING=0, so monitoring
// can NEVER break note generation.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { query, one } from '../db/pool.js';
import { sendMail } from '../auth/mailer.js';

const ENABLED = () => process.env.OPS_LOGGING !== '0';

// ── model prices ($ per 1M tokens). DB table ops.model_prices overrides these. ──
const DEFAULT_PRICES = {
  'gemini-3.7-flash':      { input: 0.75, output: 3.75 },
  'gemini-3.8-flash':      { input: 0.75, output: 3.75 },
  'gemini-3.5-flash':      { input: 0.30, output: 2.50 },
  'gemini-3.5-flash-lite': { input: 0.30, output: 2.50 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.50 },
};
let _priceCache = null, _priceCacheAt = 0;
async function prices() {
  if (_priceCache && Date.now() - _priceCacheAt < 300_000) return _priceCache;
  const map = { ...DEFAULT_PRICES };
  try {
    for (const r of await query('SELECT model, input_per_m, output_per_m FROM ops.model_prices')) {
      map[r.model] = { input: Number(r.input_per_m), output: Number(r.output_per_m) };
    }
  } catch { /* table may not exist yet */ }
  _priceCache = map; _priceCacheAt = Date.now();
  return map;
}
export async function costFor(model, promptTokens = 0, outputTokens = 0) {
  const p = (await prices())[model] || DEFAULT_PRICES['gemini-3.7-flash'];
  return +(((promptTokens / 1e6) * p.input) + ((outputTokens / 1e6) * p.output)).toFixed(5);
}

// ── schema bootstrap (idempotent; safe on a running DB) ──────────────────────
let _schemaReady = false;
let _schemaPromise = null;   // serialize concurrent callers (startup + route mount race)
export async function ensureOpsSchema() {
  if (_schemaReady || !ENABLED()) return;
  if (_schemaPromise) return _schemaPromise;   // in-flight → await the same one
  _schemaPromise = _doEnsureOpsSchema().finally(() => { _schemaPromise = null; });
  return _schemaPromise;
}
async function _doEnsureOpsSchema() {
  const ddl = `
    CREATE SCHEMA IF NOT EXISTS ops;
    CREATE TABLE IF NOT EXISTS ops.pipeline_runs (
      run_id BIGSERIAL PRIMARY KEY, consult_id TEXT, clinician_id TEXT, model TEXT, status TEXT,
      duration_ms INTEGER, transcript_chars INTEGER, note_chars INTEGER,
      prompt_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0,
      est_cost_usd NUMERIC(10,5) DEFAULT 0, per_agent JSONB, timings JSONB, error_id BIGINT,
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE INDEX IF NOT EXISTS pipeline_runs_clinician_idx ON ops.pipeline_runs (clinician_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS pipeline_runs_status_idx ON ops.pipeline_runs (status, created_at DESC);
    CREATE TABLE IF NOT EXISTS ops.errors (
      error_id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), source TEXT, agent TEXT, level TEXT,
      code TEXT, message TEXT, stack TEXT, consult_id TEXT, clinician_id TEXT, context JSONB);
    CREATE INDEX IF NOT EXISTS errors_ts_idx ON ops.errors (ts DESC);
    CREATE INDEX IF NOT EXISTS errors_source_idx ON ops.errors (source, code, ts DESC);
    CREATE INDEX IF NOT EXISTS errors_clinician_idx ON ops.errors (clinician_id, ts DESC);
    CREATE TABLE IF NOT EXISTS ops.audio_events (
      id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), consult_id TEXT, clinician_id TEXT,
      reason TEXT, duration_ms INTEGER, meta JSONB);
    CREATE INDEX IF NOT EXISTS audio_events_ts_idx ON ops.audio_events (ts DESC);
    CREATE TABLE IF NOT EXISTS ops.model_prices (
      model TEXT PRIMARY KEY, input_per_m NUMERIC(10,4) NOT NULL, output_per_m NUMERIC(10,4) NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now());
  `;
  try {
    await query(ddl);
    _schemaReady = true;
    console.log('[ops] schema ready');
  } catch (e) {
    console.warn('[ops] schema init skipped:', e.message);
  }
}

// ── redaction: strip anything that could be PHI from free text before storing ──
function redact(s, max = 4000) {
  if (!s) return null;
  let t = String(s);
  // drop quoted spans (likely transcript quotes) and long digit runs
  t = t.replace(/"[^"]{0,400}"/g, '"…"').replace(/\b\d[\d\s\-/]{5,}\b/g, '###');
  return t.slice(0, max);
}

// ── writers (all fire-and-forget) ───────────────────────────────────────────
/** One row per note generation. `tokenUsage` = LLMService.getTokenUsage(). */
export async function recordRun(r = {}) {
  if (!ENABLED()) return;
  try {
    await ensureOpsSchema();
    const tu = r.tokenUsage || {};
    const tot = tu.totals || {};
    const prompt = tot.prompt || 0, output = tot.output || 0, total = tot.total || (prompt + output);
    const cost = await costFor(r.model, prompt, output);
    await query(
      `INSERT INTO ops.pipeline_runs
        (consult_id, clinician_id, model, status, duration_ms, transcript_chars, note_chars,
         prompt_tokens, output_tokens, total_tokens, est_cost_usd, per_agent, timings, error_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [r.consultId || null, r.clinicianId || null, r.model || null, r.status || 'ok',
       r.durationMs || null, r.transcriptChars || null, r.noteChars || null,
       prompt, output, total, cost,
       tu.perAgent ? JSON.stringify(tu.perAgent) : null,
       r.timings ? JSON.stringify(r.timings) : null, r.errorId || null]
    );
  } catch (e) { console.warn('[ops] recordRun skipped:', e.message); }
}

/** Separate error log. Returns the new error_id (or null). */
export async function recordError(e = {}) {
  if (!ENABLED()) return null;
  try {
    await ensureOpsSchema();
    const row = await one(
      `INSERT INTO ops.errors (source, agent, level, code, message, stack, consult_id, clinician_id, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING error_id`,
      [e.source || 'api', e.agent || null, e.level || 'error', e.code || null,
       redact(e.message, 1000), redact(e.stack, 6000), e.consultId || null, e.clinicianId || null,
       e.context ? JSON.stringify(e.context) : null]
    );
    return row?.error_id || null;
  } catch (err) { console.warn('[ops] recordError skipped:', err.message); return null; }
}

/** Audio safety event (silence / empty). */
export async function recordAudioEvent(a = {}) {
  if (!ENABLED()) return;
  try {
    await ensureOpsSchema();
    await query(
      `INSERT INTO ops.audio_events (consult_id, clinician_id, reason, duration_ms, meta)
       VALUES ($1,$2,$3,$4,$5)`,
      [a.consultId || null, a.clinicianId || null, a.reason || 'unknown', a.durationMs || null,
       a.meta ? JSON.stringify(a.meta) : null]
    );
  } catch (e) { console.warn('[ops] recordAudioEvent skipped:', e.message); }
}

// ── alerting (email to support; cooldown so we never spam) ───────────────────
const _lastAlert = {};   // type -> ts
function cooled(type, ms) {
  const now = Date.now();
  if (_lastAlert[type] && now - _lastAlert[type] < ms) return false;
  _lastAlert[type] = now; return true;
}
async function fire(type, subject, body) {
  const to = process.env.OPS_ALERT_EMAIL || process.env.SUPPORT_EMAIL || process.env.SMTP_USER;
  if (!to) { console.warn('[ops:alert]', subject); return; }
  const cooldown = Number(process.env.OPS_ALERT_COOLDOWN_MS) || 30 * 60_000;
  if (!cooled(type, cooldown)) return;
  console.warn(`[ops:alert] ${subject}`);
  try { await sendMail(to, `[Notera monitor] ${subject}`, body); } catch (e) { console.warn('[ops:alert] mail failed:', e.message); }
}

/** Runs every OPS_ALERT_INTERVAL_MS (cron in server.js). Checks thresholds, emails support. */
export async function checkAlerts() {
  if (!ENABLED() || process.env.OPS_ALERTS !== '1') return;
  try {
    await ensureOpsSchema();
    // 1) error rate over last 15 min
    const runs15 = await one(`SELECT count(*) n, count(*) FILTER (WHERE status='error') e
                              FROM ops.pipeline_runs WHERE created_at > now() - interval '15 minutes'`);
    if (runs15 && Number(runs15.n) >= 5) {
      const rate = Number(runs15.e) / Number(runs15.n);
      if (rate > 0.2) await fire('error_rate',
        `High error rate: ${(rate * 100).toFixed(0)}% of ${runs15.n} runs failing (15m)`,
        `${runs15.e}/${runs15.n} note generations failed in the last 15 minutes.\nCheck monitor → Errors.`);
    }
    // 2) P95-ish latency (max) over last 15 min
    const slow = await one(`SELECT max(duration_ms) m FROM ops.pipeline_runs
                            WHERE created_at > now() - interval '15 minutes'`);
    const slowMs = Number(process.env.OPS_ALERT_SLOW_MS) || 150000;
    if (slow && Number(slow.m) > slowMs) await fire('latency',
      `Slow note generation: ${Math.round(Number(slow.m) / 1000)}s max (15m)`,
      `A note took ${Math.round(Number(slow.m) / 1000)}s — likely Vertex throttling. Check monitor → Runs.`);
    // 3) 429 storm
    const q429 = await one(`SELECT count(*) n FROM ops.errors
                            WHERE code='GEMINI_429' AND ts > now() - interval '15 minutes'`);
    if (q429 && Number(q429.n) >= 5) await fire('quota',
      `Vertex quota errors: ${q429.n} × 429 (15m)`,
      `${q429.n} RESOURCE_EXHAUSTED (429) errors in 15 minutes — quota pressure. Consider raising Vertex quota.`);
    // 4) cost spike vs trailing 7d daily avg
    const today = await one(`SELECT coalesce(sum(est_cost_usd),0) c FROM ops.pipeline_runs WHERE created_at > now() - interval '24 hours'`);
    const base = await one(`SELECT coalesce(sum(est_cost_usd),0)/7 c FROM ops.pipeline_runs WHERE created_at BETWEEN now() - interval '8 days' AND now() - interval '1 day'`);
    if (base && Number(base.c) > 0.5 && Number(today.c) > 2 * Number(base.c)) await fire('cost',
      `Cost spike: $${Number(today.c).toFixed(2)} today vs ~$${Number(base.c).toFixed(2)}/day baseline`,
      `LLM spend in the last 24h is more than 2× the 7-day baseline. Check monitor → Accounts for a runaway user.`);
    // 5) audio empty rate
    const empt = await one(`SELECT count(*) n FROM ops.audio_events
                            WHERE reason IN ('silence_timeout','empty_transcript') AND ts > now() - interval '60 minutes'`);
    if (empt && Number(empt.n) >= 10) await fire('audio',
      `Audio issues: ${empt.n} empty/silent recordings (1h)`,
      `${empt.n} recordings produced no speech in the last hour — possible mic/UX problem.`);
  } catch (e) { console.warn('[ops] checkAlerts skipped:', e.message); }
}
