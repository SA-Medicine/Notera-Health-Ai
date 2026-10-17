# Notera admin console — control, evaluation and self-improvement

Live at **https://admin.aitoolsfordoctor.com** (separate Cloudflare account; the backend it controls is the production Google VM).
Updated 2026-10-17.

## 1. Does a prompt edited in the admin console really change production?

Yes. The path, step by step:

| Step | What happens | Where |
|---|---|---|
| 1 | Admin presses **Save as new version & go live** in *Prompts* | `apps/admin-site/public/prompts.js` |
| 2 | Browser → Worker → `POST /api/console/prompts/promote` on the VM (admin session required, CSRF-checked) | `panelRoutes.js` |
| 3 | Server validates the text (length, required parser markers such as `unsupported`, `duplicates`, `JSON`) | `checkPrompt()` |
| 4 | A new **immutable row** is inserted in Postgres `ops.prompt_versions` (name, version, text, note, author, evidence) and made the single `active` row; the audit log records who/when | `promptStore.promote()` |
| 5 | On **every note**, the pipeline calls `getActivePromptMeta(name)` → active row text, or the built-in default if none. Cached ≤ 60 s per process; `promote()` clears the cache of the process that handled it | `generateNoteV2.js` |
| 6 | The note records which prompt versions and settings produced it (`metadata.pipeline_trace`), shown in *Notes → Pipeline → Produced with* | `generateNoteV2.js`, `app.js` |

Rollback = activate an older version (same path, instant). Reset = no active row, so the code default applies. Versions are never deleted.

**Proof it works**
* `packages/backend/test/adminControl.pgmem.mjs` (in-memory Postgres): promote → pipeline sees it immediately → second version → rollback is live on the very next call → reset → per-stage independence → every default prompt contains its own required markers → config override/validation/reset/history. All assertions pass.
* Production database check (2026-10-17): runtime-config tables exist and read correctly, 0 overrides, writer prompt = built-in default (nothing has been changed yet).
* Every admin SQL statement is `EXPLAIN`-validated against the real production schema (`test/panelSql.explain.mjs`: all ok).

**Before this work, only the writer prompt could be changed, and models/temperature could not be changed at all** — that is what made the backend feel hidden. Now the writer, checklist and verifier prompts and every model/sampling/timeout setting are visible and editable.

## 2. Screens (compared with the old Next.js Testing Lab)

| Old Testing Lab screen | Now | Notes |
|---|---|---|
| Overview (KPIs vs previous run) | **Overview** + **System** + **Trends** | live production KPIs, per-run KPIs with deltas |
| Run (all / range / pick, live log, resume/retry) | **Evaluate** | Random · Pick & search · Range · Latest; progress, Stop, Re-run; no seed to manage |
| Results (generated vs gold, diff) | **Evaluate → Open run** and **Compare → read note** | A vs B vs gold vs transcript |
| Metrics (Run report / Compare / Trend) | **Compare** and **Trends** | paired statistics with sign-test p-values, per-note bars, charts over time |
| Judge | **Compare → Blind judge** | now order-swapped, counts hallucinations and misses, human calibration |
| Critique | judge per-note "why" + unsupported/missed counts | |
| Upgrader (prompt suggestions, system ideas) | **Optimize** | improve → validate on unseen notes → gate → promote |
| Prompts (pipeline graph, edit, draft/publish, history, rollback, runtime config) | **Prompts** + **Settings** + **System** | all three LLM stages; diff view; change notes; required-marker validation |
| Patients | gold-note picker inside Evaluate | |

New: **System** (pipeline map with model + prompt version + settings per stage; production volume, latency p50/p95, failures, cost, errors, sign-ups) and **Settings** (11 runtime parameters, validated, audited, with history).

## 3. Safety design

* Writer-prompt promotion is gated on the server side by evidence computed from stored runs: same-notes A/B, **30+ unseen notes**, similarity not lower, omission not higher, no new failures, p95 latency within +25 %, blind judge prefers the candidate (order-swapped), no more hallucinated claims. Overriding requires a typed reason that is stored with the version.
* Settings are range/type-checked on the server; unknown keys are rejected; every change (and reset) is written to `ops.runtime_config_history` and the audit log.
* All changes reach production without a deploy: prompts ≤ 60 s, settings ≤ 30 s.
* Lab and admin Worker are on a separate Cloudflare account and the Lab container is capped (640 MB) so testing cannot starve the clinician-facing backend.

## 4. What the industry does, and what we took from it

| Practice | Source | In Notera |
|---|---|---|
| Prompts as versioned, immutable records with a movable "production" pointer; rollback = move the pointer; client cache ~60 s | [Langfuse prompt management](https://langfuse.com/docs/prompt-management/data-model), [engineering write-up](https://langfuse.com/resources/engineering/prompt-management-at-scale) | `ops.prompt_versions` + `active` flag, 60 s cache, rollback |
| Experiments are immutable snapshots, comparable over time; playground results are promoted to experiments; per-row regressions; CI gating | [Braintrust](https://www.braintrust.dev/docs/guides/experiments/run) | runs stored forever; Compare table with improved/regressed rows; promotion gate |
| Pairwise review of two experiments side by side; offline vs online evaluation | [LangSmith pairwise queues](https://docs.langchain.com/langsmith/annotation-queues), [evaluation](https://www.langchain.com/langsmith/evaluation) | Compare → per-note A/B reading and human verdict buttons |
| Prompt × test × assertion matrix; regression evals as a CI quality gate with pass-rate thresholds | [promptfoo guide](https://qaskills.sh/blog/promptfoo-complete-guide-2026) | gate checklist (all checks must pass) |
| Versioned datasets, experiments, playground replay; prompt tagging | [Arize Phoenix](https://pypi.org/p/arize-phoenix) | gold corpus + run records; "Test on 10 gold notes" from the prompt editor |
| Pairwise win rates with a model judge and explanation; prompt optimizer driven by eval metrics | [Vertex AI Gen AI evaluation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/eval-python-sdk/run-evaluation), [Prompt Optimizer](https://cloud.google.com/blog/products/ai-machine-learning/announcing-vertex-ai-prompt-optimizer) | blind judge; Optimize loop |
| Reflective prompt evolution from failure feedback, held-out validation, Pareto of candidates | [GEPA (arXiv 2507.19457)](https://arxiv.org/pdf/2507.19457v2) | Improve reads worst-note feedback; validation on unseen notes (single candidate today, not a Pareto set) |
| Judge position bias: run both orders and count a win only if consistent; calibrate against humans (Cohen's κ) | [MT-Bench / LLM-as-judge practices](https://futureagi.com/blog/llm-as-judge-best-practices-2026) | order-swapped judge; **measured 62 % consistency** on our first run; human labels → agreement and κ |
| Clinical scribe evaluation needs transcript-grounded error audits (omission, addition, incorrect fact), not only holistic Likert scores; most errors are omissions | [PDQI-9 based study](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1691499/full), [Suki critique](https://www.fiercehealthcare.com/ai-and-machine-learning/ai-scribe-adoption-grows-researchers-suki-challenge-industrys-quality) | judge returns `unsupported` and `missed` counts per note; omission rate metric |

Findings from search were mostly secondary sources; anything quantitative (e.g. κ thresholds) is a rule of thumb, not a standard.

## 5. First real measurements (20 random gold notes, production prompt)

| | 2.5 Flash (production) | 3.5 Flash-Lite |
|---|---|---|
| Similarity to gold | 0.351 | 0.319 (worse, p = 0.03) |
| Story / flow | 0.852 | 0.941 (better, p = 0.03) |
| Median latency | 6.96 s | 4.81 s (faster, p = 0.008) |
| Blind judge (first run, unswapped) | 12 wins | 7 wins |

Conclusion at the time: keep 2.5 Flash for the writer; use the Optimize loop to see whether Lite plus an improved prompt can match it.

## 6. Open items / not done

* The console was **verified with a mock API and screenshots plus live API checks, not clicked through with a real admin login** (that needs the admin's credentials).
* The old Testing Lab's whole-pipeline per-agent Upgrader applied to the v1 multi-agent pipeline; v2 has three LLM stages, so only the writer has the automated improve loop. Checklist/verifier prompts are editable by hand.
* Human review is a verdict per judged note, not a full annotation queue.
* No alerting yet (e.g. failure-rate threshold email). `System` shows the numbers; paging is a follow-up.
* Production writer is still `gemini-2.5-flash`; change it in *Settings → Writer model* when evidence supports it.
* Earlier open items still stand: DB password committed in `db/secrets/pg_password.txt` should be rotated; no email verification on sign-up; clinician review of note quality.
