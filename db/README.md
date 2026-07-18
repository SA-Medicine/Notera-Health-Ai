# Database — Testing Lab (PostgreSQL)

Local, Docker-hosted **PostgreSQL 18**. One database (`notera`), one humanized schema
(`lab`, see `schema.lab.sql`). Everything traces back to a **patient** (a reference case)
and a **run** (one pipeline execution).

---

## New user — create the database from zero

**Prerequisites:** Docker Desktop (running) and Node 20+. Run everything from the repo root.

### Option A — one command (Windows, recommended)
```bat
db\setup.bat
```
This runs `db/setup.ps1`, which:
1. checks Docker is running,
2. generates a DB password → `db/secrets/pg_password.txt`,
3. creates `.env` from `.env.example` and fills in `STORE_BACKEND=postgres`,
   `DATABASE_URL`, and a fresh `DEID_ENC_KEY`,
4. starts the Postgres container and waits until it's **healthy**,
5. `npm install`, then `node db/reset.mjs` (creates the `lab` schema + backfills gold/runs).

When it prints **"Database is LIVE on localhost:5432"** you're done.

### Option B — manual (any OS)
```bash
# 1. DB password → the file the container reads
mkdir -p db/secrets db/backups db/init
#   put a strong password in db/secrets/pg_password.txt  (one line, no newline)
printf 'change-me-strong-pass' > db/secrets/pg_password.txt

# 2. .env at the repo root (copy the example, then set these)
cp .env.example .env
#   STORE_BACKEND=postgres
#   DATABASE_URL=postgres://notera_admin:<the password above>@localhost:5432/notera
#   DEID_ENC_KEY=<any 32-char random string>

# 3. start Postgres and create the schema + seed data
npm install
npm run db:up            # docker compose up -d  (wait until STATUS = healthy)
npm run db:reset         # backup → create the lab schema → backfill data/gold + eval/results
```

Container: **notera-postgres** · DB **notera** · user **notera_admin** · port **5432**.

---

## Run it (day to day)
```bat
npm run db:up            :: start Postgres (if not already running)
npm run dev              :: from the repo root — starts backend (:8080) + Next app (:3000)
npm run db:down          :: stop Postgres
```
The app reads `DATABASE_URL`, `STORE_BACKEND=postgres`, and `DEID_ENC_KEY` from the repo-root `.env`.

### Other DB commands
```bat
npm run db:reset         :: re-create the lab schema + backfill (DESTRUCTIVE — backs up first)
npm run db:backfill:lab  :: re-run just the backfill (idempotent)
npm run db:test          :: 16 pure-logic assertions (no DB/LLM needed)
```

---

## Schema (`lab`)
| Table | Purpose |
|-------|---------|
| `lab.patients` | reference case: transcript + gold SOAP note (never changes) |
| `lab.runs` | one pipeline execution / test batch |
| `lab.run_patients` | run × patient = one generated note + verdict (a "record") |
| `lab.agent_runs` | run × patient × agent = that agent's input + output |
| `lab.metrics` | normalized metric points (feeds every chart) |
| `lab.run_logs` | per-run stdout/stderr, tagged by agent |

## Files
| File | What it does |
|------|--------------|
| `schema.lab.sql` | The `lab` schema DDL (tables, indexes, views). Idempotent. |
| `reset.mjs` / `reset.bat` | Backup → drop old schemas → apply `schema.lab.sql` → backfill. |
| `backfill_lab.mjs` | Seeds `data/gold/*` + `eval/results/*` into the lab tables. |
| `test_lab_logic.mjs` | Pure-logic unit tests. |
| `docker-compose.postgres.yml` | Postgres 18 + nightly `pg_dump` backup sidecar. |
| `setup.ps1` / `setup.bat` | First-run helper (Option A above). |
| `start.bat` / `stop.bat` | Start/stop the container (wrap `db:up` / `db:down`). |
| `init/` | Optional SQL run on the container's first init (compose mount). |
| `secrets/pg_password.txt` | DB password the container reads (git-ignored). |
| `backups/` | `pg_dump` output written by `reset.mjs`. |

## Notes
- `reset.mjs` is **destructive**: it drops `clinical` / `phi` / `ops` / `lab` and recreates
  `lab`, writing a `pg_dump` to `backups/` first. Reference data re-seeds from `data/gold`
  and from any Heidi-style JSON you import in the admin **Patients** tab.
- Runs mirror into the lab DB automatically (best-effort); if Postgres is down, file results
  under `eval/results/` are still written.

## Troubleshooting
- **`docker compose up` says unhealthy / exits** — check `docker compose -f db/docker-compose.postgres.yml logs postgres`. Usually a missing `db/secrets/pg_password.txt`.
- **`db:reset` connection refused** — the container isn't published/healthy yet; run `npm run db:up` and wait for STATUS `healthy`, then retry.
- **`DATABASE_URL is not set`** — it's missing/blank in the repo-root `.env` (Option A fills it in automatically).
