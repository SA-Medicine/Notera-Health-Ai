# Notera — combined monorepo quickstart

The clinician app and the testing lab are now **one Next.js app** on **one Express backend**,
sharing **one design system**, in a Turborepo. The old `web/`, `backend/`, and `admin/` folders
are left in place for reference — the live app is under `apps/` and `packages/`.

```
apps/web            # the ONE Next.js app  (:3000)
  app/(app)/...     #   clinician product  (/, /new, /consults)
  app/(admin)/admin #   testing lab        (/admin)
  app/api/...       #   server-only BFF → backend (keeps PHI off the browser)
packages/ui         # @notera/ui  — shared shadcn design system (tokens + primitives)
packages/backend    # @notera/backend — ONE Express service (:8080), product + lab APIs
packages/config     # shared tsconfig base
db/ eval/ data/ ner/# unchanged; eval + db scripts now point at packages/backend
```

## Install & run (one command)
```bat
npm install            :: installs all workspaces + hoists deps
npm run db:up          :: start Postgres
npm run db:reset       :: (first time) create the lab schema + backfill
npm run dev            :: turbo runs BOTH the backend (:8080) and Next (:3000)
```
Then open:
- **http://localhost:3000** — clinician product (Home → New consult → review → sign off, Consults)
- **http://localhost:3000/admin** — testing lab (run, patients, results, metrics, prompts, judge)

The Next app proxies `/backend/*` → the Express backend, so everything is same-origin. Product
data flows through the Next server-only BFF (`app/api/*` → `app/lib/backend.ts`), so the service
token and raw PHI never reach the browser; the admin/lab calls (no PHI) go through `/backend/*`.

## Build (production)
```bat
npm run build          :: turbo builds @notera/ui → @notera/backend → apps/web
```
Serve the Next app (`apps/web`) and run the Express backend (`packages/backend`) behind one origin.

## Verify
```bat
npm run db:test        :: 16 pure-logic assertions (no DB/LLM needed)
```

## Notes
- One design system: edit `packages/ui` once and both the clinician and admin surfaces update.
- `GEMINI_MODEL=gemini-3.5-flash` (your working model) in `.env`.
- What's ported vs polished: the full admin lab is ported 1:1; the clinician side is reskinned
  with Home / New consult / Note review (two-pane + sign-off) / Consults. A per-consult detail
  page (`/consults/[id]`) and audio recording can be layered on next.
