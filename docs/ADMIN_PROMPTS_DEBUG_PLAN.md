# Admin Dashboard — Prompts, Debug & Judge Upgrade — Design Plan

_Status: DRAFT for approval · Author: Claude · Date: 2026-07-11_

## 1. What I found in your repo (scan results)

**The admin dashboard is small and self-contained:**
- `admin/server.mjs` (193 lines, zero-dependency Node http) — spawns eval runs, streams stdout over SSE, serves results + metrics from `eval/results/*`, single-password auth.
- `admin/public/index.html` (420 lines, CDN React/Tailwind/Chart.js/marked) — one SPA.
- Current tabs: **Overview · Run · Results · Metrics · Gates & Judge**.
- README states plainly: _"this harness has no LLM judge yet"_ — grading is deterministic (`eval/metrics.mjs`).

**Where the prompts actually live:**
- ~20 pipeline agents in `backend/src/pipeline/agents/*.js`. Pipeline order is fixed in `PipelineEngine.js`.
- **8 agents carry inline `systemInstruction` prompts** hard-coded as template literals (e.g. `ClinicalQAValidatorAgent`, `EncounterClassifierAgent`, `ClinicalObservationExtractorAgent`, `DiagnosisPreservationAgent`, `FactRecoveryAgent`, `HeidiCompressionAgent`, `NegationNormalizerAgent`, `TimelineBuilderAgent`, plus `ClinicalStoryLLMAgent`).
- **There is no central prompt registry today** — prompts are scattered in code, not versioned, not editable without a code change.

**Run/result data model:**
- `admin/data/runs.json` — run history. `eval/results/run_*/` — per-fixture `.md` (rendered note) + `.json` (score + note + flags). This is what the existing "Results → Diff vs" side-by-side already reads.

**Uploaded file:** `all_sessions_anon.json` = a list of 5 session objects, each with `transcript`, `soap_note`, `artifacts`, `audits`, timestamps. This is the data your Debug tab should load.

## 2. What you asked for (my read of it)

1. See the agents + pipeline prompts (QA and the rest) inside the dashboard, with the specific files/agents and their output shown.
2. A **side-by-side view** against a recent run — same idea as the existing rendered-`.md` diff, but for prompts and their outputs.
3. Make the prompts a **proper modular, editable section** and actually **store** edits.
4. A **new tab to edit prompts** with the side-by-side editor UI.
5. A **Debug tab** that (a) loads the JSON session file, and (b) exposes the **judge prompt with a modify option**.
6. A **Prompts tab** listing all prompts to view/edit, with a **dropdown per prompt to see its logs/output**.
7. Research first, design plan first — **your approval + my suggestions before any coding.**

## 3. Industry research (web + prompt-tooling practice)

Consistent themes across prompt-management and LLM-judge tooling (Latitude, PromptLayer, Braintrust, Langfuse, Arize, Promptfoo):

- **Prompts belong in a versioned store, not buried in code.** Edit in a dashboard, pull at runtime. Use semantic versioning; **once a version is published it is immutable** — new edits create a new version.
- **Side-by-side comparison + full version history** is the core UX. Non-technical editors change prompts without touching code.
- **Draft → review → publish gating (RBAC).** Editor creates/edits; changes need approval before they go live. Critical for a clinical product.
- **Label prompts like commit messages:** `{agent}-{purpose}-{version}`, with metadata + expected outcome per version.
- **LLM-as-judge** = the judge is itself an editable prompt. Best-practice structure is **RCAF** (Role, rubric as Context, scoring Actions, strict output Format), supporting pointwise scoring and pairwise "which is better" comparison.

Implication for us: build a small **prompt registry** + **draft/publish** flow rather than just letting people hand-edit code, and treat the judge as a first-class editable prompt.

Sources listed at the end.

## 4. Proposed design

### 4.1 Prompt registry (the "modular section")
- New folder `backend/prompts/` with one JSON per agent prompt: `{ id, agent, file, label, version, status: draft|published, systemInstruction, userTemplate, metadata, updatedAt }`, plus `backend/prompts/_versions/` for immutable history.
- **Non-breaking refactor:** each of the 8 inline-prompt agents gets a tiny `loadPrompt('<id>')` helper that reads the *published* registry entry and **falls back to the existing inline literal** if none exists. Nothing breaks if the registry is empty; the inline text becomes the seed v1.
- Server gains: `GET /api/prompts`, `GET /api/prompts/:id`, `GET /api/prompts/:id/versions`, `PUT /api/prompts/:id` (saves a **draft**), `POST /api/prompts/:id/publish`.

### 4.2 New "Prompts" tab (view + edit + side-by-side)
- Left: list of all agents/prompts grouped by pipeline stage, showing file path + status badge (draft/published).
- Right: **side-by-side editor** — current published text vs your edited draft, inline diff (reusing the existing Results diff pattern), Save Draft / Publish (with confirm), and a **version-history dropdown** to view/rollback.
- **Per-prompt "logs/output" dropdown:** expands to the recent runs that used this agent, linking to that agent's output for a fixture — the "agents output shown" piece.

### 4.3 New "Debug" tab
- **Session loader:** loads `all_sessions_anon.json` (copied into `admin/data/sessions/`), lists the 5 sessions, and shows `transcript` / `soap_note` / `artifacts` / `audits` in a readable, side-by-side layout (transcript vs generated note).
- **Editable Judge prompt:** an RCAF-structured judge prompt stored in the registry, editable here, with a "Run judge on this session/output" button that returns the judge's score + reasoning. This is the "judge prompt modify option."

### 4.4 Side-by-side against a recent run
- Extend the session/prompt views to pin a **recent run** next to the current output (same two-column diff the Results tab already uses), so you get the "did the change hold" view for prompts and sessions, not just rendered notes.

### 4.5 Tab layout after changes
`Overview · Run · Results · Metrics · Prompts (new) · Debug (new) · Gates & Judge`
(If you'd rather I fold Judge into Debug and keep the count down, I can.)

## 5. Suggestions I'm adding (beyond the literal ask)
- **Draft/publish gating on every prompt edit** — because this is clinical, live prompts should never change silently. Edits are drafts until explicitly published.
- **Immutable version history + one-click rollback** per prompt.
- **Seed-from-code:** auto-import the 8 existing inline prompts as v1 so nothing is lost and the registry is populated on day one.
- **A real LLM judge** wired into the eval (optional, Phase 4) so "Gates & Judge" stops being deterministic-only — with the rubric fully editable.
- **Read-only safe mode:** if `ADMIN_PROMPTS_READONLY=1`, the UI shows prompts but disables publish (safe for shared/demo use).

## 6. Build phases (after approval)
- **P1 — Registry + non-breaking agent wiring** (`backend/prompts/`, `loadPrompt` helper, seed v1 from inline). Verify: existing eval run produces identical output.
- **P2 — Server API** for prompts (list/get/versions/save-draft/publish).
- **P3 — Prompts tab UI** (list, side-by-side editor, version history, per-prompt log dropdown).
- **P4 — Debug tab** (session JSON loader + viewer + editable judge prompt + run-judge).
- **P5 — Optional LLM judge** in eval, side-by-side-vs-recent-run polish.
- **P6 — Verification:** unit test the registry loader/fallback, run the eval harness to confirm no regression, screenshot each new tab.

## 7. Decisions — LOCKED (your answers, 2026-07-11)
1. **Prompt wiring → Wire into pipeline.** Refactor the 8 inline-prompt agents to read from the versioned registry, seeded from current code, non-breaking fallback. Published edits change real pipeline behavior.
2. **Judge scope → Editable judge prompt only.** RCAF judge prompt in the Debug tab, editable + runnable against a session/output. Deterministic gates stay as-is (LLM-judge-in-eval deferred).
3. **Debug data → Folder of session files.** Copy the uploaded JSON into `admin/data/sessions/`; load any session files dropped there over time.
4. **Edit safety → Draft → publish gating.** Edits save as drafts; a separate Publish step (confirm) makes them live, with immutable version history.
