# Notera-Health-Ai

Clinical documentation engine + internal testing lab, in one Turborepo. A single
Next.js app serves both surfaces; one Express backend serves both APIs; one shared
design system styles everything.

## Layout
```
apps/
  web/                 One Next.js app
    app/(app)/         Clinician product  — /, /login, /app, /consults
    app/(admin)/admin  Testing lab        — dark shadcn dashboard
    app/api/           Server-only BFF → backend (keeps PHI off the browser)
packages/
  ui/                  @notera/ui — shared shadcn design system (tokens + primitives)
  backend/             @notera/backend — Express: product (consults/pipeline) + admin/lab API
  config/              shared tsconfig base
schema/                @notera/schema — versioned SOAP JSON schema
eval/                  end-to-end eval harness (mirrors runs into the lab DB)
db/                    Postgres: lab schema, reset, backfill  (see db/README.md)
data/ ner/ deploy/     gold fixtures, NER sidecar, deploy configs
admin/data/            admin runtime state (run history, logs, sessions)
```

## Run (dev)
```bat
npm install
npm run db:up            :: start Postgres
npm run db:reset         :: first time — create the lab schema + backfill
npm run dev              :: turbo runs the backend (:8080) and Next (:3000) together
```
Open:
- **http://localhost:3000** — clinician product (white theme). Sign in → `/app`.
- **http://localhost:3000/admin** — testing lab (dark). Password `notera` (or `ADMIN_PASSWORD`).

The Next app proxies `/backend/*` → the Express backend, so everything is same-origin.

## Build
```bat
npm run build            :: turbo builds @notera/ui → @notera/backend → apps/web
```

## Key scripts
| Script | Does |
|--------|------|
| `npm run dev` | backend + Next together (Turborepo) |
| `npm run build` | production build of all workspaces |
| `npm run eval` | run the eval harness over `data/gold` |
| `npm run db:up` / `db:down` | start/stop Postgres |
| `npm run db:reset` | (re)create the lab schema + backfill |
| `npm run db:test` | pure-logic unit tests (no DB/LLM) |

## Configuration
Everything reads the repo-root `.env`: `GEMINI_API_KEY`, `GEMINI_MODEL`, `DATABASE_URL`,
`STORE_BACKEND`, `DEID_ENC_KEY`, `ADMIN_PASSWORD`, `BACKEND_URL`. See `db/README.md` for the
database, and `COMBINED_QUICKSTART.md` for the full first-run walkthrough.
