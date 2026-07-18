# Testing Lab — activation quickstart

Everything from the plan is built. To turn it on:

## 1. Switch the database to the new schema (one time)
```bat
npm run db:up          :: start Postgres (if not running)
npm run db:reset       :: backup → drop clinical/phi/ops → create lab → backfill gold + past runs
```
`db:reset` writes a `pg_dump` backup to `db/backups/` first, then applies `db/schema.lab.sql`
and imports your existing `data/gold/*` patients and `eval/results/*` runs so the dashboard has
data immediately. (Add `-- --no-backfill` to skip the import.)

Sanity check (no DB/LLM needed): `npm run db:test`  → 16 assertions.

## 2. Build the admin UI
```bat
cd admin\ui
npm install
npm run build
```
Then start the server from the repo root: `npm run admin` → http://localhost:4300

## 3. Use it
- **Patients tab** → drop your Heidi sessions JSON. Each session is added as a named patient
  and a runnable `data/gold/<slug>.txt` fixture, so it shows up in the Run selector and metric
  ranges next to Patient 1/2/3. Re-importing updates in place.
- **Run tab** → run any patients. Every run now also mirrors into the lab DB: the generated note,
  each agent's input+output, and all metrics.
- **Metrics tab** → the new dashboard: KPI cards with deltas, trend across runs (toggle metrics),
  fixture heatmap (click a cell → opens that note vs gold with the QA scores), per-agent stats,
  and run-vs-run compare.
- **Prompts tab** → edit a prompt, Publish, then **↻ Rerun on latest** to re-score just that agent
  (e.g. qa-validator) across the whole latest run in seconds — no full pipeline.
- **Rerun modes**: single (replay one agent's stored call, optionally with an edited prompt) and
  downstream (`/api/lab/rerun-agent` with `mode:"downstream"` → fresh full pipeline for that patient).

## Notes
- The model is now `gemini-3.5-flash` (your working model) via `GEMINI_MODEL` in `.env`.
- The lab DB mirror is best-effort: if Postgres is down, runs still write file results as before.
- The old Metrics "delete previous runs" button was replaced by the dashboard; deleting a run can
  be re-added as a lab endpoint if you want it back.
