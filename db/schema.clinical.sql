-- ─────────────────────────────────────────────────────────────────────────────
-- Notera — clinical persistence schema (consults, drafts, finals, feedback,
-- de-id maps, models, audit). Backs the Postgres store (src/db/pgStore.js).
--   run:  node db/migrate_clinical.mjs   (or psql -f db/schema.clinical.sql)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS clinical;
CREATE SCHEMA IF NOT EXISTS phi;
CREATE SCHEMA IF NOT EXISTS ops;

DO $$ BEGIN
  CREATE TYPE clinical.consult_status AS ENUM ('processing','ready','signed','error','empty');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE clinical.note_status AS ENUM ('DRAFT','APPROVED','REJECTED','FLAGGED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A clinician is keyed by the app user id (auth.users.id as text) or any external id.
CREATE TABLE IF NOT EXISTS clinical.clinicians (
  clinician_id  text PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clinical.consults (
  consult_id       text PRIMARY KEY,
  clinician_id     text REFERENCES clinical.clinicians(clinician_id),
  specialty        text,
  note_type        text,
  status           clinical.consult_status NOT NULL DEFAULT 'processing',
  audio_uri        text,                     -- gs://bucket/audio/{user}/{consult}.webm
  pipeline_version text,
  title            text,
  transcript       jsonb,                    -- { text: "..." }
  entities         jsonb,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consults_by_clinician ON clinical.consults (clinician_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical.drafts (
  draft_id      text PRIMARY KEY,
  consult_id    text NOT NULL REFERENCES clinical.consults(consult_id) ON DELETE CASCADE,
  note          jsonb,
  rendered_note text,
  status        clinical.note_status NOT NULL DEFAULT 'DRAFT',
  flags         jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_by  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drafts_by_consult ON clinical.drafts (consult_id, created_at);

CREATE TABLE IF NOT EXISTS clinical.finals (
  final_id     text PRIMARY KEY,
  consult_id   text NOT NULL REFERENCES clinical.consults(consult_id) ON DELETE CASCADE,
  draft_id     text,
  note         jsonb,
  approved_by  text,
  approved_at  timestamptz,
  status       clinical.note_status NOT NULL DEFAULT 'APPROVED',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finals_by_consult ON clinical.finals (consult_id, created_at);

CREATE TABLE IF NOT EXISTS clinical.feedback (
  feedback_id  text PRIMARY KEY,
  consult_id   text NOT NULL REFERENCES clinical.consults(consult_id) ON DELETE CASCADE,
  draft_id     text,
  final_id     text,
  clinician_id text,
  rating       int,
  edits        jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clinical.audit_log (
  id          bigserial PRIMARY KEY,
  consult_id  text,
  actor       text NOT NULL DEFAULT 'system',
  action      text NOT NULL,
  target      text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_by_consult ON clinical.audit_log (consult_id, created_at DESC);

-- Encrypted de-identification map (pgp_sym_encrypt with DEID_ENC_KEY, key never stored).
CREATE TABLE IF NOT EXISTS phi.deid_maps (
  consult_id   text PRIMARY KEY,
  map_enc      bytea NOT NULL,
  fingerprint  text,
  token_count  int,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.models (
  model_version text PRIMARY KEY,
  provider      text,
  name          text,
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
