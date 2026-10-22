// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// STYLE SPEC v2 — HARD LOCK (v2 approved by the owner on 2026-10-22; v1 was approved 2026-10-20). The unlock phrase stays "UNLOCK STYLE SPEC v1".
// The note format that the owner built together with the training doctor (topic-headed Subjective, compact PMH with a
// Medications line, one problem per issue, plain titles, assessment only as the clinician's conclusion, refills under the
// condition, grouped Objective, reference names, reviewer + story stages) is APPROVED and FROZEN.
//
// While locked, NOTHING may change it: no prompt promote / activate / reset, no change of a spec-shaping setting, and database
// overrides of those settings are ignored (the shipped defaults apply). The lock lives in the database (ops.spec_lock) so that
// every process sees it, and it fails CLOSED: if the lock state cannot be read, the spec is treated as locked.
// Only the owner can lift it, with the exact confirmation phrase, and every change is audited.
// Code drift is caught separately by spec/LOCK.json + test/specLock.test.mjs (hashes of the prompts, guards and render code).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
'use strict';

import { query, one } from '../db/pool.js';

export const SPEC_VERSION = '2.1.0';
export const UNLOCK_PHRASE = 'UNLOCK STYLE SPEC v1';

let _ready = null;
export function ensureSpecLock() {
  if (!_ready) {
    _ready = query(`
      CREATE SCHEMA IF NOT EXISTS ops;
      CREATE TABLE IF NOT EXISTS ops.spec_lock (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), locked BOOLEAN NOT NULL DEFAULT true, spec_version TEXT NOT NULL,
        changed_by TEXT, changed_at TIMESTAMPTZ NOT NULL DEFAULT now(), note TEXT);
      CREATE TABLE IF NOT EXISTS ops.spec_lock_history (
        id BIGSERIAL PRIMARY KEY, locked BOOLEAN NOT NULL, spec_version TEXT, changed_by TEXT, note TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now());
      INSERT INTO ops.spec_lock (id, locked, spec_version, changed_by, note) VALUES (1, true, '${SPEC_VERSION}', 'owner', 'Style Spec v1 approved by the owner and the training doctor') ON CONFLICT (id) DO NOTHING;
    `).catch((e) => { _ready = null; throw e; });
  }
  return _ready;
}

let _cache = { at: 0, state: { locked: true, spec_version: SPEC_VERSION, changed_by: null, changed_at: null, note: null, readable: false } };
const TTL = 5_000;
export function clearSpecLockCache() { _cache.at = 0; }

/** Current lock state. Fails closed (locked) when the database cannot be read. */
export async function specLockState() {
  if (Date.now() - _cache.at < TTL) return _cache.state;
  try {
    await ensureSpecLock();
    const row = await one(`SELECT locked, spec_version, changed_by, changed_at, note FROM ops.spec_lock WHERE id = 1`);
    _cache = { at: Date.now(), state: { locked: row ? !!row.locked : true, spec_version: row?.spec_version || SPEC_VERSION, changed_by: row?.changed_by || null, changed_at: row?.changed_at || null, note: row?.note || null, readable: true } };
  } catch {
    _cache = { at: Date.now() - TTL + 1000, state: { ..._cache.state, locked: true, readable: false } };   // retry in 1 s, meanwhile closed
  }
  return _cache.state;
}
export async function isSpecLocked() { return (await specLockState()).locked; }

/** Every prompt of the v2 pipeline is part of the approved spec. */
export const isLockedPrompt = (name) => /^v2-/.test(String(name || ''));
/** Operational limits (timeouts, hedging, output caps) may be tuned; everything that shapes a note is locked. */
export const isLockedKey = (key) => !/(timeoutMs|hedgeMs|maxOutputTokens)$/i.test(String(key || '')) && !/^stage\./.test(String(key || ''));   // stage.* = emergency switches for the v2 stages: allowed while locked, audited

export class SpecLockedError extends Error {
  constructor(what) { super(`Style Spec v${SPEC_VERSION} is LOCKED (doctor-approved): ${what} cannot be changed until the owner unlocks it.`); this.status = 423; this.code = 'SPEC_LOCKED'; }
}
export async function assertPromptUnlocked(name) { if (isLockedPrompt(name) && (await isSpecLocked())) throw new SpecLockedError(`prompt "${name}"`); }
export async function assertKeyUnlocked(key) { if (isLockedKey(key) && (await isSpecLocked())) throw new SpecLockedError(`setting "${key}"`); }

async function setLock(locked, by, note) {
  await ensureSpecLock();
  await query(`UPDATE ops.spec_lock SET locked = $1, changed_by = $2, changed_at = now(), note = $3 WHERE id = 1`, [locked, by || '', note || '']);
  await query(`INSERT INTO ops.spec_lock_history (locked, spec_version, changed_by, note) VALUES ($1, $2, $3, $4)`, [locked, SPEC_VERSION, by || '', note || '']);
  clearSpecLockCache();
  return specLockState();
}
export async function unlockSpec(by, confirm, note = '') {
  if (String(confirm || '').trim() !== UNLOCK_PHRASE) { const e = new Error(`type the exact phrase "${UNLOCK_PHRASE}" to unlock`); e.status = 400; throw e; }
  return setLock(false, by, note || 'unlocked by the owner');
}
export async function relockSpec(by, note = '') { return setLock(true, by, note || 'locked again'); }
export async function specLockHistory(limit = 30) { await ensureSpecLock(); return query(`SELECT locked, spec_version, changed_by, note, at FROM ops.spec_lock_history ORDER BY id DESC LIMIT $1`, [limit]); }
