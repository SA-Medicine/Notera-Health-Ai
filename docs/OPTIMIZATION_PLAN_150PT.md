# Notera — Industry‑Grade Optimization Plan (from the 150‑patient run + System Upgrader)

Derived from two independent signals over the same corpus: the **Eval‑Analyst run report** (67 scored fixtures, avg 87.36) and the **System Upgrader / Optimizer** output. This doc records the convergent findings, what was implemented this pass, the architecture rationale, and the phased plan for the rest.

---

## 1. Where the two reports converge (highest‑confidence signal)

A finding that BOTH the model‑judge (Eval‑Analyst) and the prompt‑optimizer (Upgrader) surface independently is far more trustworthy than either alone. The convergent set:

| # | Convergent issue | Eval‑Analyst | Upgrader | Severity |
|---|---|---|---|---|
| 1 | **Temporal status of plan actions** — already‑completed actions written as future plans; declined interventions written as active plans | "birth‑control renewal already done but planned", "Jardiance declined but listed as open" | `gord-rx-renewal`: completed actions extracted as future plans | **Critical (safety)** |
| 2 | **Medication entity fidelity** — dangerous sound‑alike substitutions | Zolpidem↔Zofran, Taztia↔Reactine, Alfuzosin↔Silodosin | RxNorm/formulary grounding | **Critical (safety)** |
| 3 | **Lab value ↔ analyte binding** — numbers attached to the wrong test | "drifted quantitative lab values" | `lp`: TSH vs lipid‑panel misattribution | High |
| 4 | **A&P over‑consolidation** — distinct problems + secondary actions dropped | 9× "consolidated 6 problems into 2, dropped HRT/migraine/TB screening" | fact‑recovery invoked only for `['medication']`; expand triggers | **High (this is the biggest score gap: Completeness N4.19 vs G4.81)** |
| 5 | **Polarity / consent** — absent symptom recorded present; declined tx as active | 4× polarity inversions | temporal/consent status tagging | **Critical (safety)** |
| 6 | **Telehealth / no‑exam objective + exact vitals** | omitted "no exam performed", dropped BP 105/54 | (objective omissions) | Medium |
| 7 | **Corrupted gold dates** penalizing accurate extraction | synthetic date artifacts in gold | same, flagged as data issue | Medium (scoring fairness) |

Plus two **infrastructure** problems you reported directly: unexpected **logout** during work, and **large scans (150+) interrupted midway**.

---

## 2. Implemented this pass

### Infrastructure (the two blockers)

**A. Industry‑grade session — no more unexpected logout.** Root cause: sessions were an in‑memory `Set` + a cookie with no `Max-Age`, so every `node --watch` restart (any code edit), crash, or deploy wiped them, and closing the tab dropped the cookie. Replaced with a **stateless, HMAC‑signed cookie** (`packages/backend/src/admin/session.js`): the signing secret is persisted once to disk, so tokens **survive restarts**; cookie has a 30‑day `Max-Age`; **sliding expiry** re‑issues the cookie past the halfway mark so an active session never lapses. Verified: survives a fresh process, rejects tampered/expired/garbage tokens. Override in prod with `ADMIN_SESSION_SECRET` / `ADMIN_SESSION_TTL_DAYS`.

**B. Large‑run robustness — 150+ scans no longer interrupted.** Root cause: the scan ran as a **child of the backend**, so a `--watch` reload killed it mid‑run, and `_summary.json` was only written at the very end (so an interrupted run lost everything). Fixes:
- **Detached child** (`detached: true` + `unref()`) — the scan runs in its own process group and survives backend restarts/crashes/deploys.
- **Incremental checkpoints** — `run_eval` now writes `_summary.json` **and** `_progress.json` after *every* patient, so an interrupted 150‑patient run keeps all completed results, and the UI shows live `done/total`.
- **Per‑patient hard timeout** (`RUN_FIXTURE_TIMEOUT_MS`, default 300 s) so one stuck record can't freeze the whole scan; the patient is recorded as an error and the loop continues (per‑fixture errors were already isolated).
- **EPIPE guard** so a closed stdout pipe (backend gone) can't crash the detached run.
- **Boot reconciliation** — on restart, a previously‑"running" run is checked by **pid liveness** + its `_progress.json` phase, so a still‑alive detached run stays "running" and a genuinely‑dead one becomes "interrupted"/"passed" correctly. `/api/runs` now returns live `progress`.

### Quality (convergent findings 1, 4, 5, 6, + generation guidance for 2, 3)

**C. Deterministic consent/status guardrail** (`flagConsentAndStatus` in `validation/upgrades.js`, wired into `applyUpgradeGuardrails`). Flag‑only (never deletes — the safety net; prompts do the correcting), grounded in transcript language:
- **Declined‑as‑active‑plan** → `declined_intervention_planned` (critical): a plan action referencing an intervention the transcript says the patient declined/refused.
- **Completed‑as‑future‑plan** → `completed_action_planned` (major): a renewal/fax/referral written as future when the transcript says it was already done.
- No false positive when the note already records the decline. 4 new tests; suite green (81/81).

**D. Prompt hardening** across the generation + tightener stages (the higher‑leverage lever for nuanced clinical judgment):
- `tightenNote` (re‑reads the transcript) — new rules **15–20**: temporal status (completed vs planned), consent (declined ≠ plan), **preserve every problem + secondary action** (anti‑over‑consolidation), **medication fidelity** (no phonetic swaps, exact dose/refill), **lab analyte binding**, and **telehealth "no exam performed" + exact vitals**.
- `structureNote` A&P — keep distinct problems separate, preserve secondary actions, record declined/completed status correctly.

---

## 3. Architecture rationale

- **Deterministic guardrails flag; prompts correct.** Safety‑critical patterns (declined/completed status) are caught deterministically as a reviewer safety net, but the *correction* lives in the prompts because it needs clinical context. This mirrors the existing split (guardrails only move/relabel/flag; never invent).
- **The tightener is the single best correction point** — it re‑reads the transcript and rewrites the whole note, so consolidated cross‑cutting rules (consent, temporal, anti‑consolidation, med fidelity) belong there rather than scattered.
- **Runs are decoupled from the request lifecycle.** A scan is a detached, checkpointing batch job, not an HTTP request — the industry pattern (the UI observes via polling/log stream + progress file, never "owns" the process).
- **Sessions are stateless** so horizontal scaling / restarts are free (no shared session store needed).

---

## 4. Phased plan for what remains

| Phase | Item | How | Value |
|---|---|---|---|
| **Q1** | **RxNorm phonetic‑confusion guard** (finding 2) | Extend `services/rxnorm.js`: when an extracted drug doesn't resolve, use RxNav spelling‑suggestions + a small edit‑distance/soundex check against the transcript's drug tokens; flag `medication_confusion` (critical) when the note's drug differs from the transcript's nearest real drug. | Kills the dangerous Zofran→Zolpidem class deterministically. |
| **Q2** | **Lab analyte↔value binding** (finding 3) | Deterministic entity‑relation pass: pair each numeric result with the nearest analyte token in the transcript; flag/relabel a value bound to the wrong analyte before it reaches `clinical-story`. | Fixes `lp`‑class misattribution. |
| **Q3** | **Fact‑recovery category expansion** (finding 4) | Trigger `fact-recovery` for ALL sections with gaps, not just `['medication']`; add a completeness check that every gold‑style problem/secondary action is represented. | Directly closes the Completeness gap. |
| **Q4** | **Gold date‑corruption handling** (finding 7) | In `eval/metrics.mjs` + the comparison prompt, detect synthetic/de‑identified date artifacts in gold and exclude them from date‑based penalties, or normalize before scoring. | Stops unfairly penalizing accurate extraction; restores metric trust. |
| **I1** | **Resume‑remaining runs** | With incremental `_summary.json` present, add a "resume" that re‑runs only fixtures not yet in the partial summary. | Turns "interrupted" into a one‑click continue. |
| **I2** | **Bounded concurrency + backoff for big scans** | Process fixtures with a small worker pool (e.g. 3–5) + 429/5xx exponential backoff (LLMService already retries) so 150 patients finish faster without tripping rate limits. | Throughput for large corpora. |
| **I3** | **Progress bar in the Run/Metrics UI** | Consume the new `progress {done,total,current,phase}` from `/api/runs`. | Visible ETA for long scans. |
| **M** | **Failure‑taxonomy tracking** | Persist the Eval‑Analyst `failure_themes` per run and chart counts‑per‑mode over time. | Confirms whether each fix actually reduces its failure class. |

---

## 5. How to validate each fix works

Run the **same fixture set** twice (before/after) so the Metrics → Compare workbench has paired power, then:
1. **Session:** edit any backend file mid‑session → you stay logged in.
2. **Large run:** start a 150‑patient scan, edit a file to trigger a `--watch` restart → the scan keeps going and `_summary.json` grows; `/api/runs` shows `progress`.
3. **Consent/status:** the Run log shows `[upgrade:consent-status] …` flags; the note records declined/completed correctly.
4. **Completeness:** Compare workbench shows Coverage/Completeness up with tight CIs; Run report shows fewer "A&P consolidation" failure‑theme counts.

---

*Implemented files: `admin/session.js` (new), `admin/handler.js` (session + detach + reconcile + progress), `eval/run_eval.mjs` (checkpoint + timeout + EPIPE), `validation/upgrades.js` (`flagConsentAndStatus`), `orchestrator/tightenNote.js` + `structureNote.js` (prompt rules). Tests: `upgrades.test.mjs` 81/81.*
