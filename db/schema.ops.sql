-- ─────────────────────────────────────────────────────────────────────────────
-- Notera — operational monitoring schema (ops.*).
-- Powers monitor.aitoolsfordoctor.com: per-account token/cost, pipeline runs,
-- a SEPARATE error log, and audio safety events. Contains NO PHI — ids, counts,
-- codes, timings only. Idempotent (also ensured at backend startup by opsLog.js).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS ops;

-- one row per note generation
CREATE TABLE IF NOT EXISTS ops.pipeline_runs (
  run_id            BIGSERIAL PRIMARY KEY,
  consult_id        TEXT,
  clinician_id      TEXT,
  model             TEXT,
  status            TEXT,                 -- 'ok' | 'error' | 'partial' | 'empty_transcript'
  duration_ms       INTEGER,
  transcript_chars  INTEGER,
  note_chars        INTEGER,
  prompt_tokens     INTEGER DEFAULT 0,
  output_tokens     INTEGER DEFAULT 0,
  total_tokens      INTEGER DEFAULT 0,
  est_cost_usd      NUMERIC(10,5) DEFAULT 0,
  per_agent         JSONB,
  timings           JSONB,
  error_id          BIGINT,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_runs_clinician_idx ON ops.pipeline_runs (clinician_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pipeline_runs_status_idx    ON ops.pipeline_runs (status, created_at DESC);

-- the separate error log
CREATE TABLE IF NOT EXISTS ops.errors (
  error_id      BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ DEFAULT now(),
  source        TEXT,        -- 'pipeline' | 'asr' | 'api' | 'frontend' | 'auth'
  agent         TEXT,
  level         TEXT,        -- 'error' | 'warn'
  code          TEXT,        -- 'GEMINI_400' | 'GEMINI_429' | 'ASR_TIMEOUT' | ...
  message       TEXT,
  stack         TEXT,        -- redacted before insert
  consult_id    TEXT,
  clinician_id  TEXT,
  context       JSONB
);
CREATE INDEX IF NOT EXISTS errors_ts_idx        ON ops.errors (ts DESC);
CREATE INDEX IF NOT EXISTS errors_source_idx    ON ops.errors (source, code, ts DESC);
CREATE INDEX IF NOT EXISTS errors_clinician_idx ON ops.errors (clinician_id, ts DESC);

-- audio safety events (silence / empty)
CREATE TABLE IF NOT EXISTS ops.audio_events (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ DEFAULT now(),
  consult_id    TEXT,
  clinician_id  TEXT,
  reason        TEXT,        -- 'silence_timeout' | 'empty_segment' | 'empty_transcript'
  duration_ms   INTEGER,
  meta          JSONB
);
CREATE INDEX IF NOT EXISTS audio_events_ts_idx ON ops.audio_events (ts DESC);

-- editable model price table ($ per 1M tokens); seeded, overridable at runtime
CREATE TABLE IF NOT EXISTS ops.model_prices (
  model         TEXT PRIMARY KEY,
  input_per_m   NUMERIC(10,4) NOT NULL,
  output_per_m  NUMERIC(10,4) NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT now()
);
