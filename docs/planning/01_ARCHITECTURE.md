# 01 — Architecture

How the medical-scribe system works today, and the architecture we're moving to.

---

## 1. How it works today (prototype)

Right now the system is a **thin wrapper around a hosted LLM**. The flow:

```
Audio / typed transcript
        │
        ▼
  [Prompt builder]  ──►  "You are a medical scribe. Given this transcript,
        │                 produce a note with sections HPI, Exam, A&P..."
        ▼
  [Hosted LLM API]  (GPT / Claude-class, called with a big system prompt)
        │
        ▼
  Free-text / loosely-structured note
        │
        ▼
  Human reads, edits, pastes into EMR
```

**What's good:** it works, it was fast to build, quality is decent because the base model is strong.

**What's fragile:**

- The "definition of a good note" lives inside a prompt string, not a spec.
- Output structure isn't guaranteed — parsing/validation is best-effort.
- Every note pays for a long prompt + a large general model.
- No memory: the system never learns from the 2k gold notes we already have.
- Vendor lock-in: behaviour shifts when the vendor updates the model.

---

## 2. Target architecture (production)

The target keeps the parts that work and adds the parts that make it ownable, measurable, and cheap at scale. Layered view:

```
┌───────────────────────────────────────────────────────────────┐
│ 1. INGESTION                                                    │
│   Audio capture → ASR (speech-to-text) → clean transcript      │
│   (or) direct typed/transcribed input                          │
│   + metadata: specialty, note type, clinician, consult id      │
└───────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────────────────────┐
│ 2. PRE-PROCESSING                                               │
│   - De-identification / PHI tagging (for logging & training)   │
│   - Transcript normalization (speaker turns, timestamps)       │
│   - NER: open-source Python medical NER extracts structured    │
│     entities (meds, doses, symptoms, diagnoses, allergies)     │
│   - Context assembly (patient history snippets, note template) │
└───────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────────────────────┐
│ 3. GENERATION CORE (Gemini only)                              │
│   - Gemini API writes the note (via Vertex AI in prod)        │
│   - Grounded on NER entities + few-shot gold examples         │
│   - Structured output constrained to the NOTE SCHEMA (JSON)    │
│   - Optional retrieval (RAG) for guidelines / templates        │
└───────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────────────────────┐
│ 4. VALIDATION & GUARDRAILS                                     │
│   - Schema validation (must match versioned spec)              │
│   - Cross-check note meds/doses against NER entities;          │
│     flag anything Gemini wrote that NER didn't find            │
│   - Safety checks: hallucination flags, missing-section flags, │
│     contradiction with transcript, unsupported meds/doses      │
│   - Confidence scoring per section                             │
└───────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────────────────────┐
│ 5. HUMAN-IN-THE-LOOP REVIEW                                    │
│   Clinician reviews draft, edits, approves → sign-off          │
│   Edits are captured as training signal (see 02 & 03)          │
└───────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────────────────────┐
│ 6. DELIVERY & STORAGE                                          │
│   Approved note → EMR / export. Audit log written.             │
│   (transcript, draft, final, edits) stored for the flywheel.   │
└───────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────────────────────┐
│ 7. LEARNING LOOP (offline)                                     │
│   New (transcript → approved note) pairs feed back into        │
│   the dataset → periodic retraining / eval (see 03)            │
└───────────────────────────────────────────────────────────────┘
```

The key architectural move is that layers **3 and 4** turn a fuzzy "generate some text" into a **contract**: input transcript in, schema-valid note out, validated before a human ever sees it.

---

## 3. Component responsibilities

**Ingestion / ASR.** If we take audio, we need speech-to-text. `[DECIDE]` build vs buy ASR (e.g. a medical-tuned ASR vendor vs a hosted general one). Medical vocabulary and multi-speaker handling matter here.

**Pre-processing & de-identification.** Before any transcript is logged or used for training, PHI is detected and tagged so we can redact/pseudonymize consistently. This is what makes the learning loop safe (see `04`).

**NER layer (open-source Python).** Before generation, a free/open medical NER stack (scispaCy + Med7 + medspaCy — see `06`) extracts structured entities from the transcript: medications, doses, frequencies, symptoms, diagnoses, allergies, procedures, anatomy. These entities do double duty: they **ground** Gemini's prompt (confirmed facts) and they **validate** Gemini's output (cross-check). This is the main lever for Heidi-level factual accuracy.

**Generation — Gemini.** A single interface (`generate(transcript, entities, context) → note`) calls the **Gemini API** (via Vertex AI in production). We do not host our own LLM. The interface still gives us flexibility *within* Gemini:
- prompt + few-shot + NER-grounding (default path),
- Gemini supervised-tuned model on Vertex AI (optional, once proven).

Keeping this behind one interface lets us A/B test prompt vs tuned Gemini and switch Gemini model tiers (Pro for quality, Flash for cheap/high-volume) without touching the rest of the system.

**Structured output.** The generation core is constrained to emit the note **schema** (see `02`), not free text, using Gemini's JSON/structured-output mode.

**Validation & guardrails.** Deterministic checks (schema, required sections) plus model-assisted checks (does the note claim anything not supported by the transcript?). Anything failing is flagged for the human, not silently passed.

**Review UI.** Where the clinician edits and signs off. Every edit is gold: it's the difference between "what the model wrote" and "what the note should be."

**Storage & audit.** Immutable log of who approved what, when. Required for compliance and for the training flywheel.

---

## 4. Data contracts (the important interfaces)

The system is only as stable as its interfaces. Three contracts to freeze early:

1. **Transcript object:** `{ consult_id, specialty, note_type, turns:[{speaker, text, ts}], entities:[{type, text, span, attrs}], metadata }` — `entities` populated by the NER layer.
2. **Note schema:** the versioned clinical-note structure (defined in `02`). Every generated note MUST validate against it.
3. **Feedback record:** `{ consult_id, model_version, draft_note, final_note, edits, clinician_id, approved_at }`

If these three are stable, we can swap models, retrain, and change UIs without breaking the pipeline.

---

## 5. Build vs buy (decisions to make)

| Component | Approach | Recommendation |
|-----------|----------|----------------|
| ASR | Medical ASR (Google MedASR/Chirp) | Google MedASR/Chirp — same ecosystem as Gemini (see `06`) |
| Generation model | **Gemini API only** (Vertex AI in prod) | Fixed decision — no self-hosting |
| Entity extraction (NER) | **Open-source Python** (scispaCy/Med7/medspaCy) | Free, in-house, no PHI leaves (see `06`) |
| Orchestration | Build | Build (it's our core IP) |
| Eval harness | Build | Build (see `03`) |

---

## 6. Non-functional requirements

- **Latency:** target note draft in seconds, not minutes.
- **Availability:** generation failure must fail *safely* (retry, fall back to a lower Gemini tier, or queue — never lose the transcript).
- **Auditability:** every note traceable to model version + reviewer.
- **Portability:** Gemini is the fixed LLM; the ASR and NER layers stay swappable behind clean interfaces.
- **Privacy:** PHI boundaries enforced at every layer (see `04`).

> Next: `02_DATA_PIPELINE_AND_SCHEMA.md` — how we turn 2k gold notes into a schema and a clean training set.
