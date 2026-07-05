# 02 — Data Pipeline & Schema

The 2,000+ Heidi transcript↔note pairs are the whole reason this project can leapfrog. This file explains how to turn them into (a) a canonical output schema and (b) a clean, trainable dataset.

---

## 1. What we have

- **~2,000+ pairs**, each = `(consult transcript, gold clinical note)`.
- The gold notes are trusted (produced/validated through Heidi), so they're a strong supervision target.
- Likely metadata available per pair: specialty, note type, maybe clinician and date.

This is a **supervised fine-tuning + evaluation dataset** waiting to be structured. Treat it as the crown jewel: version it, back it up, never train on it without a held-out test split.

---

## 2. Step 1 — Audit the raw data

Before anything, understand what's actually in the 2k pairs. Produce a data-audit report answering:

- How many pairs, across how many specialties / note types?
- What sections consistently appear in the gold notes? (HPI, ROS, Exam, Assessment, Plan, etc.)
- How long are transcripts and notes (token distributions)?
- How much PHI is present, and in what forms (names, DOBs, MRNs, addresses)?
- How consistent is formatting between notes? (Consistency = easier schema.)
- Are there duplicates, empty notes, or obviously broken pairs?

Output: a short `data_audit.md` + a spreadsheet of per-pair stats. This drives every downstream decision.

---

## 3. Step 2 — Design the canonical note schema

Instead of inventing a schema, **derive it from what the gold notes already do**. Cluster the sections that recur across the 2k notes; the common structure *is* your schema.

A typical clinical-note schema (SOAP-derived) as a versioned JSON spec:

```json
{
  "schema_version": "1.0.0",
  "note_type": "consultation",
  "specialty": "string",
  "subjective": {
    "chief_complaint": "string",
    "history_of_present_illness": "string",
    "review_of_systems": "string | null",
    "past_medical_history": "string | null",
    "medications": ["string"],
    "allergies": ["string"],
    "social_history": "string | null",
    "family_history": "string | null"
  },
  "objective": {
    "vitals": { "bp": "string|null", "hr": "string|null", "temp": "string|null", "other": "string|null" },
    "examination": "string",
    "investigations": "string | null"
  },
  "assessment": {
    "impression": "string",
    "differentials": ["string"]
  },
  "plan": {
    "management": "string",
    "medications_prescribed": ["string"],
    "follow_up": "string | null",
    "referrals": ["string"],
    "safety_netting": "string | null"
  },
  "metadata": {
    "generated_by": "model_version",
    "confidence": { "per_section": "0-1" }
  }
}
```

Design rules:

- **Every field must be justifiable from the gold notes.** If no gold note fills a field, don't add it yet.
- **Make optional what's genuinely optional.** Nulls are fine; forcing sections invites hallucination.
- **Version it (`schema_version`).** When it changes, old data is migrated or tagged, never silently mixed.
- **Support specialty variants.** A base schema + per-specialty extensions beats one giant schema.

`[DECIDE]` Single universal schema vs base + specialty extensions. Recommendation: base + extensions.

---

## 4. Step 3 — Convert gold notes into the schema (labeling)

The gold notes are probably semi-structured free text, not JSON. We need to **parse each gold note into the schema** to create clean `(transcript → structured note)` training targets. Options, cheapest-first:

1. **Rule/heading parsing.** If notes use consistent headers, regex/heading-split most of the way there.
2. **LLM-assisted structuring.** Use a strong model to map each free-text gold note into the schema, then spot-check. This is legitimate: the *content* is human-gold; we're only reshaping it.
3. **Human correction pass.** Sample a few hundred, have a clinician/reviewer fix the structured version. These become the highest-trust anchors.

Output: `2000 × {transcript, structured_note(schema v1.0.0)}`.

> Important: keep the original free-text gold note too. If the schema changes, you re-derive from the original, not from a lossy conversion.

---

## 5. Step 4 — De-identify (PHI handling)

Before this data is used for training, logging, or shared with any external training service, PHI must be handled. Two modes:

- **Redaction:** replace PHI with tags (`[NAME]`, `[DOB]`, `[MRN]`). Safest; may hurt realism slightly.
- **Consistent pseudonymization:** replace with fake-but-consistent values so the model still learns natural phrasing.

Detect: names, dates, ages > 89, MRNs, phone, address, email, IDs, geographic detail. `[DECIDE]` PHI tooling (buy a de-id API vs own NER). See `04` for the legal framing — this is non-negotiable if any data leaves our controlled environment.

---

## 6. Step 5 — Split the data (do this before training)

- **Train / validation / test split**, e.g. 80 / 10 / 10.
- **Stratify** by specialty and note type so every split is representative.
- **Freeze the test set** and never train on it. It's your honest measure forever.
- Consider a small **"golden" eval set** (~100 pairs) hand-verified by a clinician — the canary for regressions.
- Watch for **leakage:** same patient/encounter appearing in both train and test.

---

## 7. Step 6 — Build the training file format

For supervised fine-tuning, each example becomes an instruction-style record. Example (chat format):

```json
{
  "messages": [
    {"role": "system", "content": "You are a clinical documentation assistant. Produce a note that strictly matches schema v1.0.0."},
    {"role": "user", "content": "<specialty> <note_type>\nTranscript:\n<clean transcript>"},
    {"role": "assistant", "content": "<structured note as JSON matching schema v1.0.0>"}
  ]
}
```

Keep a generator script that rebuilds these files from the source dataset + current schema version, so regenerating for a new schema is one command.

---

## 8. The data flywheel (why this compounds)

Every note a clinician approves in production is a **new gold pair**:

```
transcript → model draft → clinician edits → approved note
                                   │
                                   ▼
                    new (transcript → approved note) pair
                                   │
                                   ▼
                append to dataset → periodic retrain (see 03)
```

We start with 2k. Within months of production use, the dataset grows itself — and the *edits* specifically tell us exactly where the model is weak. This is the moat: nobody else has our transcripts, our schema, and our edit history.

---

## 9. Data governance checklist

- [ ] Raw pairs stored encrypted, access-controlled, backed up.
- [ ] Original gold notes preserved alongside structured versions.
- [ ] PHI de-identified before any training/logging use.
- [ ] Train/val/test split frozen and documented.
- [ ] Dataset versioned (data version ↔ schema version ↔ model version).
- [ ] Consent/legal basis for using consult data confirmed (see `04`). `[DECIDE]`

> Next: `03_TRAINING_AND_IMPROVEMENT.md` — how we actually train and keep improving the model.
