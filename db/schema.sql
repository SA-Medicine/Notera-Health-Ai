-- ═══════════════════════════════════════════════════════════════════════════
-- Notera-Health-Ai — PostgreSQL schema (target: PostgreSQL 18)
-- Hybrid design: relational columns for fixed / frequently-queried attributes,
-- JSONB for variable clinical payloads (notes, entities, FHIR, artifacts).
-- Apply with:  node db/migrate.mjs   (or psql -f db/schema.sql)
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS clinical;
CREATE SCHEMA IF NOT EXISTS phi;
CREATE SCHEMA IF NOT EXISTS ops;

DO $$ BEGIN
  CREATE TYPE clinical.consult_status AS ENUM ('processing','ready','signed','error','archived');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE clinical.note_status AS ENUM ('OK','FLAGGED','INVALID','DRAFT','APPROVED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE OR REPLACE FUNCTION ops.set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- 1. clinicians
CREATE TABLE IF NOT EXISTS clinical.clinicians (
  clinician_id TEXT PRIMARY KEY,
  display_name TEXT,
  email        CITEXT UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. consults
CREATE TABLE IF NOT EXISTS clinical.consults (
  consult_id       TEXT PRIMARY KEY,
  clinician_id     TEXT REFERENCES clinical.clinicians(clinician_id) ON DELETE SET NULL,
  specialty        TEXT,
  note_type        TEXT,
  status           clinical.consult_status NOT NULL DEFAULT 'processing',
  audio_uri        TEXT,
  pipeline_version TEXT,
  transcript       JSONB,
  entities         JSONB,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consults_clinician    ON clinical.consults(clinician_id);
CREATE INDEX IF NOT EXISTS idx_consults_status       ON clinical.consults(status);
CREATE INDEX IF NOT EXISTS idx_consults_created      ON clinical.consults(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consults_specialty    ON clinical.consults(specialty);
CREATE INDEX IF NOT EXISTS idx_consults_entities_gin ON clinical.consults USING gin (entities jsonb_path_ops);
CREATE OR REPLACE TRIGGER trg_consults_updated BEFORE UPDATE ON clinical.consults
  FOR EACH ROW EXECUTE FUNCTION ops.set_updated_at();

-- 3. drafts
CREATE TABLE IF NOT EXISTS clinical.drafts (
  draft_id      TEXT PRIMARY KEY,
  consult_id    TEXT NOT NULL REFERENCES clinical.consults(consult_id) ON DELETE CASCADE,
  note          JSONB NOT NULL,
  rendered_note TEXT,
  status        clinical.note_status NOT NULL DEFAULT 'DRAFT',
  flags         JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_by  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drafts_consult  ON clinical.drafts(consult_id);
CREATE INDEX IF NOT EXISTS idx_drafts_created  ON clinical.drafts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_note_gin ON clinical.drafts USING gin (note jsonb_path_ops);

-- 4. finals
CREATE TABLE IF NOT EXISTS clinical.finals (
  final_id    TEXT PRIMARY KEY,
  consult_id  TEXT NOT NULL REFERENCES clinical.consults(consult_id) ON DELETE CASCADE,
  draft_id    TEXT REFERENCES clinical.drafts(draft_id) ON DELETE SET NULL,
  note        JSONB NOT NULL,
  approved_by TEXT REFERENCES clinical.clinicians(clinician_id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  status      clinical.note_status NOT NULL DEFAULT 'APPROVED',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finals_consult ON clinical.finals(consult_id);

-- 5. feedback
CREATE TABLE IF NOT EXISTS clinical.feedback (
  feedback_id  TEXT PRIMARY KEY,
  consult_id   TEXT NOT NULL REFERENCES clinical.consults(consult_id) ON DELETE CASCADE,
  draft_id     TEXT REFERENCES clinical.drafts(draft_id) ON DELETE SET NULL,
  final_id     TEXT REFERENCES clinical.finals(final_id) ON DELETE SET NULL,
  clinician_id TEXT REFERENCES clinical.clinicians(clinician_id) ON DELETE SET NULL,
  rating       SMALLINT CHECK (rating BETWEEN 1 AND 5),
  edits        JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_consult ON clinical.feedback(consult_id);

-- 6. de-id maps (PHI, encrypted)
CREATE TABLE IF NOT EXISTS phi.deid_maps (
  consult_id  TEXT PRIMARY KEY REFERENCES clinical.consults(consult_id) ON DELETE CASCADE,
  map_enc     BYTEA NOT NULL,
  fingerprint TEXT NOT NULL,
  token_count INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER trg_deid_updated BEFORE UPDATE ON phi.deid_maps
  FOR EACH ROW EXECUTE FUNCTION ops.set_updated_at();

-- 7. audit log (append-only)
CREATE TABLE IF NOT EXISTS clinical.audit_log (
  event_id   BIGSERIAL PRIMARY KEY,
  consult_id TEXT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_consult ON clinical.audit_log(consult_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON clinical.audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON clinical.audit_log(action);

CREATE OR REPLACE FUNCTION clinical.block_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'append-only / immutable table'; END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON clinical.audit_log
  FOR EACH ROW EXECUTE FUNCTION clinical.block_mutation();

-- 8. models
CREATE TABLE IF NOT EXISTS ops.models (
  model_version TEXT PRIMARY KEY,
  provider      TEXT,
  name          TEXT,
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. prompt registry
CREATE TABLE IF NOT EXISTS ops.prompts (
  id                TEXT PRIMARY KEY,
  agent             TEXT,
  file              TEXT,
  label             TEXT,
  stage             TEXT,
  description       TEXT,
  kind              TEXT NOT NULL DEFAULT 'agent',
  vars              JSONB NOT NULL DEFAULT '[]'::jsonb,
  active            BOOLEAN NOT NULL DEFAULT false,
  sort_order        INT,
  freeform          BOOLEAN NOT NULL DEFAULT false,
  max_output_tokens INT,
  schema            TEXT,
  published_version INT,
  draft             JSONB,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER trg_prompts_updated BEFORE UPDATE ON ops.prompts
  FOR EACH ROW EXECUTE FUNCTION ops.set_updated_at();

CREATE TABLE IF NOT EXISTS ops.prompt_versions (
  id                 BIGSERIAL PRIMARY KEY,
  prompt_id          TEXT NOT NULL REFERENCES ops.prompts(id) ON DELETE CASCADE,
  version            INT NOT NULL,
  system_instruction TEXT NOT NULL,
  note               TEXT,
  author             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, version)
);
CREATE OR REPLACE TRIGGER trg_prompt_versions_immutable BEFORE UPDATE OR DELETE ON ops.prompt_versions
  FOR EACH ROW EXECUTE FUNCTION clinical.block_mutation();

-- 10. eval / testing
CREATE TABLE IF NOT EXISTS ops.eval_runs (
  run_id      TEXT PRIMARY KEY,
  command     TEXT,
  status      TEXT,
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  summary     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_started ON ops.eval_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS ops.eval_fixture_results (
  id            BIGSERIAL PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES ops.eval_runs(run_id) ON DELETE CASCADE,
  fixture_id    TEXT NOT NULL,
  score         JSONB NOT NULL DEFAULT '{}'::jsonb,
  note          JSONB,
  rendered_note TEXT,
  flags         JSONB NOT NULL DEFAULT '[]'::jsonb,
  qa_metrics    JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (run_id, fixture_id)
);
CREATE INDEX IF NOT EXISTS idx_eval_fixtures_run ON ops.eval_fixture_results(run_id);

CREATE TABLE IF NOT EXISTS ops.eval_metric_points (
  id         BIGSERIAL PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES ops.eval_runs(run_id) ON DELETE CASCADE,
  fixture_id TEXT,
  metric_key TEXT NOT NULL,
  value      DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metric_points_run ON ops.eval_metric_points(run_id);
CREATE INDEX IF NOT EXISTS idx_metric_points_key ON ops.eval_metric_points(metric_key);

-- 11. sessions (Heidi exports)
CREATE TABLE IF NOT EXISTS ops.sessions (
  id               TEXT PRIMARY KEY,
  heidi_session_id TEXT,
  session_title    TEXT,
  subtitle         TEXT,
  session_date     DATE,
  session_time     TEXT,
  language         TEXT,
  duration         TEXT,
  tags             JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_url       TEXT,
  transcript       JSONB,
  soap_note        JSONB,
  artifacts        JSONB NOT NULL DEFAULT '[]'::jsonb,
  audits           JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ,
  imported_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_heidi ON ops.sessions(heidi_session_id);

-- 11b. run logs (all pipeline/eval/admin stdout in the DB)
CREATE TABLE IF NOT EXISTS ops.run_logs (
  id         BIGSERIAL PRIMARY KEY,
  run_id     TEXT,
  source     TEXT NOT NULL DEFAULT 'pipeline',
  consult_id TEXT,
  log        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_run_logs_run     ON ops.run_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_run_logs_consult ON ops.run_logs(consult_id);
CREATE INDEX IF NOT EXISTS idx_run_logs_created ON ops.run_logs(created_at DESC);

-- 12. row-level security
ALTER TABLE clinical.consults ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.drafts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.finals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE phi.deid_maps     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS consults_owner ON clinical.consults;
CREATE POLICY consults_owner ON clinical.consults
  USING (
    current_setting('app.role', true) IN ('service','admin')
    OR clinician_id = current_setting('app.clinician_id', true)
  );

DROP POLICY IF EXISTS deid_service_only ON phi.deid_maps;
CREATE POLICY deid_service_only ON phi.deid_maps
  USING (current_setting('app.role', true) = 'service')
  WITH CHECK (current_setting('app.role', true) = 'service');

COMMIT;
