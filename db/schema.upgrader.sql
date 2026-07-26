-- ═══════════════════════════════════════════════════════════════════════════
-- Notera Testing Lab — System Upgrader tables (ADDITIVE migration).
--
-- Safe to run on a live database: only CREATE ... IF NOT EXISTS. Does NOT drop or
-- alter anything. Apply with:  node db/migrate_upgrader.mjs  (or npm run db:upgrader)
--
--   upgrade_runs        one optimizer invocation (analyses a run, per-agent or system)
--   prompt_suggestions  proposed prompt edits (targeted patches + full rewrite)
--   system_suggestions  non-prompt improvement ideas (pipeline / metric / guardrail …)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE SCHEMA IF NOT EXISTS lab;

-- ── upgrade_runs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lab.upgrade_runs (
  id             serial PRIMARY KEY,
  source_run_id  integer REFERENCES lab.runs(id) ON DELETE SET NULL,  -- the run analysed
  scope          text NOT NULL,                       -- 'agent' | 'system'
  agent_id       text,                                 -- null when scope='system'
  model          text,
  status         text NOT NULL DEFAULT 'running',      -- running | done | error
  input_summary  jsonb NOT NULL DEFAULT '{}'::jsonb,    -- what was fed in (counts, records, metrics)
  raw_output     text,                                  -- optimizer's raw response (audit)
  summary        text,                                  -- its narrative rationale
  error_message  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

-- ── prompt_suggestions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lab.prompt_suggestions (
  id                serial PRIMARY KEY,
  upgrade_run_id    integer NOT NULL REFERENCES lab.upgrade_runs(id) ON DELETE CASCADE,
  agent_id          text NOT NULL,
  base_version      integer,                            -- the prompt version it edits
  base_prompt       text,                                -- the exact prompt text the patches apply to
  rationale         text,                                -- the "textual gradient"
  patches           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{anchor,before,after,reason}]
  full_prompt       text,                                -- full rewritten prompt (fallback/preview)
  confidence        numeric,                             -- optimizer's self-rated 0..1
  protected_blocked boolean NOT NULL DEFAULT false,      -- true if a safety guard tripped
  protected_reason  text,
  status            text NOT NULL DEFAULT 'proposed',    -- proposed | published | dismissed
  published_version integer,                             -- set when a human publishes
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ── system_suggestions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lab.system_suggestions (
  id             serial PRIMARY KEY,
  upgrade_run_id integer NOT NULL REFERENCES lab.upgrade_runs(id) ON DELETE CASCADE,
  category       text,                                  -- pipeline | metric | guardrail | data | other
  title          text NOT NULL,
  detail         text NOT NULL,
  severity       text,                                  -- info | low | high
  status         text NOT NULL DEFAULT 'open',          -- open | accepted | dismissed
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- forward-compat: add columns if an earlier version of this migration already ran
ALTER TABLE lab.prompt_suggestions ADD COLUMN IF NOT EXISTS base_prompt text;

CREATE INDEX IF NOT EXISTS idx_upgrade_runs_source     ON lab.upgrade_runs(source_run_id);
CREATE INDEX IF NOT EXISTS idx_prompt_sugg_upgrade     ON lab.prompt_suggestions(upgrade_run_id);
CREATE INDEX IF NOT EXISTS idx_prompt_sugg_agent       ON lab.prompt_suggestions(agent_id);
CREATE INDEX IF NOT EXISTS idx_system_sugg_upgrade     ON lab.system_suggestions(upgrade_run_id);

COMMIT;
