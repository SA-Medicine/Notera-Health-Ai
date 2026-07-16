# PostgreSQL Migration Plan — Notera-Health-Ai

_Status: PLAN for approval · Target: PostgreSQL 18 (Docker-hosted) · Author: Claude · Date: 2026-07-13_

This is a plan only. It defines what moves to Postgres, the SQL schema (`db/schema.sql`), the Docker deployment (`db/docker-compose.postgres.yml`), and the migration/rollout steps. Nothing is migrated until you approve.

## 1. What data exists today (inventory)

Your data lives in three places right now:

**Firestore (the clinical record)** — `backend/src/firestore/store.js` defines: `consults` (with `transcript`, `entities`, and sub-collections `drafts`, `finals`, `feedback`), `deidMaps` (token→PHI, the most sensitive data), an append-only `auditLog`, and a `models` registry. There's also an in-memory driver for dev.

**Files on disk** — the prompt registry (`backend/prompts/store/*.json` = prompt records + `store/<id>/v<n>.json` versions + the new `freeform`/`maxOutputTokens`/`schema` config), the eval results (`eval/results/run_*/` = per-fixture `.json`, `_summary.json`, `_pipeline.log`, and the cross-run `_history.jsonl`), the admin `runs.json` + logs, and session exports (`admin/data/sessions/*.json`).

**Schemas** — the canonical note contract is JSON Schema (`schema/note.schema.v2.0.0.json`); notes are validated against it. That stays as the shape of the `note` JSONB column.

## 2. Design approach (why hybrid relational + JSONB)

Current best practice for clinical data on Postgres is a **hybrid**: relational columns for the fixed, frequently-queried attributes (ids, clinician, status, timestamps, specialty) and **JSONB for the variable clinical payloads** (the structured note, NER entities, FHIR, artifacts). This gives you SQL joins, foreign keys and constraints where they matter, plus schema-flexible document storage where medicine is inherently narrative and evolving — without a table migration every time the note shape changes. JSONB is indexable (GIN + expression indexes), so you keep query performance. (Sources at the end.)

Concretely: do **not** cram everything into one JSON blob. Extract the identifiers and hot filter-columns to real columns; keep the rest in JSONB with GIN indexes.

## 3. Target schema (`db/schema.sql`)

Full DDL is in `db/schema.sql` (validated against the PostgreSQL 18 parser). It is organized into three schemas so PHI is isolated:

- **`clinical`** — `clinicians`, `consults`, `drafts`, `finals`, `feedback`, `audit_log`
- **`phi`** — `deid_maps` (encrypted; isolated, service-role-only)
- **`ops`** — `models`, `prompts`, `prompt_versions`, `eval_runs`, `eval_fixture_results`, `eval_metric_points`, `sessions`

Key rules baked in:

- **Foreign keys** with `ON DELETE CASCADE` from `drafts`/`finals`/`feedback`/`deid_maps` to `consults`, so deleting a consult cleans up its children.
- **Typed status** via enums (`consult_status`, `note_status`) instead of free text.
- **`updated_at` triggers** on mutable tables.
- **Append-only `audit_log`** and **immutable `prompt_versions`** — a trigger raises on any UPDATE/DELETE (matches the current append-only audit + immutable-version design).
- **JSONB GIN indexes** on `consults.entities` and `drafts.note` for containment queries; b-tree indexes on `clinician_id`, `status`, `created_at`, `specialty`.
- **`eval_metric_points`** — a normalized `(run_id, metric_key, value)` table so the Metrics-tab chart (including the dynamic `avg_qa_*` metrics we just added) can be trended with a trivial `SELECT`, and arbitrary new metrics need no schema change.
- **De-id map** stored as `BYTEA` encrypted with `pgcrypto` (`pgp_sym_encrypt`), key held **outside** the DB (app/KMS), never stored in a column.
- **Row-Level Security** on `consults`/`drafts`/`finals`/`deid_maps`: a clinician session sees only its own consults; a `service`/`admin` role sees all; `deid_maps` is service-role-only. The app sets `app.clinician_id` / `app.role` per request via `SET LOCAL`.

## 4. Table-by-table mapping (Firestore/files → Postgres)

| Source | Target table |
|---|---|
| Firestore `consults` doc | `clinical.consults` (transcript/entities → JSONB) |
| `consults/<id>/drafts` | `clinical.drafts` |
| `consults/<id>/finals` | `clinical.finals` |
| `consults/<id>/feedback` | `clinical.feedback` |
| `deidMaps` | `phi.deid_maps` (encrypted) |
| `auditLog` | `clinical.audit_log` (append-only) |
| `models` | `ops.models` |
| `backend/prompts/store/<id>.json` | `ops.prompts` |
| `backend/prompts/store/<id>/v*.json` | `ops.prompt_versions` |
| `eval/results/run_*/_summary.json` + `runs.json` | `ops.eval_runs` |
| `eval/results/run_*/<fixture>.json` | `ops.eval_fixture_results` |
| `_history.jsonl` numeric metrics | `ops.eval_metric_points` |
| `admin/data/sessions/*.json` | `ops.sessions` |
| `_pipeline.log` (large text) | stays a file, or optional `ops.run_logs` |

## 5. Deployment (`db/docker-compose.postgres.yml`)

- **PostgreSQL 18** in Docker with a **named volume** (`pgdata`) so data survives container recreation, a **healthcheck** (`pg_isready`), CPU/memory **resource limits**, secrets via **files** (not env, so they don't leak in `docker inspect`), and a **user-defined bridge network** for stable DNS between app and DB.
- **`pgaudit`** preloaded (`pgaudit.log=write,ddl`) plus `log_connections`/`log_disconnections`; **TLS on** for connections in transit.
- A **backup sidecar** runs nightly `pg_dump -Fc` (custom format), GPG-encrypts it, and prunes to 7-day retention. Backups live on a mounted host path outside the container.
- First-boot `./init` runs `schema.sql`. In production, prefer a migration tool over init scripts (see §7).

**Host-level (for real PHI):** enable filesystem encryption for the data directory + WAL (LUKS/ZFS), and encrypt backups/WAL archives with a KMS-managed key. Postgres has no built-in TDE, so at-rest encryption is done at the OS/volume layer + `pgcrypto` for the de-id map column.

## 6. Access layer in the app

Replace the Firestore driver in `backend/src/firestore/store.js` with a **Postgres driver behind the same async API** (`createConsult`, `addDraft`, …). This is the key non-breaking move: the orchestrator calls `store.*` — swap the implementation, keep the interface.

- Client: `pg` (node-postgres) with a pool, or a typed layer (Drizzle / Prisma / Kysely).
- Migrations: a real tool (`node-pg-migrate`, Drizzle Kit, or Flyway) — versioned, forward-only, in CI. `schema.sql` is the baseline (migration `0001`).
- Every request: `SET LOCAL app.clinician_id = $1; SET LOCAL app.role = $2;` so RLS applies.

## 7. Migration & rollout (phased, reversible)

1. **Stand up Postgres** (compose up) + apply `schema.sql` in a staging environment. No app change yet.
2. **Backfill scripts** (one per source): read Firestore/JSON → insert into Postgres. Idempotent (upsert on primary key). Verify row counts + checksums (e.g. transcript `sha256`).
3. **Dual-write** from the app: writes go to both Firestore and Postgres; reads still from Firestore. Compare for a burn-in period.
4. **Flip reads** to Postgres behind a flag (`STORE_BACKEND=postgres`). Firestore becomes the fallback/rollback path.
5. **Cutover**: Postgres is source of truth; stop dual-write. Keep Firestore read-only for N days, then decommission.
6. **Files** (prompts/eval/sessions) migrate the same way — backfill, then point the admin server's readers/writers at Postgres (the admin `server.mjs` prompt + eval + session endpoints become SQL queries).

Each phase is independently reversible; nothing deletes source data until cutover is confirmed.

## 8. Security & compliance checklist (PHI)

- Encryption at rest (LUKS/ZFS for data dir + WAL) and in transit (TLS); `pgcrypto` column encryption for the de-id map; keys in a KMS, never in the DB.
- Least privilege: app connects as a non-superuser; RLS enforces per-clinician / per-role access; `deid_maps` service-role-only.
- `pgaudit` for read/write/DDL on PHI tables → forward to an immutable log store (CloudWatch/Splunk).
- Backups encrypted + tested restores + point-in-time recovery (WAL archiving) if this holds real patient data.
- If this ever stores real PHI in a US context, a HIPAA BAA with the hosting provider is required.

## 9. Open decisions (your call before I build)

1. **Hosting**: self-managed Docker Postgres (as in the compose), or a managed service (RDS/Cloud SQL/Neon/Supabase) with a BAA? Managed reduces the encryption/backup/HA burden.
2. **Full cutover vs. keep Firestore**: replace Firestore entirely, or keep it for live consults and use Postgres as the analytics/warehouse copy?
3. **Real PHI or anonymized only**: does this DB ever hold real patient identifiers (drives the HIPAA/KMS/RLS rigor), or only the anonymized eval/session data?
4. **ORM / query layer**: raw `pg`, or Drizzle/Prisma/Kysely for typed models + migrations?
5. **Logs**: keep large `_pipeline.log` files on disk, or store in an `ops.run_logs` table?

## Sources
- [AWS — PostgreSQL as a JSON database: advanced patterns](https://aws.amazon.com/blogs/database/postgresql-as-a-json-database-advanced-patterns-and-best-practices/)
- [Health Samurai / Aidbox — Postgres + JSONB for FHIR](https://www.health-samurai.io/docs/aidbox/database/overview)
- [Elysiate — PostgreSQL JSONB performance best practices](https://www.elysiate.com/blog/postgresql-jsonb-performance-best-practices)
- [Docker Docs — PostgreSQL setup & data persistence](https://docs.docker.com/guides/postgresql/immediate-setup-and-data-persistence)
- [Infotechys — PostgreSQL containerization best practices](https://infotechys.com/postgresql-containerization-best-practices/)
- [Accountable — HIPAA-compliant PostgreSQL: encryption, access, auditing](https://www.accountablehq.com/post/postgresql-healthcare-security-configuration-guide-hipaa-compliant-encryption-access-controls-and-auditing)
- [Fastware — PostgreSQL security best practices 2026](https://www.postgresql.fastware.com/blog/postgresql-security-best-practices-for-enterprise-databases-in-2026)
- [endoflife.date — PostgreSQL versions](https://endoflife.date/postgresql) (18.4 current stable, June 2026)
