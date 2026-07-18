-- ═══════════════════════════════════════════════════════════════════════════
-- Notera Testing Lab — humanized schema (full replacement of clinical/phi/ops)
--
-- One schema, six plain tables. Everything traces back to a patient (a reference
-- case) and a run (one pipeline execution). Designed to be read and maintained by
-- a human at a glance.
--
--   patients      one reference case: Heidi transcript + gold SOAP note (never change)
--   runs          one pipeline execution / test batch
--   run_patients  run × patient  = one generated note + verdict  (a "record")
--   agent_runs    run × patient × agent = that agent's input + output (all agent data)
--   metrics       normalized metric points (feeds every chart)
--   run_logs      per-run stdout/stderr, tagged by agent
--
-- Apply with:  node db/reset.mjs  (drops old schemas, creates lab, backfills)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE SCHEMA IF NOT EXISTS lab;

-- updated_at helper ----------------------------------------------------------
CREATE OR REPLACE FUNCTION lab.touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ── patients ───────────────────────────────────────────────────────────────
-- The long-term reference case. slug is the fixture name (e.g. 'patient1',
-- 'hair-fall-tests') and is what shows up in the run selector.
CREATE TABLE IF NOT EXISTS lab.patients (
  id                serial PRIMARY KEY,
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL,
  heidi_session_id  text UNIQUE,
  source_url        text,
  subtitle          text,
  tags              jsonb NOT NULL DEFAULT '[]'::jsonb,
  transcript_raw    text,
  transcript_clean  text,
  gold_note         text,                         -- the Heidi SOAP note (gold)
  transcript_sha256 text,
  gold_hash         text,
  artifacts         jsonb NOT NULL DEFAULT '[]'::jsonb,
  audits            jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_patients_touch ON lab.patients;
CREATE TRIGGER trg_patients_touch BEFORE UPDATE ON lab.patients
  FOR EACH ROW EXECUTE FUNCTION lab.touch_updated_at();

-- ── runs ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lab.runs (
  id                serial PRIMARY KEY,
  run_no            integer NOT NULL,             -- human sequential number
  label             text NOT NULL,                -- e.g. run_2026-07-17_17-36-41
  status            text NOT NULL DEFAULT 'done', -- running | done | error
  pipeline_version  text,
  model             text,
  prompt_snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes             text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  UNIQUE (label)
);

-- ── run_patients ───────────────────────────────────────────────────────────
-- run × patient = one generated note + verdict. This id is the "record id".
CREATE TABLE IF NOT EXISTS lab.run_patients (
  id             serial PRIMARY KEY,
  run_id         integer NOT NULL REFERENCES lab.runs(id) ON DELETE CASCADE,
  patient_id     integer NOT NULL REFERENCES lab.patients(id) ON DELETE CASCADE,
  generated_note text,
  rendered_note  text,
  status         text,                            -- OK | FLAGGED | INVALID | error
  schema_valid   boolean,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, patient_id)
);

-- ── agent_runs ─────────────────────────────────────────────────────────────
-- The heart of the lab: every agent's input and output for every run × patient.
CREATE TABLE IF NOT EXISTS lab.agent_runs (
  id             serial PRIMARY KEY,
  run_id         integer NOT NULL REFERENCES lab.runs(id) ON DELETE CASCADE,
  patient_id     integer NOT NULL REFERENCES lab.patients(id) ON DELETE CASCADE,
  run_patient_id integer REFERENCES lab.run_patients(id) ON DELETE CASCADE,
  agent_id       text NOT NULL,                   -- encounter-classifier, qa-validator, …
  seq            integer NOT NULL DEFAULT 0,       -- order within the pipeline
  system_prompt  text,                            -- exact resolved prompt used
  prompt_version integer,
  input          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- vars / upstream data fed in
  output_raw     text,
  output_parsed  jsonb,
  status         text NOT NULL DEFAULT 'ok',      -- ok | error
  error_message  text,
  tokens_in      integer,
  tokens_out     integer,
  latency_ms     integer,
  model          text,
  rerun_of       integer REFERENCES lab.agent_runs(id) ON DELETE SET NULL,
  attempt        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ── metrics ────────────────────────────────────────────────────────────────
-- Normalized: one row per (record, metric_key). Powers trend/compare/heatmap.
CREATE TABLE IF NOT EXISTS lab.metrics (
  id             serial PRIMARY KEY,
  run_id         integer NOT NULL REFERENCES lab.runs(id) ON DELETE CASCADE,
  patient_id     integer NOT NULL REFERENCES lab.patients(id) ON DELETE CASCADE,
  run_patient_id integer NOT NULL REFERENCES lab.run_patients(id) ON DELETE CASCADE,
  metric_key     text NOT NULL,                   -- section_coverage, qa_accuracy_score, …
  metric_value   numeric,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_patient_id, metric_key)
);

-- ── run_logs ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lab.run_logs (
  id         bigserial PRIMARY KEY,
  run_id     integer NOT NULL REFERENCES lab.runs(id) ON DELETE CASCADE,
  patient_id integer REFERENCES lab.patients(id) ON DELETE CASCADE,
  agent_id   text,
  stream     text NOT NULL DEFAULT 'stdout',
  line       text NOT NULL,
  ts         timestamptz NOT NULL DEFAULT now()
);

-- ── indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_run_patients_run     ON lab.run_patients(run_id);
CREATE INDEX IF NOT EXISTS idx_run_patients_patient ON lab.run_patients(patient_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_run       ON lab.agent_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_rp        ON lab.agent_runs(run_patient_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent     ON lab.agent_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_lookup    ON lab.agent_runs(run_id, patient_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_metrics_run          ON lab.metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_metrics_key          ON lab.metrics(metric_key);
CREATE INDEX IF NOT EXISTS idx_metrics_rp           ON lab.metrics(run_patient_id);
CREATE INDEX IF NOT EXISTS idx_run_logs_run         ON lab.run_logs(run_id);

-- ── convenience views ──────────────────────────────────────────────────────
-- Average of every metric per run (long form) + patient count.
CREATE OR REPLACE VIEW lab.v_run_summary AS
SELECT r.id AS run_id, r.run_no, r.label, r.status, r.started_at, r.finished_at,
       (SELECT count(*) FROM lab.run_patients rp WHERE rp.run_id = r.id) AS patient_count,
       m.metric_key,
       avg(m.metric_value) AS avg_value
FROM lab.runs r
LEFT JOIN lab.metrics m ON m.run_id = r.id
GROUP BY r.id, r.run_no, r.label, r.status, r.started_at, r.finished_at, m.metric_key;

-- Per agent per run: throughput + reliability.
CREATE OR REPLACE VIEW lab.v_agent_stats AS
SELECT run_id, agent_id,
       count(*)                                             AS calls,
       count(*) FILTER (WHERE status = 'error')             AS errors,
       avg(latency_ms)                                      AS avg_latency_ms,
       avg(tokens_in)                                       AS avg_tokens_in,
       avg(tokens_out)                                      AS avg_tokens_out
FROM lab.agent_runs
GROUP BY run_id, agent_id;

COMMIT;
