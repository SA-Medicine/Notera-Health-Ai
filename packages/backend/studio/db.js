// Notera Studio — database (schema "studio", same Postgres as the product; nothing in the clinical/auth schemas is ever written).
'use strict';

import { query, one } from '../src/db/pool.js';

let _ready = null;
export function ensureStudioSchema() {
  if (!_ready) {
    _ready = query(`
      CREATE SCHEMA IF NOT EXISTS studio;
      CREATE TABLE IF NOT EXISTS studio.reviewers (
        user_id TEXT PRIMARY KEY, full_name TEXT, active BOOLEAN NOT NULL DEFAULT true, added_by TEXT, added_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS studio.spec_versions (
        version TEXT PRIMARY KEY, status TEXT NOT NULL, title TEXT, spec JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by TEXT);
      CREATE TABLE IF NOT EXISTS studio.review_items (
        id BIGSERIAL PRIMARY KEY, consult_id TEXT UNIQUE NOT NULL, draft_id TEXT, clinician_id TEXT, assigned_to TEXT,
        source TEXT NOT NULL DEFAULT 'app', title TEXT, transcript TEXT, note JSONB, rendered TEXT,
        status TEXT NOT NULL DEFAULT 'new', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        conformance JSONB, auto_eval JSONB, evidence JSONB, app_edit JSONB, evaluated_at TIMESTAMPTZ);
      CREATE INDEX IF NOT EXISTS review_items_assigned ON studio.review_items (assigned_to, status, queued_at DESC);
      CREATE TABLE IF NOT EXISTS studio.reviews (
        id BIGSERIAL PRIMARY KEY, item_id BIGINT NOT NULL REFERENCES studio.review_items(id) ON DELETE CASCADE, reviewer_id TEXT NOT NULL,
        ratings JSONB, overall INT, would_sign BOOLEAN, errors JSONB, comment TEXT, edited_text TEXT, edit_diff JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (item_id, reviewer_id));
      CREATE TABLE IF NOT EXISTS studio.teach_sessions (
        id BIGSERIAL PRIMARY KEY, item_id BIGINT NOT NULL REFERENCES studio.review_items(id) ON DELETE CASCADE, reviewer_id TEXT NOT NULL,
        questions JSONB, answers JSONB, status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), answered_at TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS studio.proposals (
        id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, item_id BIGINT, reviewer_id TEXT, section TEXT, title TEXT NOT NULL, detail TEXT,
        change JSONB, status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at TIMESTAMPTZ, decision_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS proposals_status ON studio.proposals (status, created_at DESC);
      CREATE TABLE IF NOT EXISTS studio.gate_runs (
        id BIGSERIAL PRIMARY KEY, status TEXT NOT NULL DEFAULT 'running', n INT, done INT NOT NULL DEFAULT 0, started_by TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ, summary JSONB, rows JSONB);
      CREATE TABLE IF NOT EXISTS studio.audit (
        id BIGSERIAL PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, detail JSONB, at TIMESTAMPTZ NOT NULL DEFAULT now());
    `).catch((e) => { _ready = null; throw e; });
  }
  return _ready;
}

export async function audit(userId, action, detail = {}) {
  try { await query(`INSERT INTO studio.audit (user_id, action, detail) VALUES ($1, $2, $3::jsonb)`, [String(userId || ''), action, JSON.stringify(detail)]); } catch { /* auditing must never break a request */ }
}

export { query, one };
