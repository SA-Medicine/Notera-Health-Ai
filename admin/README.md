# Notera Auto-Tester — Admin Dashboard

Premium internal console for the regression harness. Zero-install: pure Node HTTP
server + a single-page app (CDN React/Tailwind/Chart.js/marked). Reads the real
`eval/results/` output and can spawn/stream runs.

## Run
```
npm run admin          # from repo root
# or: ADMIN_PORT=4300 ADMIN_PASSWORD=yourpass node admin/server.mjs
```
Open http://localhost:4300 · default password `notera` (set `ADMIN_PASSWORD` to change).

## Tabs
- **Overview** — latest scorecard + deltas, quick links.
- **Run** — pick a fixture (or all 10), Run → live stdout over SSE, filter/download log, Stop, recent-runs strip.
- **Results** — run → fixture tree with PASS/FAIL badges (★ = release blockers patient2/patient5), rendered markdown + Raw toggle + Copy, and **Diff vs** another run (inline line diff — the "did the fix hold" view).
- **Metrics** — trend chart, sortable per-run table (colour-coded), expand a run for per-fixture breakdown, and Compare two runs (metric deltas + fixture pass↔fail flips).
- **Gates & Judge** — the deterministic grading gates (this harness has no LLM judge yet) + editable colour thresholds.

## API
`POST /api/runs` · `GET /api/runs/:id/stream` (SSE) · `POST /api/runs/:id/kill` · `GET /api/runs`
`GET /api/results/runs` · `GET /api/results/:dir/files` · `GET /api/results/file?dir=&name=` · `GET /api/results/diff?a=&b=&name=`
`GET /api/metrics/history` · `GET /api/metrics/run/:dir` · `GET /api/metrics/compare?a=&b=`
