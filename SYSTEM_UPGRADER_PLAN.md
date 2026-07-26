# Feature Plan — System Upgrader Agent

An eval-driven, human-in-the-loop **prompt optimizer** for the Testing Lab. It reads the
evidence your runs already produce (per-agent I/O, comparison scores, current prompts),
reasons about *why* Notera notes diverge from gold, and proposes **targeted prompt edits**
(only the changed sections) plus **system-level improvement suggestions** — which you
review, diff, and publish through the existing prompt-versioning flow.

Status: **plan for approval** (no code changes yet).
Grounded in: `SYSTEM_ARCHITECTURE.md`, the `lab` schema, and the existing prompt registry.

---

## 1. What it is (and the science it's based on)

This is not a novel idea — it's a known family of techniques, which is good: it means the
design has proven guardrails. The relevant methods:

- **OPRO ("LLMs as Optimizers")** — the optimizer LLM is shown *previous prompt candidates
  together with their scores* and asked to propose a better one. Score-conditioning is what
  makes it converge instead of wander.
- **APO / ProTeGi ("textual gradients")** — instead of a numeric gradient, you feed the LLM
  *concrete failing examples* and ask it to describe, in words, what's wrong ("the gradient")
  and then edit the prompt in that direction.
- **Contrastive Reflection** — the crucial safety idea: **failures decide *where* to edit;
  successes decide *what must be preserved*.** An optimizer that only sees failures will
  happily break the cases you already pass. So we always feed both.
- **Production/eval-driven, not guesswork** — optimize against the failure modes that
  *actually occurred* in your runs, captured in `agent_runs` + `metrics` + the comparison
  JSON, rather than imagined ones.

Our variant, stated precisely:

> For a chosen agent, gather (a) its current prompt, (b) a **contrastive sample** of its
> real inputs/outputs from the latest run — the worst-scoring records *and* some
> best-scoring records — and (c) the structured note-vs-gold comparison for those records.
> Feed all of it to an optimizer LLM under a fixed meta-prompt. It returns targeted edits
> to that agent's prompt plus system-level observations. A human reviews the highlighted
> diff and publishes.

It reuses **the same LLM/agent structure as the rest of the codebase** (`LLMService` +
the prompt registry), exactly as you asked — the optimizer is just another agent with its
own versioned prompt (`system-upgrader`).

**Sources:** [LLMs as Optimizers (OPRO)](https://arxiv.org/pdf/2309.03409) ·
[TextGrad](https://arxiv.org/pdf/2406.07496) ·
[Contrastive Reflection for Iterative Prompt Optimization](https://arxiv.org/pdf/2606.30840) ·
[Meta-Prompt optimizer (Future AGI)](https://docs.futureagi.com/docs/optimization/optimizers/meta-prompt/) ·
[LangChain — Exploring Prompt Optimization](https://www.langchain.com/blog/exploring-prompt-optimization).

---

## 2. Why the data you already store is exactly the right input

Nothing new needs to be captured to *start* — the lab already records everything the
optimizer needs:

| Optimizer input | Where it already lives |
|---|---|
| Each agent's exact prompt + input + output, per record | `lab.agent_runs` (`system_prompt`, `input`, `output_raw`, `output_parsed`) |
| Per-record quality signal | `lab.metrics` (`section_coverage`, `similarity_to_gold`, `omission_rate`, `qa_*`, …) |
| Rich note-vs-gold analysis | the comparison JSON (`<fixture>.compare.json` → `overall_score`, `verdict`, `dimensions[]`, `notera_missing[]`, `notera_extra[]`, `key_differences[]`, `summary`) |
| Current prompts + version history | `packages/backend/prompts/store/` via the registry |
| Run stdout/stderr | `admin/data/logs/` + `lab.run_logs` |

The one *workflow* addition you asked for — **auto-run the comparison for all patients
after a run completes** — is what turns the comparison from an on-demand click into a
standing corpus the optimizer can rely on (§5.2).

---

## 3. Where it plugs into the architecture

```
Metrics/Run data ─┐
Comparison JSON ──┤→  buildUpgradeContext(runId, agentId)   ← assembles the evidence
Current prompts ──┘            │
                               ▼
                     system-upgrader agent  (LLMService + 'system-upgrader' prompt)
                               │  structured JSON out
                               ▼
        ┌──────────────────────────────────────────────┐
        │ prompt_patches[]  (per agent, only changed    │
        │                    sections + full rewrite)   │
        │ system_suggestions[]  (structural / non-prompt)│
        └──────────────────────────────────────────────┘
                               │
                     persist → lab.upgrade_runs / lab.prompt_suggestions / lab.system_suggestions
                               │
                               ▼
             Frontend review → highlighted diff → **Publish** (existing versioning)
                               │
                               ▼
             Verify → "Rerun on latest" (existing) → did the metric move?
```

The optimizer never edits a prompt directly. It writes **suggestions**; publishing is a
separate, human, auditable step that goes through the registry's existing
`savePromptDraft → publish → v<N>.json` path. This is the single most important design
constraint (§9).

---

## 4. Database additions

Three new tables in the `lab` schema (applied via a small idempotent migration so we don't
`db:reset` and lose data). Nothing existing changes.

```sql
-- one optimizer invocation
CREATE TABLE lab.upgrade_runs (
  id            serial PRIMARY KEY,
  source_run_id integer REFERENCES lab.runs(id) ON DELETE SET NULL,  -- the run analysed
  scope         text NOT NULL,              -- 'agent' | 'system'  (one agent, or all)
  agent_id      text,                        -- null when scope='system'
  model         text,
  status        text NOT NULL DEFAULT 'running',  -- running | done | error
  input_summary jsonb,                       -- what was fed in (counts, record ids, metrics)
  raw_output    text,                        -- the optimizer's raw response (audit)
  summary       text,                        -- its narrative rationale
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

-- one proposed prompt edit (may be several per upgrade_run)
CREATE TABLE lab.prompt_suggestions (
  id            serial PRIMARY KEY,
  upgrade_run_id integer NOT NULL REFERENCES lab.upgrade_runs(id) ON DELETE CASCADE,
  agent_id      text NOT NULL,
  base_version  integer,                     -- the prompt version it edits
  rationale     text,                        -- why (the "textual gradient")
  patches       jsonb,                       -- [{ anchor, before, after, reason }]  targeted edits
  full_prompt   text,                        -- full rewritten prompt (fallback / preview)
  confidence    numeric,                     -- optimizer's self-rated 0..1
  status        text NOT NULL DEFAULT 'proposed',  -- proposed | published | dismissed
  published_version integer,                 -- set when a human publishes it
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- one system-level (non-prompt) improvement idea
CREATE TABLE lab.system_suggestions (
  id            serial PRIMARY KEY,
  upgrade_run_id integer NOT NULL REFERENCES lab.upgrade_runs(id) ON DELETE CASCADE,
  category      text,                         -- 'pipeline' | 'metric' | 'guardrail' | 'data' | 'other'
  title         text NOT NULL,
  detail        text NOT NULL,
  severity      text,                         -- info | low | high
  status        text NOT NULL DEFAULT 'open', -- open | accepted | dismissed
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

Why patches as JSON `[{anchor, before, after, reason}]`: it lets the UI **highlight only
the changed sections** (your stated preference) and lets a human accept edits individually,
while `full_prompt` guarantees we can always fall back to a clean preview/publish even if a
patch doesn't apply cleanly.

---

## 5. Backend

### 5.1 The optimizer prompt (`system-upgrader`)
A new entry in the prompt registry, so it's itself versioned and editable in the Prompts
tab — the optimizer improves the system; you can improve the optimizer. Its meta-prompt
defines: the domain (clinical SOAP notes), the pipeline's philosophy (grounding +
guardrails, slot-filling not free writing), the scoring metrics and what "good" means, the
**contrastive** instruction (preserve what passes, fix what fails), and a **strict JSON
output contract** (§6). It is explicitly told: *edit surgically; prefer minimal targeted
changes; never remove safety/grounding instructions.*

### 5.2 Auto-comparison after a run
When a run finishes, enqueue the comparison agent for every record that doesn't already
have a cached `compare.json`. Implementation: a `POST /api/lab/runs/:id/autocompare`
the Run screen calls on completion (bounded concurrency, best-effort), reusing the existing
`/api/results/compare` engine. Results are cached exactly as today. The Upgrader screen
shows live progress of this as the "safety check" you described.

### 5.3 Context builder — `buildUpgradeContext(runId, agentId, opts)`
1. Pull the agent's `agent_runs` for the run, join `metrics` per record.
2. Rank records by a composite score; take the **bottom K (failures)** and **top M
   (anchors)** — contrastive sampling.
3. Attach each selected record's comparison JSON (missing/extra/key-differences).
4. Attach the current published prompt (+ its version) and, optionally, the last 1–2
   version diffs so the optimizer sees what's already been tried (OPRO-style history).
5. Token-budget it: truncate long transcripts, keep the structured deltas verbatim (they're
   the signal), summarise the rest.

### 5.4 The endpoints
```
POST /api/lab/upgrade            { runId, scope:'agent'|'system', agentId?, promptOverride? }
     → builds context, calls the optimizer, persists upgrade_run + suggestions, returns them
GET  /api/lab/upgrade/:id        one upgrade run + its suggestions
GET  /api/lab/upgrades           history
POST /api/lab/upgrade/preview    { runId, agentId }  → returns the assembled context only
                                   (the "what's going in" screen, no LLM spend)
POST /api/lab/suggestions/:id/publish   { }         → publishes a prompt_suggestion via the
                                   existing registry publish path; records published_version
POST /api/lab/suggestions/:id/dismiss
POST /api/lab/system-suggestions/:id/status  { status }
```

---

## 6. The optimizer's output contract

Strict JSON, parsed with the existing tolerant parser:

```json
{
  "summary": "one-paragraph rationale for the whole upgrade",
  "prompt_patches": [
    {
      "agent_id": "qa-validator",
      "base_version": 13,
      "confidence": 0.72,
      "rationale": "Notes repeatedly list conditions the transcript negates (e.g. 'no sleep apnea' rendered as PMH). Add an explicit negation-preservation rule.",
      "patches": [
        { "anchor": "## Rules", "before": "3. Include all mentioned conditions.",
          "after": "3. Include all mentioned conditions. NEVER assert a condition the transcript explicitly negates; render negations as negatives.",
          "reason": "fixes false-positive PMH (Patient2: sleep apnea)" }
      ],
      "full_prompt": "…the complete rewritten prompt…"
    }
  ],
  "system_suggestions": [
    { "category": "guardrail", "severity": "high",
      "title": "Add a negation cross-check guardrail",
      "detail": "medGrounding catches unsupported meds but nothing catches negated-condition-as-PMH. Add a check comparing PMH entries against transcript negations." }
  ]
}
```

`prompt_patches[].patches[]` drive the highlighted diff; `full_prompt` is the safety net.

---

## 7. Frontend — the new tab and its dynamic states

New sidebar entry **"Upgrader"** (`nav.ts` + a `screens/upgrader.tsx`). The right pane is a
small state machine — one tab, three states, as you specified:

**State 1 — Configure (what's going in).** Pick the source run (defaults to latest) and
scope: a single agent, or "whole system." Show a live preview from `/upgrade/preview`:
which records were selected (worst K + best M), their scores, and the comparison deltas
being fed — plus the auto-comparison progress ("14/15 comparisons ready…") as the safety
check. A prominent **Run upgrade** button (disabled until comparisons are ready).

**State 2 — Running.** Streamed status; the optimizer is one LLM call (or a few for
whole-system), so this is short. Skeletons.

**State 3 — Review & publish.** Two sections:
- **Prompt edits** — for each `prompt_patch`, render the existing prompt editor in a
  read-compare mode: the current prompt with the patched sections **highlighted** (green
  insert / red delete, reusing `@notera/ui/lib/md`'s `computeDiff`). Buttons: **Publish**
  (→ existing versioning; the diff becomes v<N+1>), **Edit then publish** (drops the
  full_prompt into the normal editor so you can hand-tune first), **Dismiss**.
- **System suggestions** — a list of non-prompt improvements with Accept / Dismiss, each
  persisted so they become a living backlog.

After publishing, a one-click **"Verify"** shortcut runs the existing *Rerun on latest* for
that agent and links to Metrics so you can see whether the number actually moved (§9).

---

## 8. Persistence & flow, end to end

```
run finishes → autocompare fills compare.json for all records
      ↓
Upgrader: Configure → preview context → Run upgrade
      ↓
optimizer LLM → upgrade_runs + prompt_suggestions + system_suggestions persisted
      ↓
Review: highlighted diffs
      ↓  Publish (human)
registry: savePromptDraft → publish → prompts/store/<agent>/v<N>.json
prompt_suggestions.status='published', published_version=N
      ↓  Verify
Rerun on latest (existing) → metrics update → dashboard shows the delta
```

Everything is auditable: the raw optimizer output, the exact context summary, which
suggestion became which published version, and whether the follow-up run improved.

---

## 9. My additions — the safety rails this feature must have

An automatic prompt optimizer is powerful and, done naively, quietly destructive. These are
not optional:

1. **Never auto-publish.** The optimizer proposes; a human publishes. This is already how
   the plan is built and must stay that way for a clinical system.
2. **Contrastive sampling is mandatory, not a nice-to-have.** Feeding only failures causes
   regressions on passing cases. Always include high-scoring anchors and instruct the
   optimizer to preserve what makes them pass.
3. **Guard against overfitting the reference set.** Split fixtures into an **optimize set**
   and a **held-out validate set**. Build context only from the optimize set; after
   publishing, verify on the *whole* set (including held-out). If held-out regressed, flag
   it. Optimizing and validating on the same cases is how you get prompts that ace your
   tests and fail in production.
4. **Protect safety-critical instructions.** The meta-prompt forbids removing grounding,
   de-identification, negation, and medication-cross-check instructions. Additionally, a
   deterministic post-check rejects any patch whose `after` deletes lines matching a
   protected-keywords list (e.g. "de-identif", "do not invent", "negation", "unsupported").
5. **Version-pin the diff.** Store `base_version`; if the live prompt has moved on since the
   suggestion was generated, warn before publishing (the patch may not apply cleanly).
6. **Cost + rate control.** Whole-system mode is N optimizer calls; show an estimate and a
   confirm. Reuse `LLMService` retries and the proxy.
7. **Keep the optimizer itself improvable and inspectable.** Its prompt is versioned; its
   raw output is stored. If it gives bad advice, you can see why and tune it.
8. **Measure the optimizer, not just trust it.** Track, per published suggestion, the
   metric delta on the verification run. Over time this tells you whether the upgrader is
   net-positive — a meta-metric for your meta-agent.

---

## 10. Phasing (each independently shippable)

| Phase | Deliverable | Needs LLM? |
|---|---|---|
| **U-1** | Migration: `upgrade_runs` / `prompt_suggestions` / `system_suggestions` (+ labStore fns). Additive, no reset. | no |
| **U-2** | Auto-comparison after a run (`/autocompare`) + Run-screen progress. | yes (reuses compare) |
| **U-3** | `buildUpgradeContext` + `/upgrade/preview` + the `system-upgrader` registry prompt. | no (preview is data-only) |
| **U-4** | `POST /api/lab/upgrade` (optimizer call + persistence) + output contract parsing. | yes |
| **U-5** | Upgrader screen: Configure → Running → Review, with highlighted diffs reusing the prompt editor. | — |
| **U-6** | Publish/dismiss wiring (into existing versioning) + system-suggestion backlog. | — |
| **U-7** | Safety layer: optimize/validate split, protected-keyword check, base-version drift warning, one-click Verify. | — |
| **U-8** | Verification: mocked-LLM tests for context building + patch application + protected-keyword rejection; babel/`node --check`. | no |

U-1 through U-3 are pure plumbing and can land with zero model spend. The optimizer call
(U-4) is the only genuinely new LLM surface, and it's one call per agent.

---

## 11. Anything else worth implementing (bonus backlog)

Ordered by value-to-effort, all enabled by the data you already store:

1. **Prompt A/B on a run.** Run the same fixtures with prompt version A vs B side by side
   (the schema already supports it via `prompt_snapshot` + `attempt`). Turns "I think this
   is better" into a measured comparison — and is the natural *verification* engine for the
   upgrader.
2. **Baseline pinning + regression alerts.** Pin a run as "baseline"; the dashboard flags
   any metric that drops more than a threshold below it on later runs. Makes the upgrader's
   effect impossible to miss.
3. **Auto-fixture from production.** Your clinician "flywheel" (draft→final diffs) is a gold
   mine: turn signed consults into new reference cases automatically, so the optimizer
   learns from real edits, not just synthetic gold. (Requires de-identified, consented data
   — treat carefully.)
4. **Failure clustering.** Group `notera_missing` / `key_differences` across records to name
   recurring failure modes ("negation errors," "dropped lab values"). Feed the cluster
   labels to the optimizer as structured priors — far stronger signal than raw examples.
5. **Cost/latency dashboard.** You store `tokens_in/out` and `latency_ms` per agent already
   — chart cost per run and per agent so prompt changes that improve quality but blow up
   cost are visible.
6. **Suggestion changelog.** A page listing every published upgrade, its rationale, and its
   measured before/after — an audit trail of how the system taught itself.
7. **Make NER-off loud.** Today `med_grounding` silently becomes `null` when the NER sidecar
   is down, disabling your best guardrail. Surface it as a banner in the lab.

---

## 12. Open decisions (I recommend the first option in each)

1. **Scope default:** per-agent (recommended — clean attribution) with an opt-in
   whole-system mode. *Alt:* whole-system by default.
2. **Edit granularity:** targeted patches with highlighted sections (recommended, matches
   your ask) + full rewrite as fallback. *Alt:* full rewrite only.
3. **Which agents are eligible:** the LLM agents that materially shape the note
   (`observation-extractor`, `clinical-story`, `qa-validator`, `fact-recovery`,
   `encounter-classifier`) — recommended to start with `qa-validator` since it's cheapest to
   verify. *Alt:* all registry prompts.
4. **Optimize/validate split:** on by default with a configurable ratio (recommended).
   *Alt:* optimize on all, accept overfitting risk.

---

*If you approve, I'd build it U-1 → U-8 in order, same as the Testing Lab phases — each step
validated before the next, and the whole thing behind the existing admin auth.*
