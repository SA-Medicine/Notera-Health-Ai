# Notera Testing Lab — Upgrade Plan

Turning the admin dashboard into a full **testing & improvement tool**: a humanized
data model, JSON session import, per-agent storage + rerun, and a Power BI–style
analytics dashboard.

Your decisions (locked in):
- **Schema:** full replacement — drop `clinical` / `phi` / `ops`, recreate one clean schema.
- **Reference data:** uploaded Heidi JSON (transcript **and** its gold SOAP note) is added as
  new named patients **alongside** Patient 1/2/3, selectable in run ranges and visible in runs.
- **Rerun:** both modes, selectable — single agent from stored input, or that agent + everything downstream.
- **Dashboard:** trend across runs, run-vs-run compare, per-agent drilldown, fixture heatmap,
  plus drill-down that compares the generated note against the gold/Heidi note using the
  QA-validator schema metrics.

---

## 1. New humanized schema (`lab`)

One schema, six plain tables. Every run/agent/metric traces back to a patient.

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `lab.patients` | Long-term reference case (the "user/session"). Heidi transcript + gold note that never change. | `id` pk, `slug` (unique, = fixture name), `name`, `heidi_session_id`, `source_url`, `subtitle`, `tags` jsonb, `transcript_raw`, `transcript_clean`, `gold_note`, `transcript_sha256`, `gold_hash`, `artifacts` jsonb, `audits` jsonb, `created_at`, `updated_at` |
| `lab.runs` | One pipeline execution (a test batch). | `id` pk, `run_no` (sequential), `label` (e.g. `run_2026-07-17_17-36-41`), `status`, `pipeline_version`, `model`, `prompt_snapshot` jsonb, `started_at`, `finished_at`, `notes` |
| `lab.run_patients` | run × patient = one generated note + verdict. This is your **record**. | `id` pk (record_id), `run_id` fk, `patient_id` fk, `generated_note`, `status`, `schema_valid`, unique(`run_id`,`patient_id`) |
| `lab.agent_runs` | **All agent data** — per run × patient × agent, input + output. | `id` pk, `run_id` fk, `patient_id` fk, `run_patient_id` fk, `agent_id`, `seq`, `system_prompt`, `prompt_version`, `input` jsonb, `output_raw`, `output_parsed` jsonb, `status`, `error_message`, `tokens_in`, `tokens_out`, `latency_ms`, `model`, `rerun_of` fk (nullable), `attempt`, `created_at` |
| `lab.metrics` | Normalized metric points (feeds every chart). | `id` pk, `run_id` fk, `patient_id` fk, `run_patient_id` fk, `metric_key`, `metric_value` numeric, unique(`run_patient_id`,`metric_key`) |
| `lab.run_logs` | Per-run stdout/stderr, tagged by agent. | `id` pk, `run_id` fk, `agent_id`, `stream`, `line`, `ts` |

This maps directly to your model: **primary key** = `agent_runs.id`, **run no** =
`runs.run_no`, **session** = `patients`, **agent id** = `agent_runs.agent_id`,
**record id** = `run_patients.id`.

Prompts stay in the existing file registry (`backend/prompts/store/`) — no duplicate DB
table. Each `agent_runs` row snapshots the exact resolved `system_prompt` + version it used,
which is what makes reruns and "what prompt produced this" trivial.

Convenience **views** for the dashboard: `v_run_summary` (avg metrics per run),
`v_metric_wide` (pivot per record), `v_agent_stats` (latency/tokens/error/pass rate per
agent per run). Indexes on all FKs, `metric_key`, `agent_id`, `(run_id, patient_id)`.

### Drop & recreate
New `db/schema.lab.sql` + `db/reset.mjs` (and `db/reset.bat`). The reset:
1. `pg_dump -Fc` the current DB to `db/backups/pre-lab-<timestamp>.dump` (safety, even on full replace).
2. `DROP SCHEMA IF EXISTS clinical, phi, ops, lab CASCADE;`
3. Apply `schema.lab.sql`.
4. Run backfill (below).

Commands you'll get: `npm run db:reset` (wrapper), plus the raw
`docker exec … psql` equivalents.

### Backfill (nothing lost)
`db/backfill_lab.mjs` imports existing `data/gold/*.txt` → `lab.patients`, and existing
`eval/results/run_*/` + `_history.jsonl` → `runs` / `run_patients` / `metrics`, so your
past runs and current Patients 1–10 appear immediately in the new dashboard.

---

## 2. JSON session import

**Endpoint:** `POST /api/patients/import` (accepts the Heidi export array you pasted).
For each session, in one transaction:
- Upsert `lab.patients` by `heidi_session_id` (slug from `subtitle`/`session_title`, sanitized & de-duped).
- `transcript_clean` = `transcript.clean_text` (fallback `raw_text`); `gold_note` = `soap_note.soap_note`; store hashes, `artifacts`, `audits` as jsonb.
- **Also write `data/gold/<slug>.txt`** = `clean_text` + `\n\nSubjective:…` gold note, so the patient instantly becomes a runnable fixture in `run_eval` and appears in the run selector alongside Patient 1/2/3.
- Idempotent: re-uploading updates in place. Malformed rows skipped and reported.

**UI:** an "Import sessions" drop-zone (new **Patients** area, also surfaced on the Run tab).
After upload: a summary of added/updated patients with their names, and they show up in the
range picker right away.

Industry-grade: JSON shape validation, size cap, transactional per-file with a per-row
error report, dedupe by `sha256`.

---

## 3. Persist agent I/O during runs

Wire `PipelineEngine` / `generateNote` (via the store layer) to write each agent's
`input` + `output` + tokens/latency into `lab.agent_runs`, the final note into
`lab.run_patients`, and scores into `lab.metrics` — every eval run. File output stays for
backward compatibility. This is the foundation reruns and the agent drilldown read from.

---

## 4. Rerun an agent separately (both modes)

**Endpoint:** `POST /api/runs/:runId/rerun-agent` `{ patientId, agentId, mode, promptOverride? }`
- **single** — load the stored `input` for that agent, resolve current (or overridden) prompt, call the LLM, store a new `agent_runs` row (`rerun_of` = original, `attempt`+1), recompute only the metrics that depend on that agent (e.g. QA-validator → all `qa_*` metrics) and upsert.
- **downstream** — re-run that agent and every later agent in `seq` order, threading fresh outputs, producing a new generated note + full metric set (stored as a new attempt).

**UI:** on a result, pick agent → choose *single* / *downstream* → **Rerun**; see the new
output diffed against the old and metrics update live. Plus a **"Rerun on latest run"**
button in the Prompts tab for the selected agent (e.g. iterate the QA-validator prompt and
re-score the whole last run in seconds — no full pipeline).

---

## 5. Power BI–style metrics dashboard

Replaces the single trend line with a filterable, cross-linked analytics screen
(React + Recharts), backed by new DB endpoints (`/api/metrics/overview|trend|compare|agents|heatmap`, `/api/patients`).

- **Filter bar** (persisted): run range, patient multiselect, metric selector, agent selector.
- **KPI cards:** latest-run averages + pass rate, each with Δ vs previous run.
- **Trend across runs:** multi-metric lines with toggles; QA dynamic metrics on a 2nd axis; brush to zoom the run range.
- **Run-vs-run compare:** pick A/B → per-metric and per-patient deltas, regressions red / gains green, diff bars.
- **Per-agent drilldown:** table + heatmap of latency / tokens / error rate / pass rate per agent; click an agent to see its output per patient.
- **Fixture heatmap:** patient × metric color grid; click a cell → opens the Results comparison for that run+patient (generated vs gold + the QA-schema scores) — your requested drill-down.
- **Cross-linking everywhere:** cells/rows jump to Results (run+patient) and Prompts (agent), reusing existing nav.

---

## 6. Phasing (one-by-one, verified each step)

1. **Schema + reset + backfill** — new `lab` schema, `db:reset`, import current gold + past runs.
2. **JSON import** — endpoint + UI + gold `.txt` generation.
3. **Persist agent I/O** — pipeline writes `agent_runs` / `run_patients` / `metrics`.
4. **Rerun agent** — both modes, endpoints + UI + Prompts "rerun on latest".
5. **Dashboard** — the five panels above.
6. **Verification** — unit tests for ingest, rerun, and aggregation using a **mocked LLM**
   (so it's fully testable while the Gemini key is being sorted), plus schema/JSX parse checks.

Phases 1, 2, 5 and all the plumbing of 3–4 need **no** API key. Only the actual LLM reruns
in phase 4 need a valid `AIzaSy…` key — everything else can be built and tested now.

---

## Bonus ideas to make it a true testing tool
Pin a **baseline run** and auto-flag regressions; **prompt A/B** (run the same fixtures with
two prompt versions side by side); per-agent **cost/latency** tracking; **CSV export**; run
**tags/notes**; a "**gold vs generated**" section-level diff viewer.
