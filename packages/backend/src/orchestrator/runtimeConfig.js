// ─────────────────────────────────────────────────────────────────────────────
// Runtime configuration for the note pipeline, editable from the admin console (Postgres: ops.runtime_config).
//   effective value = admin override (DB)  >  environment variable  >  code default
// Only keys in REGISTRY can be changed, each with a type and a safe range, so a typo in the console can never
// push the pipeline into an invalid state. Every change is recorded (who, when, old → new) in
// ops.runtime_config_history. The override table is cached for 30 s per process, so a change reaches every
// note within about half a minute — no redeploy, no restart.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { query, one } from '../db/pool.js';

const env = (k) => process.env[k];
const num = (k, d) => (env(k) !== undefined && env(k) !== '' && Number.isFinite(Number(env(k))) ? Number(env(k)) : d);
const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];

/** key → { group, label, type, def, min, max, options, help, stage } */
export const REGISTRY = {
  'writer.model':           { group: 'Writer', stage: 'v2-writer', label: 'Writer model', type: 'string', options: MODELS, def: () => env('V2_WRITER_MODEL') || 'gemini-3.7-flash', help: 'The model that drafts the SOAP note. Biggest lever on quality, speed and cost.' },
  'writer.fallbackModel':   { group: 'Writer', stage: 'v2-writer', label: 'Writer fallback model', type: 'string', options: MODELS, def: () => env('V2_WRITER_FALLBACK') || 'gemini-2.5-flash', help: 'Used automatically if the primary model is rate-limited (429) or times out.' },
  'writer.fewShot':         { group: 'Writer', stage: 'v2-writer', label: 'Reference notes shown to the writer', type: 'number', min: 0, max: 3, step: 1, def: () => num('V2_FEWSHOT', 2), help: '2 by default (measured best on 100 notes; 3 was not better). 0 = off. 1–3 = show the writer that many clinician-written notes for the most similar visits (from the curated bank) so it matches the clinic style and level of detail. Adds ~2–5k input tokens per note.' },
  'writer.temperature':     { group: 'Writer', stage: 'v2-writer', label: 'Temperature', type: 'number', min: 0, max: 1, step: 0.05, def: () => num('V2_WRITER_TEMP', 0.3), help: 'Lower = more literal and repeatable; higher = more varied wording. Clinical notes want low.' },
  'writer.topP':            { group: 'Writer', stage: 'v2-writer', label: 'Top-p', type: 'number', min: 0.1, max: 1, step: 0.05, def: () => num('V2_WRITER_TOP_P', 0.9), help: 'Nucleus sampling cut-off.' },
  'writer.thinkingBudget':  { group: 'Writer', stage: 'v2-writer', label: 'Thinking budget (tokens)', type: 'number', min: 0, max: 24576, step: 128, def: () => num('V2_WRITER_THINKING', 0), help: '0 = thinking off (fastest, cheapest). Raise only if evaluations show a quality gain.' },
  'writer.maxOutputTokens': { group: 'Writer', stage: 'v2-writer', label: 'Max output tokens', type: 'number', min: 1000, max: 16000, step: 500, def: () => num('V2_WRITER_MAX_TOKENS', 6000), help: 'Hard cap on the note length the writer may produce.' },
  'writer.timeoutMs':       { group: 'Writer', stage: 'v2-writer', label: 'Timeout (ms)', type: 'number', min: 10000, max: 120000, step: 1000, def: () => num('V2_WRITER_TIMEOUT_MS', 50000), help: 'Per-attempt time limit before the call is abandoned.' },
  'writer.hedgeMs':         { group: 'Writer', stage: 'v2-writer', label: 'Hedge after (ms)', type: 'number', min: 5000, max: 60000, step: 1000, def: () => num('V2_WRITER_HEDGE_MS', 25000), help: 'If no answer by then, a second identical request is raced against the first (cuts slow tails).' },
  'aux.model':              { group: 'Checklist & verifier', stage: 'v2-checklist', label: 'Helper model', type: 'string', options: MODELS, def: () => env('GEMINI_MODEL') || 'gemini-3.5-flash-lite', help: 'Model for the fact checklist and the verifier — short, cheap calls.' },
  'editor.enabled':         { group: 'Editor pass', stage: 'v2-editor', label: 'Editor pass enabled', type: 'boolean', def: () => env('V2_EDITOR') === '1', help: 'A reviewer call after the writer that fixes section placement, plan attribution, contradictions with the transcript and padding. Adds a few seconds per note. Turn on only after the Lab shows it helps.' },
  'editor.model':           { group: 'Editor pass', stage: 'v2-editor', label: 'Editor model', type: 'string', options: MODELS, def: () => env('V2_EDITOR_MODEL') || 'gemini-2.5-flash', help: 'Model for the editor pass.' },
  'editor.timeoutMs':       { group: 'Editor pass', stage: 'v2-editor', label: 'Editor timeout (ms)', type: 'number', min: 5000, max: 90000, step: 1000, def: () => num('V2_EDITOR_TIMEOUT_MS', 30000), help: 'If the editor is slower than this it is skipped and the writer draft is used.' },
  'drugs.guardEnabled':     { group: 'Safety guards', stage: 'v2-writer', label: 'Drug-name guard', type: 'boolean', def: () => env('V2_DRUG_GUARD') !== '0', help: 'A medication name that the transcript does not actually say is replaced by the word as spoken (closest transcript word) and flagged for review, instead of being silently "corrected" into a different drug.' },
  'recall.extended':        { group: 'Checklist & verifier', stage: 'v2-checklist', label: 'Extended recall', type: 'boolean', def: () => env('V2_RECALL') === '1', help: 'The helper also lists history, exam findings, symptoms and specific details; anything the writer left out that the transcript says is added by code. Raises completeness.' },
  'guards.template':        { group: 'Safety guards', stage: 'v2-writer', label: 'Template guard', type: 'boolean', def: () => env('V2_GUARD_TEMPLATE') === '1', help: 'The clinic template has no "Current medications" list and no separate "Follow-up" problem. This removes such a list line and folds a Follow-up problem into the last real problem\'s treatment plan.' },
  'guards.placement':       { group: 'Safety guards', stage: 'v2-writer', label: 'Placement guard', type: 'boolean', def: () => env('V2_GUARD_PLACEMENT') === '1', help: 'Patient-reported statements ("reports…", "denies…", "complains of…") found under Objective are moved to Subjective. Exam findings and vitals never move.' },
  'guards.drugPlausibility':{ group: 'Safety guards', stage: 'v2-writer', label: 'Drug plausibility flag', type: 'boolean', def: () => env('V2_GUARD_PLAUSIBLE') !== '0', help: 'Flags (never edits) a common drug planned in the note when nothing in the transcript hints what it is for.' },
  'guards.inputCheck':      { group: 'Safety guards', stage: 'v2-writer', label: 'Input check', type: 'string', options: ['off', 'flag', 'reject'], def: () => env('V2_INPUT_CHECK') || 'flag', help: 'Detects text that is not a consultation (a schedule, a list, a few words). flag = generate and warn, reject = refuse with an error, off = no check.' },
  'story.enabled':          { group: 'Story agent', stage: 'v2-story', label: 'Story agent enabled', type: 'boolean', def: () => env('V2_STORY') === '1', help: 'An independent last step that rewrites the Subjective as a flowing clinical story in grammatical sentences (why the patient came, how it began and progressed, what helps, what was tried, the impact) and tidies the Past Medical History wording. A code check rejects any rewrite that loses or invents a fact. Adds a few seconds per note.' },
  'story.model':            { group: 'Story agent', stage: 'v2-story', label: 'Story model', type: 'string', options: MODELS, def: () => env('V2_STORY_MODEL') || 'gemini-2.5-flash', help: 'Model for the story agent.' },
  'story.timeoutMs':        { group: 'Story agent', stage: 'v2-story', label: 'Story timeout (ms)', type: 'number', min: 5000, max: 90000, step: 1000, def: () => num('V2_STORY_TIMEOUT_MS', 30000), help: 'If the story agent is slower than this it is skipped and the writer\'s wording is kept.' },
  'verifier.enabled':       { group: 'Checklist & verifier', stage: 'v2-verifier', label: 'Verifier enabled', type: 'boolean', def: () => env('V2_VERIFIER') !== '0', help: 'Fact-checks every line of the note against the transcript and removes unsupported lines.' },
  'verifier.timeoutMs':     { group: 'Checklist & verifier', stage: 'v2-verifier', label: 'Verifier timeout (ms)', type: 'number', min: 5000, max: 60000, step: 1000, def: () => num('V2_VERIFY_TIMEOUT_MS', 15000), help: 'If the verifier is slower than this it is skipped and the note is returned as drafted.' },
};

let _ready = null;
export function ensureConfigSchema() {
  if (!_ready) {
    _ready = query(`
      CREATE SCHEMA IF NOT EXISTS ops;
      CREATE TABLE IF NOT EXISTS ops.runtime_config (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS ops.runtime_config_history (id BIGSERIAL PRIMARY KEY, key TEXT NOT NULL, old_value JSONB, new_value JSONB, changed_by TEXT, changed_at TIMESTAMPTZ NOT NULL DEFAULT now(), reason TEXT);
    `).catch((e) => { _ready = null; throw e; });
  }
  return _ready;
}

let _cache = { at: 0, map: {} };
const TTL = 30_000;
export function clearConfigCache() { _cache = { at: 0, map: {} }; }

async function overrides() {
  if (Date.now() - _cache.at < TTL) return _cache.map;
  let map = {};
  try {
    if (process.env.DATABASE_URL) {
      await ensureConfigSchema();
      for (const r of await query(`SELECT key, value, updated_by, updated_at FROM ops.runtime_config`)) map[r.key] = { value: r.value, by: r.updated_by, at: r.updated_at };
    }
  } catch { map = _cache.map; /* keep last good values if the DB blips */ }
  _cache = { at: Date.now(), map };
  return map;
}

export function validate(key, raw) {
  const m = REGISTRY[key]; if (!m) throw new Error(`unknown setting "${key}"`);
  if (m.type === 'boolean') { if (typeof raw !== 'boolean') throw new Error(`${key} must be true or false`); return raw; }
  if (m.type === 'number') {
    const v = Number(raw); if (raw === '' || raw === null || !Number.isFinite(v)) throw new Error(`${key} must be a number`);
    if (v < m.min || v > m.max) throw new Error(`${key} must be between ${m.min} and ${m.max}`); return v;
  }
  const v = String(raw || '').trim();
  if (!/^[A-Za-z0-9._\-/]{3,80}$/.test(v)) throw new Error(`${key} must be a model id such as gemini-2.5-flash`);
  return v;
}

/** Everything the pipeline needs, resolved: { 'writer.model': 'gemini-2.5-flash', … }. Never throws. */
export async function effectiveConfig() {
  const ov = await overrides(); const out = {};
  for (const [k, m] of Object.entries(REGISTRY)) out[k] = ov[k] ? ov[k].value : m.def();
  return out;
}

/** Same plus provenance, for the admin console. */
export async function describeConfig() {
  const ov = await overrides();
  return Object.entries(REGISTRY).map(([key, m]) => {
    const d = m.def();
    return { key, group: m.group, stage: m.stage, label: m.label, type: m.type, min: m.min, max: m.max, step: m.step, options: m.options, help: m.help,
      default: d, value: ov[key] ? ov[key].value : d, source: ov[key] ? 'override' : 'default', updated_by: ov[key]?.by || null, updated_at: ov[key]?.at || null };
  });
}

export async function setConfig(key, raw, { by = '', reason = '' } = {}) {
  const value = validate(key, raw);
  await ensureConfigSchema();
  const old = await one(`SELECT value FROM ops.runtime_config WHERE key = $1`, [key]);
  await query(`INSERT INTO ops.runtime_config (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, JSON.stringify(value), by]);
  await query(`INSERT INTO ops.runtime_config_history (key, old_value, new_value, changed_by, reason) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5)`, [key, old ? JSON.stringify(old.value) : null, JSON.stringify(value), by, String(reason).slice(0, 300)]);
  clearConfigCache();
  return value;
}
export async function resetConfig(key, { by = '' } = {}) {
  if (!REGISTRY[key]) throw new Error(`unknown setting "${key}"`);
  await ensureConfigSchema();
  const old = await one(`SELECT value FROM ops.runtime_config WHERE key = $1`, [key]);
  if (!old) return false;
  await query(`DELETE FROM ops.runtime_config WHERE key = $1`, [key]);
  await query(`INSERT INTO ops.runtime_config_history (key, old_value, new_value, changed_by, reason) VALUES ($1, $2::jsonb, NULL, $3, 'reset to default')`, [key, JSON.stringify(old.value), by]);
  clearConfigCache();
  return true;
}
export async function configHistory(limit = 60) {
  await ensureConfigSchema();
  return query(`SELECT id, key, old_value, new_value, changed_by, changed_at, reason FROM ops.runtime_config_history ORDER BY id DESC LIMIT $1`, [limit]);
}
