# Notera Frontend (`apps/web`)

The Notera frontend is a **Next.js 15 (App Router) + React 19 + Tailwind** app inside the Turborepo monorepo. One codebase serves three surfaces, split by URL host and route group:

| Surface | Host | Route group | Purpose |
| --- | --- | --- | --- |
| Marketing site | `aitoolsfordoctor.com` | `app/(marketing)` | Public SEO landing pages |
| Clinician app | `app.aitoolsfordoctor.com` | `app/(app)` | The Notera scribe product (login-gated) |
| Testing lab | (dev only) | `app/(admin)` | Prompt/eval admin panel — not shipped to prod |

**Stack:** Next.js `^15.5`, React `^19`, Tailwind `^3.4`, TypeScript, shared design system `@notera/ui` (transpiled from source), `sonner` for toasts. Deployed to **Cloudflare Pages** via `@cloudflare/next-on-pages` (API routes run on the **edge** runtime).

---

## 1. How the frontend boots

Request → response, in order:

1. **`middleware.ts` (host split).** Runs first, on the homepage only (`matcher: ['/']`). If the host is the apex `aitoolsfordoctor.com`, it rewrites `/` → `/marketing` (the public site). `app.aitoolsfordoctor.com` falls through untouched to the clinician app. Deeper marketing pages resolve directly.

2. **`app/layout.tsx` (root layout).** Theme-neutral shell that owns global `<Metadata>` (SEO title/description/OpenGraph/robots, `metadataBase` from `NEXT_PUBLIC_SITE_URL`). It renders nothing visual itself — each route group owns its own look and `globals.css`.

3. **Route-group layout** takes over depending on which group matched:
   - `app/(marketing)/layout.tsx` → public site chrome + its own `globals.css` (has `@tailwind` directives).
   - `app/(app)/layout.tsx` → the clinician product: wraps children in `<AuthProvider>` and renders `<TopBar/>` + `<main>`. Imports `app/(app)/globals.css`.
   - `app/(admin)/layout.tsx` → the dev testing lab.

4. **`app/providers.tsx`** (`Providers`) — a client component providing `ThemeProvider` (light/dark), `TooltipProvider`, and the `<Toaster/>`. Used where the design system needs context.

5. The matched **`page.tsx`** renders. For the app, `app/(app)/app/page.tsx` renders the scribe behind the auth guard.

There is **no SPA bootstrap file** — Next.js App Router is the framework. "Initialization" = middleware → root layout → group layout → page, with client providers hydrating on the client.

---

## 2. The clinician app — `app/(app)`

### Layout & gating
- **`layout.tsx`** — `<AuthProvider>` (session context) → `<TopBar/>` (brand + nav + user menu) → `<main>{children}</main>`.
- **`components/AuthProvider.tsx`** — real email/password auth via the backend, exposed through a React context (`useAuth()` → `{ user, ready, login, logout }`). All calls go through the same-origin `/backend/api/auth/*` proxy so the session cookie stays **first-party** (no CORS):
  - `POST /backend/api/auth/login` → sets an HttpOnly session cookie, returns the user.
  - `GET  /backend/api/auth/me` → restores the session on page load (sets `ready` when resolved).
  - `POST /backend/api/auth/logout` → clears the cookie.
  - Sign-up / Google are intentionally disabled (accounts are created by an admin).
- **`components/Protected.tsx`** — client route guard. While `!ready` it shows a spinner; when `ready && !user` it redirects to `/login`; otherwise it renders its children.

### Pages (route → file)
| Route | File | What it is |
| --- | --- | --- |
| `/` (on `app.` host) | `(app)/page.tsx` → `Landing` | App landing / entry |
| `/app` | `(app)/app/page.tsx` | **The scribe workspace** — `<Protected><Scribe/></Protected>` |
| `/login` | `(app)/login/page.tsx` | `LoginForm` |
| `/consults` | `(app)/consults/page.tsx` | Legacy consults list (older flow) |

### Components (`app/(app)/components`)
- **`TopBar.tsx`** — top navigation bar (brand, nav links, user menu / logout). Styled from `(app)/globals.css`.
- **`Landing.tsx`** — the signed-in landing surface.
- **`LoginForm.tsx`** — email/password form; calls `useAuth().login`.
- **`NewConsult.tsx` / `NoteReview.tsx` / `PipelineLogsPanel.tsx` / `types.ts`** — the older React consult flow (intake → review → logs). Superseded by `Scribe.tsx` for the main workflow but still present.

---

## 3. The Scribe — `app/(app)/app/Scribe.tsx`

This is the heart of the product: a self-contained React/Tailwind clinical scribe that replaced the old vanilla-HTML iframe app. It renders a full-screen shell (`.notera-shell`, styled by `scribe.css`) with a dark sidebar, a rich top bar, a tab bar, and split panels.

**Layout regions**
- **Sidebar** — brand, "New session", nav (Scribe / Context / History), dark-mode toggle, user profile.
- **Top bar** — patient name/ID input, session status dot, date pill, **specialty selector (defaults to _Auto-detect_)**, theme toggle, **Create SOAP** button, **Start/Stop** recording, live timer, mic block with animated audio bars.
- **Tab bar** — Context · Transcript · Note · History (each toggles a `.main-panel`).
- **Panels**
  - **Context** — patient context form (age, sex, PMHx, current meds); prepended to the transcript at generation.
  - **Transcript** — live, time-mapped transcript while recording, or a paste-transcript card.
  - **Note** — the generated SOAP note (rounded card, editable), with Copy / Copy-to-EMR and a proper spinner loader.
  - **History** — the user's saved consults (open / download audio ⤓ / delete).

**Key behaviors**
- **Segmented recording.** Records in ~40s segments (`SEGMENT_MS`) plus a parallel full-session recorder for playable audio; each segment is transcribed as it completes so long visits don't fail or blow up cost.
- **ASR.** `POST ${API}/api/asr` with the audio blob → reads `d.text || d.transcript`.
- **Create SOAP.** `POST ${API}/api/consults` (with `clinicianId` from `/api/auth/me`); shows a 4-step loader; renders `d.renderedNote`.
- **Persistence.** After generation it saves to `POST /api/library/consults` and uploads audio to `/api/library/consults/:id/audio` (best-effort); History reads them back.
- **Safe JSON parsing.** Every backend call goes through `readJson()` which detects an HTML response (a proxy 404/timeout page) and surfaces a clear message instead of `Unexpected token '<'`.
- **Markdown rendering.** An inline `mdToHtml()` converts the note markdown to HTML (headings, bold, lists, numbered A&P headings kept on one bold line).

**API base.** `const API = '/backend'` — all calls use the same-origin `/backend/*` proxy (see §5).

---

## 4. Styling

Each route group is styled independently to avoid cross-contamination:
- **`(marketing)/globals.css`** and **`(app)/globals.css`** each own their look. The `(app)` globals define the white-theme design tokens (`--bg`, `--panel`, `.topbar`, `.card`, buttons, etc.) and pull in **Tailwind utilities** (`@tailwind components; @tailwind utilities;` — preflight is intentionally omitted so it doesn't reset the existing login/TopBar styles).
- **`(app)/app/scribe.css`** — the scribe's full stylesheet (ported from the original polished webapp: sidebar, top bar, tabs, panels, empty states) plus React-embedding rules: a `.notera-shell` wrapper that reproduces the old `<body>` flex layout and covers the legacy TopBar, and note-card styling (rounded box, 15px font, tightened section spacing). Loaded only on `/app`.
- **Tailwind** — `tailwind.config` scans `./app/**/*.{ts,tsx}`, `./src/**`, and `@notera/ui`.

---

## 5. Data flow & the `/backend` proxy

The browser never calls the backend origin directly. `next.config.js` rewrites:

```
/backend/:path*  →  ${BACKEND_URL}/:path*      (default http://localhost:8080)
```

In production `BACKEND_URL = https://api.aitoolsfordoctor.com`. Because the browser only ever talks to its own origin (`/backend/...`), the **session cookie stays first-party** and there is no CORS. Set `BACKEND_URL` in the Cloudflare Pages environment; locally it defaults to `localhost:8080`.

There is also a thin **BFF** under `app/api/consults/*` (`route.ts`, edge runtime, `backendFetch` from `app/lib/backend.ts`) used by the older consult flow. The Scribe itself talks to `/backend/*` directly.

---

## 6. Build & deploy

- **Local dev:** `npm run dev` (Turborepo runs `next dev -p 3000` for `@notera/web`). Needs `BACKEND_URL` pointing at a running backend (defaults to `localhost:8080`).
- **Production:** Cloudflare Pages builds with `@cloudflare/next-on-pages`. API routes declare `export const runtime = 'edge'` (required on Pages). Root `.npmrc` sets `legacy-peer-deps=true`; `next.config.js` sets `typescript.ignoreBuildErrors` and `eslint.ignoreDuringBuilds` so type-only mismatches in dev/admin charts don't block the build. Pushing to `main` triggers an automatic Cloudflare build.
- **Env vars:** `BACKEND_URL` (backend origin for the `/backend` proxy), `NEXT_PUBLIC_SITE_URL` (canonical marketing URL for metadata).

---

## 7. File-tree cheat sheet

```
apps/web/
├─ middleware.ts                 # host split (apex → /marketing)
├─ next.config.js                # /backend proxy rewrite, build flags
├─ app/
│  ├─ layout.tsx                 # root layout + global SEO metadata
│  ├─ providers.tsx              # ThemeProvider + Tooltip + Toaster
│  ├─ manifest.ts robots.ts sitemap.ts   # SEO/PWA
│  ├─ lib/backend.ts             # backendFetch helper (BFF)
│  ├─ api/consults/…             # edge BFF routes (older flow)
│  ├─ (marketing)/               # public SEO site + its globals.css
│  ├─ (admin)/                   # dev testing lab
│  └─ (app)/                     # the clinician product
│     ├─ layout.tsx              # AuthProvider + TopBar + <main>
│     ├─ globals.css             # app design tokens + Tailwind utilities
│     ├─ page.tsx                # Landing
│     ├─ login/page.tsx          # LoginForm
│     ├─ consults/page.tsx       # legacy consults list
│     ├─ app/
│     │  ├─ page.tsx             # <Protected><Scribe/></Protected>
│     │  ├─ Scribe.tsx           # THE scribe workspace
│     │  └─ scribe.css           # scribe shell + note-card styles
│     └─ components/
│        ├─ AuthProvider.tsx     # session context (/backend/api/auth/*)
│        ├─ Protected.tsx        # client route guard
│        ├─ TopBar.tsx           # top nav
│        ├─ Landing.tsx  LoginForm.tsx
│        └─ NewConsult.tsx  NoteReview.tsx  PipelineLogsPanel.tsx  types.ts
```
