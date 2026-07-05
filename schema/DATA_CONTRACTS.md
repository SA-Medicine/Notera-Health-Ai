# Data Contracts

The three interfaces to freeze early (doc `01 §4`). Stable contracts let us swap
models, retrain, and change UIs without breaking the pipeline.

## 1. Transcript object

```jsonc
{
  "consult_id": "string",
  "specialty": "string",
  "note_type": "string",
  "turns": [{ "speaker": "clinician|patient|number", "text": "string", "ts": "number|null" }],
  "entities": [{ "type": "string", "text": "string", "span": [0, 0], "attrs": {} }], // ← NER layer
  "metadata": { "clinician_id": "string", "audio_uri": "string|null" }
}
```

## 2. Note schema

Versioned clinical-note structure — see `note.schema.v1.0.0.json`. Every generated
note MUST validate against it (`validateNote()` in `index.js`).

## 3. Feedback record

```jsonc
{
  "consult_id": "string",
  "model_version": "string",
  "draft_note": { /* schema-valid note */ },
  "final_note": { /* schema-valid note */ },
  "edits": { /* diff draft → final */ },
  "clinician_id": "string",
  "approved_at": "ISO-8601"
}
```

Every approved note + its transcript is a new `(transcript → gold note)` pair — the
training flywheel (doc `02 §8`, `03 §5`).

## Versioning rule

`schema_version` is bumped on any change. Old data is migrated or tagged, never
silently mixed. Data version ↔ schema version ↔ model version are tracked together
in the `models/` registry (doc `09 §2`).
