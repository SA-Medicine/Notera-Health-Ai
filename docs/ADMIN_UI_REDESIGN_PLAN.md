# Notera Admin Dashboard — Full UI Redesign Plan

_Status: PLAN for approval · Surface: admin/testing dashboard · Target stack: React + TypeScript + Tailwind + shadcn/ui + Radix + Framer Motion · Date: 2026-07-16_

Goal: take the internal "Auto‑Tester" console from a functional-but-terminal-looking single-file app to a **modern enterprise SaaS product** (OpenAI / Linear / Stripe / Vercel calibre) — without breaking any of its logic or the `admin/server.mjs` APIs.

---

## STEP 1 — Understand the product

**What it is.** An internal console for the clinical‑note pipeline's regression harness. Not a clinician tool — it's used by **you + the pipeline/QA engineers**.

**Daily workflow.** Trigger eval runs over patient fixtures → watch live logs → inspect generated vs gold notes side‑by‑side → diff runs → track quality metrics over time → edit/version the agent prompts → tune the QA judge. Fast iteration on prompt + pipeline quality is the whole point.

**Primary goals:** (1) run the harness and see pass/fail fast; (2) understand *why* a fixture failed; (3) safely change a prompt and confirm the fix held; (4) watch metrics trend across runs.

**Biggest frustrations today:** terminal aesthetic makes scanning slow; no loading/empty/error affordances; dense hand-rolled tables; feedback is ad‑hoc inline text; in‑browser Babel + Tailwind Play CDN make it sluggish; not usable on anything but a wide desktop.

**Cognitive load hotspots:** Results (three-pane + diff + run/fixture selectors), Metrics (table + chart + compare + navigation), Prompts (graph + editor + history + logs + runtime config).

---

## STEP 2 — Complete UI audit (current `admin/public/index.html`)

The current app is one ~640‑line file: **CDN React 18 + Babel‑standalone (transpiled in the browser) + Tailwind Play CDN + Chart.js + markdown‑it**. Dark‑only. Custom `ink`/`phos` palette. Six tabs behind a password gate.

| # | Area | Issue | Why it's bad / user impact | Severity |
|---|------|-------|-----------------------------|----------|
| 1 | Build/perf | Babel‑in‑browser + Tailwind Play CDN | Every load re‑transpiles the whole app; no tree‑shaking, no code‑split, slow first paint, Tailwind warns "not for production". | **Critical** |
| 2 | Typography | One mono‑ish scale, weak hierarchy | Everything reads at the same weight → poor scanability, "script" feel not "product". | High |
| 3 | Color/contrast | `slate-500`/`slate-600` on dark ink | Several text tokens fail WCAG AA (~3:1); hard to read secondary text. | High |
| 4 | Feedback | Inline `flash` strings, no toasts | Actions (save/publish/delete) give inconsistent, easily‑missed feedback. | High |
| 5 | Loading states | Blank panes while fetching | No skeletons/spinners → looks broken on slow calls. | High |
| 6 | Empty states | One‑line "No output yet" | No guidance/CTA; low discoverability for first‑run users. | Medium |
| 7 | Tables | Hand‑rolled Metrics table | No real sort/keyboard/virtualization, dense, inconsistent. | High |
| 8 | Components | Ad‑hoc button/badge/input class combos | Inconsistent padding, radius, hover/focus → visual noise. | High |
| 9 | Navigation | Sidebar + `⌘K→Run` only | No command palette, no breadcrumbs, low keyboard discoverability. | Medium |
| 10 | Accessibility | Default focus, no ARIA roles on custom tabs/nodes | Fails keyboard + screen‑reader expectations; focus barely visible. | High |
| 11 | Responsiveness | Fixed `h-[calc(100vh-56px)]`, fixed widths, horizontal‑scroll graph | Unusable on tablet/mobile; panes clip. | Medium |
| 12 | Motion | Single `.fade`; abrupt tab/panel changes | No perceived‑performance polish; jarring. | Low |
| 13 | Architecture | 640‑line component soup, zero reuse | Hard to maintain/extend; every screen re‑implements primitives. | High |
| 14 | Dark‑only | No light mode / density | No user preference; long sessions cause fatigue for some. | Low |

---

## STEP 3 — Research (what the target should emulate)

Confirmed current best practice (2026): **shadcn/ui on Radix + Tailwind, with design tokens defined once (OKLCH) and consumed everywhere**; components owned in‑repo split into `ui/` (raw shadcn), `primitives/` (lightly tweaked), `blocks/` (product compositions); accessible data tables (sort/filter), responsive sidebar with mobile drawer, dark/light + density toggles, WCAG AA. Interaction language from **Linear** (speed, keyboard, command palette), **Stripe** (data density done calmly), **Vercel** (restraint, mono‑for‑data‑only), **Notion/Arc** (soft surfaces, motion), **Raycast** (command palette). Sources at the end.

---

## STEP 6 — The design system (build this first)

**Tokens (semantic, OKLCH, light + dark):**
- Surfaces: `--background`, `--surface`, `--surface-raised`, `--overlay`; **borders** `--border`, `--border-strong`.
- Text: `--fg`, `--fg-muted`, `--fg-subtle` (all AA‑verified on their surfaces).
- Brand/semantic: `--primary` (keep the phosphor‑green as the accent, softened), `--success`, `--warning`, `--danger`, `--info`, each with `-fg` and `-subtle` variants.
- Data‑viz palette: 8 categorical hues tuned for dark+light and color‑blind safety (used by charts + metric lines).

**Scale system (8pt):** spacing `0,1,2,3,4,6,8,12,16,24…`; **radius** `sm 6 / md 8 / lg 12 / xl 16 / full`; **elevation** 3 soft shadows (no heavy drop shadows); **type** Inter/Geist UI + a mono (JetBrains/Geist Mono) reserved **only** for logs/code/IDs — scale `xs 12 / sm 13 / base 14 / md 16 / lg 18 / xl 20 / 2xl 24 / 3xl 30`, line‑heights 1.4–1.5.

**Motion:** durations 120/180/240ms, `ease‑out` for enters, `ease‑in‑out` for moves; respect `prefers‑reduced‑motion`. **Density:** `comfortable` (default) and `compact` toggle. **Theme:** light + dark, system‑aware.

**Delivery:** Tailwind theme mapped to the tokens; `next-themes`‑style provider; a small `<ThemeMenu/>` (light/dark/system + density).

---

## STEP 10 — Target architecture & migration (no logic changes)

Move the frontend to a real build while **keeping `admin/server.mjs` and every API untouched** (`/api/runs`, SSE `/stream`, `/api/results/*`, `/api/metrics/*`, `/api/prompts/*`, `/api/sessions`, `/api/judge/run`).

- **Tooling:** Vite + React 18 + TypeScript + Tailwind. (Vite over Next — this is a client SPA talking to an existing Node API; no SSR needed.)
- **UI:** shadcn/ui + Radix primitives; **Framer Motion** for transitions; **Lucide** icons; **cmdk** command palette; **sonner** toasts; **TanStack Query** for polling/fetch + cache; **TanStack Table** for the metrics/results tables; **TanStack Virtual** for long log/diff panes; **Recharts** (or keep Chart.js) for the trend chart; **react‑hook‑form + zod** for the (few) forms.
- **Structure:** `admin/ui/` app → `src/components/ui/*` (shadcn), `src/components/primitives/*`, `src/blocks/*` (Sidebar, TopBar, RunConsole, ResultsDiff, MetricsBoard, PromptGraph, PromptEditor…), `src/lib/api.ts` (typed fetchers + SSE hook), `src/hooks/*`, `src/styles/tokens.css`.
- **Build → serve:** Vite builds to `admin/public/` (or `admin/ui/dist`); `server.mjs` serves the built `index.html` + assets exactly as today. Dev: Vite dev server proxying `/api` to `:4300`.
- **Auth:** same password/cookie flow, re‑skinned as a centered card with the product mark.

---

## STEP 4 + 12 — Per‑screen redesign

### Global shell (Sidebar + TopBar + Command palette) — **Critical**
- **Now:** fixed collapsible sidebar, thin topbar, `⌘K→Run`.
- **New:** Radix collapsible **sidebar** with sections + icons + active indicator + mobile **drawer**; **TopBar** with breadcrumb, run‑status pill, theme/density menu, and a **`⌘K` command palette** (cmdk) exposing every action (run a fixture, open a result, jump to a prompt, toggle theme). Keyboard‑first, focus‑visible rings, skip‑to‑content link.
- **A11y:** `nav`/`main` landmarks, roving‑tabindex nav, ARIA‑current. **Perf:** route‑level code‑split. **Impact:** faster navigation, discoverability jumps. 

### Overview — **High**
- **Now:** 4 KPI cards + 2 link cards + a text line.
- **New:** KPI cards with sparkline + delta chip + trend color; a "latest run" summary block (pass/fail donut, release‑blocker chips); recent activity feed; quick‑action row. Skeletons on load; empty state with "Run your first eval" CTA.

### Run — **High**
- **Now:** mode buttons, select, live log pane, recent‑runs strip.
- **New:** left "configure run" panel (fixture multiselect w/ search, presets, range), primary **Run** button with progress; **live log** in a virtualized mono console with level colors, filter, autoscroll‑lock, copy/download; run finishes → inline toast + "View results →". Recent runs as status‑badged cards. Streaming state uses a subtle animated indicator.

### Results — **Critical** (highest cognitive load)
- **Now:** run/fixture tree + 2‑pane Notera|Heidi markdown + basic diff.
- **New:** three‑zone layout — compact **run+fixture switcher** (searchable, PASS/FAIL badges, ★ blockers), **content** with a segmented control (Rendered / Raw / Diff), and an optional **inspector** (scores, flags, per‑agent output). Side‑by‑side panes become resizable; diff gets word‑level highlighting + "next change" jumps. Sticky headers, keyboard `j/k` between fixtures. Skeleton + empty + error states throughout.

### Metrics — **High**
- **Now:** Chart.js trend + hand‑rolled sortable table + compare + delete/open.
- **New:** KPI header + **trend chart** (primary metrics on left axis, dynamic `qa_*` metrics on a right axis, legend toggles, hover tooltips, brush to zoom); **TanStack Table** run list (real sort, sticky header, row expand → per‑fixture breakdown, row actions in a `⋯` menu: Open in Results / Delete with confirm dialog); a **Compare** drawer (two runs → metric deltas + fixture flips). Delete uses a Radix AlertDialog, not `window.confirm`.

### Prompts — **High**
- **Now:** pipeline graph + single editor + History/Logs/Schema panels + runtime config row.
- **New:** keep the **pipeline graph** but render it as a clean node‑flow (active vs inactive, draft dots, version chips) with a proper connector style; selecting a node opens a **two‑column workspace** — left = metadata + runtime config (Freeform switch, max‑tokens, schema editor in a collapsible) + version **History** (with rollback) + **Logs**; right = a real code editor (CodeMirror/Monaco) with mono font, line numbers, and a diff‑vs‑published toggle. Save/Publish become buttons with toasts + an unsaved‑changes guard. Draft→publish stays gated.

### Gates & Judge — **Medium**
- **Now:** deterministic gate list + threshold number inputs.
- **New:** cards per gate with severity badges + inline help; threshold editor as labeled sliders/steppers with live preview swatches; the judge rubric as a documented, editable block. Clear "deterministic vs LLM" separation.

---

## STEP 7 — Component library (shadcn mapping)
Buttons, Inputs, Select/Combobox, Command palette (cmdk), Dialog/AlertDialog, Sheet (mobile nav), Tabs/SegmentedControl, Table (TanStack), Badge, Tooltip, Popover, DropdownMenu, Toast (sonner), Skeleton, Progress, Switch, Slider, Resizable panels, ScrollArea, Breadcrumb, Avatar/Mark. Each themed from the tokens; **one** source of truth per primitive (no more ad‑hoc class combos).

## STEP 9 — Accessibility (WCAG AA)
AA contrast on every token pairing; visible focus rings everywhere; full keyboard paths (nav, tabs, tables, dialogs, palette); ARIA roles/labels via Radix; `prefers‑reduced‑motion`; ≥44px touch targets; color‑blind‑safe chart palette; semantic landmarks; screen‑reader labels on icon‑only buttons.

## STEP 11 — Performance
Vite build (tree‑shake + code‑split per route); virtualize logs/diff/long tables; memoize chart datasets; lazy‑load Monaco/Recharts; TanStack Query caching for polled endpoints; SSE via a single shared hook; skeletons for perceived speed; images/icons as SVG sprites.

---

## Implementation roadmap (phased, priority‑ordered)

- **P1 · Critical — Foundation:** scaffold Vite+TS+Tailwind+shadcn in `admin/ui/`, wire the token system (light/dark/density), typed `api.ts` + SSE hook, build→serve through `server.mjs`. *(No screen looks final yet; the platform exists.)*
- **P2 · Critical — Shell:** Sidebar + TopBar + Command palette + Toaster + theme menu + auth screen.
- **P3 · Critical — Results:** the highest‑load screen (switcher + segmented Rendered/Raw/Diff + inspector + resizable panes).
- **P4 · High — Run + Overview:** run console (virtualized live logs) + overview KPIs/skeletons/empty states.
- **P5 · High — Metrics:** TanStack table + chart upgrade + compare drawer + AlertDialog delete.
- **P6 · High — Prompts:** node‑flow graph + Monaco editor workspace + history/logs/schema/runtime config.
- **P7 · Medium — Gates & Judge + polish:** gates cards, threshold sliders, motion pass, empty/error states everywhere.
- **P8 · Med/Low — QA pass:** a11y audit (axe), keyboard sweep, responsive/tablet, reduced‑motion, contrast check, Lighthouse.

Each phase keeps the existing APIs and logic intact and ships behind the same `admin` route, so we can cut over screen‑by‑screen.

## Open decisions before implementation
1. **Vite SPA** (my recommendation) vs fold the admin into the existing `web/` Next.js app?
2. **Code editor:** Monaco (full IDE, heavier) vs CodeMirror 6 (lighter) for the prompt editor?
3. **Chart lib:** keep Chart.js vs move to Recharts (nicer with shadcn theming)?
4. **Light mode:** ship it, or dark‑only for v1?
5. Do you want me to **start building P1+P2** now, or refine this plan first?

## Sources
- [shadcn/ui best practices 2026](https://medium.com/write-a-catalyst/shadcn-ui-best-practices-for-2026-444efd204f44)
- [Build a modern admin dashboard with shadcn/ui (2026)](https://dev.to/ausrobdev/how-to-build-a-modern-admin-dashboard-with-shadcnui-in-2026-3477)
- [Next.js 16 admin dashboards with shadcn/ui](https://adminlte.io/blog/nextjs-admin-dashboards-shadcn/)
- Radix Primitives · Tailwind CSS · Apple HIG · Material 3 · Laws of UX · Nielsen Norman Group (patterns referenced throughout)
