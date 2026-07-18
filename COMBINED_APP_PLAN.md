# Notera — Combined App Upgrade Plan

Merge the clinician frontend and the admin/testing frontend into **one Next.js app**, fold
both backends into **one Express service**, share **one shadcn design system**, and start it
all with **one command** — scaffolded fresh as a **Turborepo monorepo**.

Your decisions:
- **Frontend:** one Next.js 14 app; `(app)` route group = clinician product, `(admin)` route group = testing lab; shared design system.
- **Backend:** one Express service serving product + admin/lab APIs (pipeline, SSE, eval runs, lab DB).
- **Structure:** fresh Turborepo scaffold; migrate existing code in.
- **Clinician UI:** reskin to the admin's shadcn look **and** UX upgrades.

Grounded in current best practice: shadcn's official monorepo mode (a `packages/ui` that owns
Tailwind, tokens, and primitives; apps only consume it) and Next.js route groups (organize
`(app)` vs `(admin)` with separate layouts, no URL impact). See Sources.

---

## 1. Target architecture

```
notera/                          # fresh Turborepo root
  apps/
    web/                         # THE unified Next.js 14 app (browser for everything)
      app/
        (app)/                   # clinician product
          page.tsx               #   / landing
          login/                 #   /login
          new/                   #   /new  (record → draft)
          consults/              #   /consults, /consults/[id]
          layout.tsx             #   product chrome (TopBar)
        (admin)/
          admin/                 #   /admin, /admin/run, /admin/patients,
          layout.tsx             #     /admin/results, /admin/metrics,
                                 #     /admin/prompts, /admin/judge  (sidebar chrome)
        api/                     # thin BFF: server-only proxy to Express (keeps PHI boundary)
        layout.tsx               # root: ThemeProvider, fonts, imports @notera/ui globals
      next.config.js             # rewrites /backend/* → Express; transpile @notera/ui
  packages/
    ui/                          # @notera/ui — shared shadcn design system
      src/{styles,components/ui,components/blocks,lib}   # seeded from the admin/ui I built
      tailwind-preset.ts, components.json
    backend/                     # @notera/backend — ONE Express service
      src/  (pipeline, orchestrator, db, deid, ner, services)  + routes/
      server.js                  # mounts product + admin/lab routers
    schema/                      # @notera/schema (existing JSON schema, unchanged)
    config/                      # shared tsconfig / eslint / tailwind base
  db/                            # postgres: schema.lab.sql, reset.mjs, backfill (unchanged)
  data/  eval/  ner/             # kept as-is (eval becomes a workspace that imports @notera/backend)
  turbo.json  package.json  .env
```

Two processes behind one origin: the **Next app (:3000)** serves every browser route and
`rewrites` `/backend/*` to the **Express backend (:8080)**. One `dev` command starts both (plus
Postgres). This preserves the clinician **server-only PHI boundary** (product calls go through
Next server components / BFF; the backend stays private) while the admin lab talks to the same
backend through the same origin.

---

## 2. `packages/ui` — the shared design system

The admin makeover already contains the whole system; it becomes the shared package, so both
route groups render identically.

- Move `admin/ui/src/{styles/globals.css, components/ui/*, components/blocks/*, lib/utils.ts, lib/md.ts}` → `packages/ui/src`.
- UI package **owns** Tailwind (preset + tokens), PostCSS, global styles, and primitives (Button, Card, Badge, Input, Tabs, Dialog, Tooltip, Skeleton) + blocks (Sidebar, TopBar, CommandPalette, ThemeProvider, Login). Apps import via `@notera/ui/components/...` and consume the preset — no duplicated tailwind config.
- Add clinician-specific primitives the reskin needs: `Select`, `Textarea` (exists), `Toast` (sonner), `Table`, `StatusPill`, `SegmentedControl`, `FileDrop`.
- `components.json` aliases route new `shadcn add` output into `packages/ui`.

---

## 3. Unified Next.js app (`apps/web`)

- **Root layout** loads `@notera/ui` globals + `ThemeProvider` (dark/light) + `Toaster`, sets fonts.
- **Route groups & layouts:** `(app)` uses a top-bar product chrome; `(admin)` uses the sidebar + command palette from the design system. Route groups keep URLs clean and give each surface its own layout.
- **Auth:** clinician auth (existing `AuthProvider`) gates `(app)`; a separate admin password/session gates `(admin)` via middleware. One sign-in surface per group, shared `Login` block styling.
- **PHI boundary:** product data flows through Next **server components / route handlers** using the existing `server-only` `backend.ts` pattern — the browser never holds the service token or raw PHI. Admin/lab calls (no PHI) go to `/backend/api/lab/*` etc.
- **Admin port:** the Vite screens I built (`overview, run, patients, results, metrics, prompts, judge`) move into `(admin)/admin/*` as client components. Tab state becomes real routes; the SSE `useRunStream` hook and typed `api` client port as-is (fetch paths unchanged). `nav.ts` maps to `<Link>` routes.

---

## 4. Combined Express backend (`packages/backend`)

One service mounts two routers; nothing is lost.

| Source | Routes | Lands as |
|--------|--------|----------|
| `backend/server.js` | `/healthz`, `/api/consults*` (create, get, list, approve) | `routes/product.js` |
| `admin/server.mjs` | auth/session, `/api/runs*` (+SSE spawn), `/api/results*` (+compare), `/api/prompts*`, `/api/patients*`, `/api/lab/*`, rerun | `routes/admin.js` |

- The admin server's static-file serving is **dropped** (Next serves all UI now).
- `.env` loader, run-spawning (`child_process`), SSE log streaming, prompt registry, lab DB access (`labStore`), and the LLM comparison/judge endpoints all move in unchanged.
- Product APIs stay under `/api/*`; admin/lab APIs keep their existing paths and get an **admin-session gate** (already present) so the two audiences are cleanly separated on one service.
- `eval/run_eval.mjs` stays a workspace that imports `@notera/backend` and is spawned by the admin router exactly as today; its lab-DB mirroring (Phase 3) is unchanged.

---

## 5. Clinician reskin + UX upgrades

Every existing screen rebuilt on `@notera/ui`, plus flow improvements:

- **Landing / Login** → shadcn hero + `Login` block, dark mode, brand tokens.
- **New consult** (`NewConsult`) → stepped flow (specialty/type → record/paste transcript → generate) with a `FileDrop`, live progress from pipeline SSE, and skeleton loading.
- **Note review** (`NoteReview`, the core screen) → two-pane review: rendered Heidi note + editable schema sections, flag chips, section-level accept/edit, a diff-on-save, and a clear **Sign-off** action with confirm. Reuses the admin's markdown + diff libs.
- **Consults list** → real `Table` with status pills, search/filter, empty/loading states, and row → `/consults/[id]`.
- **Cross-cutting:** command palette (quick "new consult", jump to a consult), toasts, consistent status/empty states, responsive layout, keyboard shortcuts.

---

## 6. One-command start, build, deploy

- **Dev:** root `npm run dev` (Turborepo) → `db:up` + Express (`:8080`) + Next (`:3000`, rewrites `/backend/*`). Open `http://localhost:3000` (product) and `/admin` (lab).
- **Build:** `turbo build` orders `@notera/ui` → `@notera/backend` → `apps/web`.
- **Prod:** Next app + Express backend as two services behind one origin (Next `rewrites`), or containerized together in `deploy/`. Postgres via the existing `db/` compose.
- **Turbo pipeline** caches builds; `packages/ui` changes rebuild both consumers.

---

## 7. Phasing (each step verified, nothing breaks mid-flight)

1. **Scaffold** the Turborepo (`apps/`, `packages/`, `turbo.json`, workspaces, shared config).
2. **Extract `@notera/ui`** from the admin makeover; wire the Tailwind preset + tokens; smoke-build.
3. **Combine backend** into `packages/backend` (product + admin routers); `node --check` + hit `/healthz` and a lab route.
4. **Move the Next app** in; mount the `(admin)` route group by porting the Vite screens; verify SSE + lab dashboard.
5. **Clinician reskin + UX** on `@notera/ui`, screen by screen, behind the existing auth.
6. **One-command dev/build**, then **verification**: type-check, `next build`, backend `node --check`, `db:test`, and a click-through of both surfaces.

Phases 1–4 are mechanical (no behavior change); 5 is the visible makeover. The current apps keep
working until each surface is switched over.

---

## 8. Risks & mitigations

- **Admin port effort (Vite→Next):** screens are plain React; main change is routing + `'use client'`. The design system moves verbatim, so most code is reused.
- **PHI boundary regressions:** keep product calls server-only through the Next BFF; admin/lab (no PHI) may call the backend directly. Verified in phase 6.
- **Route/name collisions:** product `/api/*` vs admin/lab paths already differ; route groups avoid URL clashes (note: navigating **between** groups triggers a full reload — expected).
- **Big-bang risk:** phased switch-over with both old apps runnable until parity is reached.

---

## Sources
- [Monorepo — shadcn/ui](https://ui.shadcn.com/docs/monorepo)
- [Next.js — shadcn/ui installation](https://ui.shadcn.com/docs/installation/next)
- [Sharing shadcn/ui between Vite and Next.js in Turborepo](https://github.com/evgenius1424/turborepo-vite-shadcn-ui)
- [Route Groups — Next.js file conventions](https://nextjs.org/docs/app/api-reference/file-conventions/route-groups)
- [Next.js 16: Monorepo UI Sharing Guide](https://ngandu.hashnode.dev/monorepo-nextjs-shadcnui-bun)
