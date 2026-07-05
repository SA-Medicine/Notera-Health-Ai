# 03 — Training & Improvement

How to "back-train" the system on the 2k gold pairs, and how to keep improving it forever. This is the heart of the vision.

---

> **Stack note:** the generation model is **Gemini, always** (no self-hosted LLMs). "Training the model further" here means: better prompting, NER grounding, few-shot from our gold notes, and — as the top rung — **Gemini supervised tuning on Vertex AI**. The only thing we ever train in-house is the small, free **NER** model, not an LLM. See `06_TECH_STACK.md`.

## 1. The ladder of improvement (cheapest → most powerful)

Don't jump to tuning first. Climb the ladder — each rung is cheaper and lower-risk, and you may not need the top:

```
Rung 5:  Gemini supervised tuning on Vertex AI (our 2k pairs)   (most power)
Rung 4:  Custom open-source NER (train a BioClinicalBERT tagger) — free, in-house
Rung 3:  NER grounding + validation cross-check
Rung 2:  Retrieval (RAG) + few-shot from gold notes
Rung 1:  Better prompt + strict schema + structured output      (cheapest, do first)
```

**Recommended sequence:** do Rung 1–3 immediately (fast wins, mostly no training), add Rung 4 if pre-trained NER misses our entities, and move to Rung 5 (Gemini tuning) once we've *proven* on the scorecard that prompt+NER+few-shot has plateaued. Nothing here involves hosting an LLM.

---

## 2. Rung 1 — Prompt + schema + validation (do this week)

Before any training, capture most of the value by:

- Writing a **strong system prompt** that embeds the schema and house style.
- Forcing **structured output** (JSON mode / function calling) so notes always parse.
- Adding **validation + guardrails** (from `01`) so bad output is caught, not shipped.

This alone often gets you 80% of the way and gives you a **baseline to measure against**. Never skip it — everything later is compared to this baseline.

---

## 3. Rung 2 — Retrieval + few-shot from the gold notes

Use the 2k gold notes at inference time without training:

- **Few-shot:** for a given specialty/note type, inject 1–3 of the most similar gold `(transcript→note)` examples into the Gemini prompt. Gemini imitates our house style directly.
- **RAG:** retrieve relevant templates, guidelines, or similar prior notes to ground the output.
- **Nearest-example selection:** embed transcripts; pick the closest gold examples per request.

Cheap, immediate, and it makes the 2k dataset *earn its keep* before any tuning.

---

## 3b. Rung 3/4 — NER grounding (the accuracy multiplier)

This is how we hit Heidi-level factual accuracy with Gemini + open-source tooling. Run the free Python NER stack (scispaCy + Med7 + medspaCy, see `06`) on the transcript, then:

- **Ground Gemini:** pass the extracted entities (meds, doses, symptoms, diagnoses, allergies) into the prompt as "confirmed facts from the transcript." Tell Gemini to only assert facts supported by the transcript/entities.
- **Validate Gemini:** after generation, cross-check the note's medications/doses/allergies against the NER entities. Anything in the note that NER didn't find in the transcript gets flagged for the reviewer.
- **Custom NER (Rung 4, optional):** if the pre-trained models miss entity types in our schema, label a few hundred transcripts and fine-tune a **BioClinicalBERT/PubMedBERT** token-classifier. Small, cheap, fully in-house — no PHI leaves, no LLM hosting.

NER is the single biggest lever for reducing the highest-harm errors (wrong/invented meds and doses), and it's free and open-source.

---

## 4. Rung 5 — Gemini supervised tuning (the main event)

This is our version of "train the model on my data" — **without hosting anything**. Google Cloud **Vertex AI** offers supervised tuning of Gemini: you upload the `messages`-format dataset from `02`, Google tunes and hosts a private Gemini model for you, and you call it exactly like the base API.

- **Pros:** no infra to run, strong base model, keeps everything in the Google/Gemini ecosystem, one BAA/data-residency story (see `04`).
- **Cons:** per-token cost, tuning data must be de-identified and covered by the Google Cloud BAA before upload.

### What Gemini tuning does here
You show Gemini thousands of `transcript (+entities) → ideal structured note` examples. It internalizes:
- your exact schema and section ordering,
- your house phrasing and level of detail,
- specialty-specific conventions,

so at inference you send a shorter prompt + transcript + NER entities and get a house-style note — more consistent and cheaper (shorter prompts) than the long generic prompt.

### When to do it
Only after Rung 1–3 have plateaued on the scorecard. Prompt + few-shot + NER grounding often gets most of the way; tuning is the finisher, not the starting point. Keep the base Gemini call available as a fallback (via the interface in `01`).

**No self-hosted LLMs at any rung.** The only weights we ever train locally are the small, free NER models (Rung 4).

---

## 5. Using clinician edits to keep improving

Every clinician edit (draft vs approved) is signal. With a Gemini-only stack, use it two ways:

- **Curate better tuning data.** Add the *approved* notes as new gold examples and re-run Gemini supervised tuning. The edits tell you exactly which cases the model got wrong, so weight/oversample those. This directly closes the "draft vs final" gap.
- **If/when Vertex AI exposes preference tuning**, feed the `(draft = rejected, approved = chosen)` pairs so Gemini learns to prefer what clinicians keep. `[DECIDE]` check current Vertex AI capabilities.

Either way, the review loop is the engine: the approved-note stream continuously refreshes both the few-shot pool and the tuning set — no self-hosting required.

---

## 6. The evaluation harness (build this before you train anything)

You cannot improve what you can't measure. Build an eval suite that runs on the frozen test set from `02` and reports a scorecard for every model version.

**Automatic metrics:**
- **Schema validity:** % of outputs that parse and match schema. (Should be ~100%.)
- **Section coverage:** are required sections present and non-empty when the transcript supports them?
- **Factuality / grounding:** does the note assert anything not supported by the transcript? (Use an LLM-as-judge + rules for meds/doses/numbers.)
- **Omission:** does the note miss facts that the gold note captured?
- **Similarity to gold:** ROUGE/embedding similarity per section (a proxy, not the truth).

**Human metrics (the real ones):**
- **Acceptance rate:** % of notes clinicians accept with no/minor edits.
- **Edit distance:** average edits per note (track over time — should fall).
- **Error severity:** categorize errors (cosmetic vs clinically significant). Zero tolerance for clinically significant hallucinations.

**Eval discipline:**
- Run the full suite on every candidate model. No promotion without beating the current champion on the golden set.
- Keep a **regression set** of past failures; new models must not reintroduce old bugs.
- Track everything in an experiment log (model version, data version, schema version, scores).

---

## 7. The continuous improvement loop

```
        ┌─────────────────────────────────────────────┐
        │  Production notes + clinician edits          │
        │  (new gold pairs + preference/edit pairs)    │
        └───────────────┬─────────────────────────────┘
                        ▼
        ┌─────────────────────────────────────────────┐
        │  Append to dataset, de-identify, version     │
        └───────────────┬─────────────────────────────┘
                        ▼
        ┌─────────────────────────────────────────────┐
        │  Periodic retrain (SFT + preference tuning)  │
        └───────────────┬─────────────────────────────┘
                        ▼
        ┌─────────────────────────────────────────────┐
        │  Eval on frozen test + golden set            │
        │  Beats champion?  ── no ──► discard          │
        │        │ yes                                 │
        └────────┼────────────────────────────────────┘
                 ▼
        ┌─────────────────────────────────────────────┐
        │  Shadow deploy → A/B → promote to champion   │
        └─────────────────────────────────────────────┘
```

Cadence: `[DECIDE]` monthly or quarterly retrains to start; automate later. Every retrain is measured, shadow-tested, then promoted only if it wins.

---

## 8. Guardrails specific to a medical model

- **Never auto-finalize.** The model drafts; a clinician signs. Non-negotiable.
- **Flag low confidence** per section so reviewers know where to look.
- **Hard rules on meds/doses/allergies/numbers** — these are the highest-harm errors. Validate them against the transcript explicitly.
- **No fabrication of exam findings.** If the transcript doesn't support a finding, the field stays empty rather than invented.
- **Bias/fairness checks** across specialties and demographics in eval.

---

## 9. What to build first (engineering order)

1. Eval harness + golden set (measure baseline).
2. Rung 1 + 2 improvements (prompt, schema, structured output, few-shot).
3. NER grounding + validation cross-check (Rung 3) — the accuracy multiplier.
4. Feedback capture in the review UI (draft vs final).
5. Custom NER only if pre-trained models miss our entities (Rung 4).
6. Gemini supervised tuning on Vertex AI once Rung 1–3 plateau (Rung 5).
7. Automate the re-tune→eval→shadow→promote loop, refreshed by clinician edits.

> Next: `04_DEPLOYMENT_AND_SCALING.md` — running this in production, compliantly, at company scale.
