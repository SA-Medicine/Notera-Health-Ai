// ─────────────────────────────────────────────────────────────────────────────
// Versioned, switchable prompts for the v2 pipeline (Postgres: ops.prompt_versions).
//   • The code ships a DEFAULT prompt. A promoted version overrides it at runtime — no redeploy.
//   • Exactly one version per name is active; promoting adds a version, activating an old one is a rollback,
//     "reset" deactivates all so the code default applies again.
//   • Every change is made by an admin through /api/console/prompts/* and audited there.
// The active text is cached for 60 s per process, so a promotion reaches every note within a minute.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { query, one } from '../db/pool.js';
import { assertPromptUnlocked, isLockedPrompt, isSpecLocked } from './specLock.js';

let _ready = null;
export function ensurePromptSchema() {
  if (!_ready) {
    _ready = query(`
      CREATE SCHEMA IF NOT EXISTS ops;
      CREATE TABLE IF NOT EXISTS ops.prompt_versions (
        id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, version INT NOT NULL, text TEXT NOT NULL, note TEXT,
        created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), active BOOLEAN NOT NULL DEFAULT false,
        eval JSONB, UNIQUE (name, version));
      CREATE INDEX IF NOT EXISTS prompt_versions_active_idx ON ops.prompt_versions (name, active);
    `).catch((e) => { _ready = null; throw e; });
  }
  return _ready;
}

const _cache = new Map();   // name -> { at, text, version, id }
const TTL = 60_000;

/** Active override for a prompt name → { text, version, id } or null when the code default applies. Never throws. */
export async function getActivePromptMeta(name) {
  if (isLockedPrompt(name) && (await isSpecLocked())) return null;   // Style Spec v1 lock: the shipped prompt always applies
  const hit = _cache.get(name);
  if (hit && Date.now() - hit.at < TTL) return hit.text ? hit : null;
  let rec = { at: Date.now(), text: null, version: null, id: null };
  try {
    if (process.env.DATABASE_URL) {
      await ensurePromptSchema();
      const row = await one(`SELECT id, version, text FROM ops.prompt_versions WHERE name = $1 AND active ORDER BY id DESC LIMIT 1`, [name]);
      if (row?.text) rec = { at: Date.now(), text: row.text, version: row.version, id: row.id };
    }
  } catch { /* DB unavailable (e.g. local eval) → default prompt */ }
  _cache.set(name, rec);
  return rec.text ? rec : null;
}
/** Active override text for a prompt name, or null when the code default should be used. Never throws. */
export async function getActivePrompt(name) { return (await getActivePromptMeta(name))?.text || null; }
export function clearPromptCache() { _cache.clear(); }

export async function listVersions(name) {
  await ensurePromptSchema();
  return query(`SELECT id, name, version, note, created_by, created_at, active, length(text) AS chars, eval FROM ops.prompt_versions WHERE name = $1 ORDER BY id DESC LIMIT 50`, [name]);
}
export async function getVersion(id) {
  await ensurePromptSchema();
  return one(`SELECT id, name, version, text, note, created_by, created_at, active, eval FROM ops.prompt_versions WHERE id = $1`, [id]);
}

/** Add a version and make it the active one. */
export async function promote(name, text, { note = '', by = '', evalSummary = null } = {}) {
  await assertPromptUnlocked(name);
  await ensurePromptSchema();
  const v = await one(`SELECT coalesce(max(version), 0) + 1 AS v FROM ops.prompt_versions WHERE name = $1`, [name]);
  await query(`UPDATE ops.prompt_versions SET active = false WHERE name = $1`, [name]);
  const row = await one(`INSERT INTO ops.prompt_versions (name, version, text, note, created_by, active, eval) VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id, version`,
    [name, v.v, text, note, by, evalSummary ? JSON.stringify(evalSummary) : null]);
  clearPromptCache();
  return row;
}
export async function activate(id) {
  await ensurePromptSchema();
  const row = await one(`SELECT id, name FROM ops.prompt_versions WHERE id = $1`, [id]);
  if (!row) return null;
  await assertPromptUnlocked(row.name);
  await query(`UPDATE ops.prompt_versions SET active = (id = $1) WHERE name = $2`, [id, row.name]);
  clearPromptCache();
  return row;
}
export async function resetToDefault(name) {
  await assertPromptUnlocked(name);
  await ensurePromptSchema();
  await query(`UPDATE ops.prompt_versions SET active = false WHERE name = $1`, [name]);
  clearPromptCache();
}
