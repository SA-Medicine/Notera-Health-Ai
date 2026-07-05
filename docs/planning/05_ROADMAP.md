# 05 — Roadmap

The whole plan sequenced into phases. Each phase ships something usable and de-risks the next. Timeframes are indicative — adjust to your team size.

---

## Phase 0 — Foundations (Weeks 1–2)

**Goal:** know what we have and set the guardrails.

- Data audit of the 2k pairs (`02 §2`).
- Draft schema v0.1 from the gold notes (`02 §3`).
- Stand up the eval harness skeleton + baseline measurement (`03 §6`).
- Confirm legal basis / consent for use + training (`04 §1`). `[DECIDE]`
- Set up dataset storage, encryption, versioning.

**Deliverable:** `data_audit.md`, schema v0.1, baseline scorecard.

---

## Phase 1 — Quick wins: Gemini + NER, no tuning (Weeks 2–4)

**Goal:** capture ~80% of value before any Gemini tuning.

- Strong Gemini prompt + strict schema + structured output (`03 §2`).
- Wire up **medical ASR** (Google MedASR/Chirp) → transcript (`06 §4`).
- Wire up **open-source Python NER** (scispaCy + Med7 + medspaCy) for entity extraction (`06 §3`).
- NER grounding into Gemini + validation cross-check (`03 §3b`).
- Validation & guardrails layer (`01 §"Validation"`).
- Few-shot / retrieval from gold notes (`03 §3`).
- Measure lift over baseline.

**Deliverable:** an ASR→NER→Gemini pipeline that reliably emits schema-valid, fact-grounded notes, with a scorecard beating baseline.

---

## Phase 2 — Data pipeline & structuring (Weeks 3–6, overlaps Phase 1)

**Goal:** turn 2k gold notes into a clean training set.

- Parse gold notes into schema (`02 §4`).
- De-identify (`02 §5`, `04 §1`).
- Freeze train/val/test split + golden set (`02 §6`).
- Build the training-file generator (`02 §7`).

**Deliverable:** versioned, de-identified, schema-structured dataset + golden eval set.

---

## Phase 3 — Custom NER + feedback capture (Weeks 6–9)

**Goal:** push factual accuracy toward Heidi-level and start the flywheel.

- If pre-trained NER misses schema entities, train a custom **BioClinicalBERT/PubMedBERT** tagger (`03 §3b`, `06 §3`) — small, free, in-house.
- Ship feedback capture (draft vs final) in the review UI.
- Tighten the meds/doses/allergies validation cross-check.
- Run the full eval gate; compare to Phase 1 champion.

**Deliverable:** high-accuracy NER-grounded pipeline + a growing edit dataset.

---

## Phase 4 — Gemini supervised tuning (Weeks 9–16)

**Goal:** finish the quality gap and cut prompt cost via a tuned Gemini.

- De-identified 2k pairs (+ new approved notes) uploaded to **Vertex AI**; run **Gemini supervised tuning** (`03 §4`). Requires Google Cloud BAA (`04`).
- A/B the tuned Gemini vs prompt+NER via the generation interface (`01 §3`).
- Quantify $/note improvement (shorter prompts, right-sized tier).

**Deliverable:** a tuned Gemini champion, hosted by Google (nothing self-run), lower unit cost.

---

## Phase 5 — Production hardening (Weeks 14–20)

**Goal:** be genuinely production- and compliance-ready.

- Full monitoring/observability + alerting (`04 §5`).
- Shadow deploy → canary → promote pipeline (`04 §4`).
- Security review + pen test (`04 §6`).
- Go-live checklist complete (`04 §8`).

**Deliverable:** monitored, auditable, rollback-capable production system.

---

## Phase 6 — Continuous learning & scale (Ongoing)

**Goal:** the flywheel from `02 §8` / `03 §7` runs itself.

- Re-tune Gemini on accumulated approved-note + edit data (`03 §5`).
- Automated periodic re-tune → eval → shadow → promote.
- Add specialties via schema extensions (`02 §3`).
- Roll out company-wide with onboarding + support (`04 §7`).

**Deliverable:** a self-improving, multi-specialty, company-wide product.

---

## Milestone summary

| Phase | Outcome | Rough timing |
|-------|---------|--------------|
| 0 | Foundations, baseline, legal check | Wk 1–2 |
| 1 | ASR→NER→Gemini pipeline, big quick win | Wk 2–4 |
| 2 | Clean training dataset | Wk 3–6 |
| 3 | Custom NER + feedback capture | Wk 6–9 |
| 4 | Tuned Gemini, cheaper prompts | Wk 9–16 |
| 5 | Production hardened + compliant | Wk 14–20 |
| 6 | Continuous learning at scale | Ongoing |

---

## Cost drivers to budget for

- **Gemini API (Vertex AI):** per-token generation cost — the main ongoing cost. Reduced by NER pre-extraction, Flash tier for drafts, and shorter prompts after tuning.
- **Gemini supervised tuning:** one-off/periodic tuning-job cost on Vertex AI (Phase 4+).
- **Medical ASR:** Google MedASR/Chirp usage (per-minute of audio).
- **NER:** effectively free (open-source, CPU) — only the small custom-NER training job if needed.
- **De-identification** tooling.
- **People:** ML/infra engineer(s), a clinician reviewer for labeling + eval, compliance/legal review.
- **Tooling:** experiment tracking, model registry, monitoring.
- **No GPU inference hosting** — we don't self-host any LLM.

`[DECIDE]` Put real numbers here once team size and volume are known.

---

## Top risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Compliance blocker (no BAA / consent) | Can't use PHI with Google | Sign Google Cloud BAA + approved region; keep NER in-house; confirm consent in Phase 0 |
| Clinically significant hallucination | Patient safety, trust | Human sign-off always; NER cross-check on meds/doses; eval gate |
| Schema churn | Rework, data mismatch | Version schema; derive from originals; base+extensions |
| Data leakage in eval | Overstated quality | Frozen test set, patient-level split, golden set |
| Gemini tuning doesn't beat baseline | Wasted effort | Prove prompt+NER first; only tune after Rung 1–3 plateau |
| ASR word errors on medical terms | Bad input → bad note | Use domain-trained MedASR (not baseline Whisper); diarization |
| Gemini dependency | Cost, single-vendor | Accepted trade-off; keep ASR/NER swappable; right-size tiers |
| Silent quality drift in prod | Undetected degradation | Live monitoring of acceptance/edit rates + drift |
| Clinician non-adoption | Product unused | Onboarding, "you decide" framing, fast feedback loop |

---

## The one-paragraph version

We already own the rarest asset in clinical documentation: 2,000+ real transcript→gold-note pairs. We first define a versioned note **schema** from those notes and build an **eval harness** so every change is measured. The pipeline is **medical ASR → open-source Python NER → Gemini**: ASR transcribes, free in-house NER extracts the hard facts (meds, doses, diagnoses), and **Gemini** writes the schema note grounded on those facts — which we then cross-check against the NER entities before a clinician signs. We capture quick wins with prompting + NER grounding + few-shot, then, once that plateaus, **supervised-tune Gemini on Vertex AI** (Google hosts it — we run no LLM ourselves). Every clinician edit becomes new signal that refreshes the few-shot pool and tuning set — a **continuous learning flywheel**. Wrapped in a single-vendor Google BAA, monitoring, and human sign-off, this turns a fragile prompted prototype into a defensible, scalable, company-wide product.

> Open decisions are tagged `[DECIDE]` throughout. Assign each an owner and a date to make this plan executable.
