# Notera — PostgreSQL database

Local, Docker-hosted **PostgreSQL 18** — the single source of truth for all app data
(full cutover from Firestore + files). De-id maps are encrypted, PHI tables use
row-level security, and the audit log is append-only.

---

## 🚀 Quick start (new user, Windows)

You need **Docker Desktop** (running) and **Node 20+**. Then, from the project root:

1. **One-time setup** — double-click **`db\setup.bat`** (or run it in a terminal).
   It creates the database container, generates the password + keys, writes `.env`,
   applies the schema, and loads existing data. Wait for **“Database is LIVE”**.

2. **Every day before you work** — run **`db\start.bat`** to bring the database up
   (Docker keeps your data between restarts). Then start the app with `npm run dev:backend`.

3. **When you're done** (optional) — `db\stop.bat` to stop the container. Your data stays.

That's it. The scripts are safe to re-run.

> **macOS / Linux:** run the equivalent commands from the “Manual steps” section below —
> the `.bat`/`.ps1` files are Windows-only, but `migrate.mjs` / `backfill_files.mjs` are cross-platform.

---

## ▶️ Make the database live (the command you asked for)

Already set up and just want the DB running before working?

```powershell
db\start.bat
```
or directly:
```powershell
docker compose -f db/docker-compose.postgres.yml up -d
```
It's ready when `docker compose -f db/docker-compose.postgres.yml ps` shows **healthy**
and the app can connect at `postgres://notera_admin:<password>@localhost:5432/notera`.

---

## Files
| File | What it is |
|---|---|
| `setup.bat` / `setup.ps1` | One-time setup: container + secrets + `.env` + schema + backfill. |
| `start.bat` / `stop.bat` | Bring the database up / down for daily work. |
| `schema.sql` | Full DDL (schemas `clinical` / `phi` / `ops`). Idempotent. |
| `docker-compose.postgres.yml` | Postgres 18 + nightly backup sidecar. |
| `migrate.mjs` | Applies `schema.sql`. |
| `backfill_files.mjs` | Loads prompts, eval runs/metrics, sessions, logs from disk. |
| `backfill_firestore.mjs` | Loads live consults / de-id maps / audit / models from Firestore. |

The app reads/writes Postgres via `backend/src/db/pool.js` + `pgStore.js`, selected by
`STORE_BACKEND=postgres` in `backend/src/firestore/store.js`.

---

## Manual steps (what `setup.bat` automates)

```powershell
# 1. folders + a URL-safe DB password (no openssl needed)
New-Item -ItemType Directory -Force -Path db\secrets, db\backups, db\init | Out-Null
$pw = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})
[IO.File]::WriteAllText("$PWD\db\secrets\pg_password.txt", $pw)

# 2. .env
Copy-Item .env.example .env -Force
(Get-Content .env) `
  -replace '^STORE_BACKEND=.*','STORE_BACKEND=postgres' `
  -replace '^DATABASE_URL=.*',"DATABASE_URL=postgres://notera_admin:$pw@localhost:5432/notera" `
  -replace '^DEID_ENC_KEY=.*',"DEID_ENC_KEY=$pw`K3y" | Set-Content .env

# 3. start Postgres
docker compose -f db/docker-compose.postgres.yml up -d
docker compose -f db/docker-compose.postgres.yml ps      # wait for "healthy"

# 4. driver + schema + data
npm install
$env:DATABASE_URL = "postgres://notera_admin:$pw@localhost:5432/notera"
$env:DEID_ENC_KEY = "$pw`K3y"
node db/migrate.mjs
node db/backfill_files.mjs
```

### Optional: import live Firestore data (real PHI)
Needs Google credentials + `DEID_ENC_KEY` set:
```powershell
node db/backfill_firestore.mjs
```

---

## Verify
```powershell
docker exec -it notera-postgres psql -U notera_admin -d notera -c "\dt clinical.*"
docker exec -it notera-postgres psql -U notera_admin -d notera -c "\dt ops.*"
docker exec -it notera-postgres psql -U notera_admin -d notera -c "SELECT count(*) FROM ops.prompts;"
docker exec -it notera-postgres psql -U notera_admin -d notera -c "SELECT metric_key, count(*) FROM ops.eval_metric_points GROUP BY 1 ORDER BY 1;"
```

## Backups & restore
The `pg-backup` sidecar writes `db/backups/notera_<ts>.dump` nightly (7-day retention). Restore:
```powershell
docker exec -i notera-postgres pg_restore -U notera_admin -d notera --clean --if-exists < db/backups/notera_YYYYMMDD_HHMMSS.dump
```

## Troubleshooting
- **`up` fails / container “unhealthy” instantly** → check `docker compose -f db/docker-compose.postgres.yml logs postgres`. A blank secret file or a stale volume from a failed boot are the usual causes; wipe + retry: `docker compose -f db/docker-compose.postgres.yml down -v` then `up -d`.
- **migrate says “applied” but tables are missing** → the schema is one transaction; a truncated `schema.sql` (no final `COMMIT;`) rolls everything back. Confirm the file ends with `COMMIT;`.
- **`node` connection error with a blank message** → Postgres port isn’t reachable on the host; the compose must publish `5432:5432` and the container must be `healthy`.

## Notes
- **Keys:** `DEID_ENC_KEY` decrypts the de-id map — keep it in a secret manager in production, never in git.
- **At-rest encryption:** Postgres has no built-in TDE; encrypt the host volume (LUKS/ZFS) for `pgdata` + backups when holding real PHI.
- **RLS:** the service connects as the table owner (RLS bypassed). Add a restricted per-clinician DB role later and RLS enforces per-clinician access via the `app.clinician_id` / `app.role` session vars set in `pool.withSession`.
