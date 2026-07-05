# 06 — Tech Stack (Concrete Choices)

This file pins down the exact tools. **Constraints set by the team:**

1. **Generation model = Google Gemini API, always.** No self-hosted LLMs (no Qwen/Llama/Mistral hosting). All reasoning/note-writing goes through Gemini.
2. **Entity extraction = open-source / free Python NER.** Use pre-trained or custom biomedical Named Entity Recognition to pull structured facts (meds, doses, symptoms, diagnoses) — no paid entity API required.
3. **ASR = a domain-trained medical speech-to-text**, preferring free/open where viable, with a compliant paid vendor as the production option.

The design goal is **Heidi-quality notes** using this stack. The trick to matching Heidi is not a bigger model — it's a **strong pipeline**: good ASR → NER-extracted structured facts → Gemini writing against a fixed schema with those facts as grounding → validation.

---

## 1. The pipeline (how the three pieces combine)

```
Audio ──► [Medical ASR] ──► clean transcript (+ speaker turns)
                                   │
                                   ▼
                        [Python NER layer]  ──► structured entities:
                                   │             meds, doses, frequencies,
                                   │             symptoms, diagnoses, anatomy,
                                   │             allergies, vitals, procedures
                                   ▼
        ┌──────────────────────────────────────────────────────┐
        │  Prompt assembly for Gemini:                          │
        │   - transcript                                        │
        │   - extracted entities (as grounding facts)           │
        │   - 1–3 few-shot gold examples (same specialty)       │
        │   - the note SCHEMA (JSON, from 02)                   │
        └──────────────────────────────────────────────────────┘
                                   │
                                   ▼
                    [Gemini API]  ──► schema-valid note (JSON)
                                   │
                                   ▼
                    [Validation]  ──► cross-check the note's meds/doses
                                   │   against the NER entities.
                                   │   Flag anything Gemini wrote that
                                   │   NER did NOT find in the transcript.
                                   ▼
                    [Clinician review & sign-off]
```

**Why NER matters even with Gemini:** the NER layer is a factual safety net. Gemini writes fluent notes; NER independently extracts the hard facts (drug names, doses, allergies). Cross-checking the two catches hallucinated medications/doses — the highest-harm error type — without relying on the LLM to police itself.

---

## 2. Generation — Google Gemini

**Access (our choice):** **Google AI Studio Gemini API** (API-key based), called from the Cloud Run backend.

> ⚠️ **Compliance caveat — read this.** The **AI Studio** Gemini API is the consumer/developer endpoint and is generally **not covered by a Google Cloud BAA / not HIPAA-eligible**. **Vertex AI** is the HIPAA-eligible path. Since we're using AI Studio, the safe pattern is: **never send raw PHI to it.** We already run de-identification + NER *before* generation (`02 §5`, `01 §2`), so we send Gemini a **de-identified transcript + entities**, and re-insert identifiers (name, DOB, MRN) into the final note *after* generation, inside our own systems. That keeps PHI out of the AI Studio endpoint. For a scaled production deployment with real PHI, plan to move the Gemini call to **Vertex AI under a BAA** — the code is nearly identical (same models, same prompts). `[DECIDE]` de-identify-before-AI-Studio now → migrate to Vertex for full production.

How we get Heidi-like quality out of Gemini:

- **Structured output:** use Gemini's JSON / structured-output mode so every note matches schema v1.0.0 (`02`).
- **Grounding:** pass the NER-extracted entities in the prompt as "confirmed facts from the transcript." Instruct Gemini to only use facts present in the transcript/entities.
- **Few-shot house style:** inject the most similar gold `(transcript→note)` examples (`03 §3`) so output matches our style.
- **Long context:** Gemini's large context window comfortably fits full transcripts + examples + schema.
- **Supervised tuning (optional, later):** Gemini supervised tuning is available on **Vertex AI**. Since tuning needs our 2k pairs (PHI), that tuning job should run on Vertex under a BAA regardless — another reason the production endpoint will likely be Vertex. This is our "back-training" path *without* hosting anything ourselves — Google hosts the tuned Gemini model, we just call it. `[DECIDE]` start with AI Studio prompt+few-shot; move to Vertex for tuning + full production.
- **Model tiers:** use a Gemini Pro-tier model for quality; consider a Flash-tier model for cheaper/high-volume or first-draft passes. `[DECIDE]` which tier per step.

> Net: Gemini is the only LLM in the system. "Training further" = Gemini supervised tuning on Vertex AI + growing few-shot/eval sets, not running our own weights.

---

## 3. Entity extraction — open-source Python NER

Pick one or combine several. All are free/open and run in Python. Start with a pre-trained model; add a custom-trained one only if gaps remain.

| Tool | What it's good at | Notes |
|------|-------------------|-------|
| **scispaCy** (`en_core_sci_md`, `en_ner_bc5cdr_md`, `en_ner_bionlp13cg_md`) | Biomedical entities: diseases, chemicals/drugs, genes, cell types | spaCy-based, easy, well-documented. Great default. |
| **Med7** | Clinical **medications**: drug, dose, strength, form, frequency, route, duration | spaCy model purpose-built for prescriptions — ideal for the meds section. |
| **medspaCy** | Clinical NLP + **negation/context** (ConText, section detection) | Critical for "denies chest pain" → don't record chest pain as present. |
| **Stanza (biomedical/clinical models)** | Biomedical + clinical NER, syntactic parsing | Stanford, robust, multiple domain models. |
| **Hugging Face transformers** (e.g. `d4data/biomedical-ner-all`, `blaze999/Medical-NER`, `Clinical-AI-Apollo/Medical-NER`) | Broad medical entity tagging via transformer models | Free weights; pick by benchmark on our data. |
| **Bio_ClinicalBERT / PubMedBERT** (fine-tune your own NER head) | Custom entity types we define | Use if pre-trained labels don't match our schema — train on a few hundred labeled notes. |

**Recommended starting combo:**
- **scispaCy** for diseases/conditions + **Med7** for medications + **medspaCy** for negation/section context. These three cover most of the SOAP note's hard facts and all run locally, free.

**Custom NER path (if needed):** label a few hundred of our transcripts for the exact entities in our schema, fine-tune a Bio_ClinicalBERT/PubMedBERT token-classifier. This is a small, cheap training job and stays fully in-house (no PHI leaves).

Output of this layer feeds both (a) Gemini's grounding prompt and (b) the validation cross-check.

---

## 4. Speech-to-text — medical ASR

General ASR (baseline Whisper) can hit ~40% word error rate on medical dictation, so use a **domain-trained** option. Choices, aligned to our "free/open first, compliant vendor for prod" preference:

| Option | Type | Fit |
|--------|------|-----|
| **Google Cloud MedASR / Chirp** | Google medical foundation ASR (open MedASR model + Chirp) | **Top pick** — same Google ecosystem as Gemini/Vertex, trained on clinical audio, MedASR weights are openly available. Natural fit given "always Google/Gemini." |
| **Amazon Transcribe Medical** | Managed API, HIPAA-eligible w/ BAA | Strong, scalable, specialty models; but adds AWS to the stack. |
| **AssemblyAI (Medical Mode)** | API w/ medical entity + diarization | Good developer API + built-in diarization. |
| **Corti** | Pure medical ASR, low latency | High accuracy/formatting; specialized. |
| **Augnito** | Healthcare voice AI, on-device/cloud | Strong security/EHR embedding. |
| **Whisper (open)** | Free, self-run | Only as a fallback/dev tool — high medical WER, so not for clinical prod alone. |

**Recommendation:** use **Google Cloud MedASR / Chirp** as primary — it keeps everything in Google's ecosystem (one vendor, one BAA, one data-residency story with Vertex/Gemini) and is purpose-trained on clinical audio. Keep the transcript interface abstract (from `01 §4`) so a different vendor can be swapped if needed.

**Must-haves regardless of vendor:**
- **Speaker diarization** (clinician vs patient turns).
- **Medical vocabulary** tuning.
- **BAA** signed for any cloud ASR touching PHI (`04 §1`).

---

## 5. Full stack summary

| Layer | Choice | Free/Open? | Notes |
|-------|--------|-----------|-------|
| Frontend | **Next.js** (App Router) | Open framework | Scalable UI; deploy on Cloud Run or Firebase Hosting (`10`) |
| Backend/API | **Node** on **Cloud Run** | Managed, pay-per-use | Autoscales, scales to zero (`07`) |
| ASR | Google MedASR / Chirp | MedASR weights open; cloud paid | Enable + call from backend (`08`) |
| NER | scispaCy + Med7 + medspaCy (custom BioClinicalBERT if needed) | Yes, all open | Python sidecar on Cloud Run, in-house |
| Generation | **Gemini via AI Studio API** (→ Vertex for PHI/prod) | Paid API | Only LLM; de-identify before AI Studio (see caveat above) |
| Data | **Firestore (Firebase)** | Managed, pay-per-use | Transcripts, notes, feedback, audit (`09`) |
| File storage | Cloud Storage (GCS) | Managed | Audio files if stored |
| Schema/validation | Our own code (JSON schema) | Yes | From `02` |
| Orchestration/eval | Our own code | Yes | From `01`, `03` |

**All-GCP, single-vendor.** Frontend, backend, ASR, LLM, and data all live in Google's ecosystem — one billing account, one ops surface. See `07`–`10` for setup guides.

**One line:** Google MedASR transcribes → open-source Python NER extracts the hard facts → Gemini writes the schema note grounded on those facts → we validate the note against the NER facts → clinician signs. All LLM work is Gemini; nothing self-hosted except the free NER models.

> This file overrides the earlier "self-hosted LoRA / vendor-swappable model" wording in `01`, `03`, `04`, `05`. Those files have been updated to match.
