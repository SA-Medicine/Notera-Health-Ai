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
- **Prompts** — the modular prompt registry. Every pipeline agent's system prompt, grouped by stage, in a **single full-width editor**. Edits save as a **draft**; **Publish** creates a new immutable version that the live pipeline picks up on the next run (hot-reload via `backend/prompts/registry.js`). The **History** panel is the version manager — every version is listed with `load` (pull it into the editor) and `rollback` (republish an old version as the new live one); **Logs** lists recent runs that exercised that agent. Set `ADMIN_PROMPTS_READONLY=1` to disable publishing. (The editable LLM-as-judge rubric also lives here, under the "Judge" stage.)
- **Gates & Judge** — the deterministic grading gates + editable colour thresholds.

## Prompt registry
Prompts live in `backend/prompts/store/<id>.json` (metadata + draft) and `store/<id>/v<N>.json` (immutable versions). The 8 agent prompts were **seeded from source code as v1** and the agents now call `loadPrompt(id, <inline fallback>, vars)` — so an empty/absent registry falls back to the original inline prompt (nothing breaks). `{{token}}` placeholders are substituted at load time (e.g. `fact-recovery` → `{{missingCategories}}`).

## API
`POST /api/runs` · `GET /api/runs/:id/stream` (SSE) · `POST /api/runs/:id/kill` · `GET /api/runs`
`GET /api/results/runs` · `GET /api/results/:dir/files` · `GET /api/results/file?dir=&name=` · `GET /api/results/diff?a=&b=&name=`
`GET /api/metrics/history` · `GET /api/metrics/run/:dir` · `GET /api/metrics/compare?a=&b=`
`GET /api/prompts` · `GET /api/prompts/:id` · `GET /api/prompts/:id/version/:n` · `GET /api/prompts/:id/logs` · `PUT /api/prompts/:id` (draft) · `POST /api/prompts/:id/publish` · `POST /api/prompts/:id/revert`
`GET /api/sessions` · `GET /api/sessions/file?name=` · `POST /api/judge/run`
