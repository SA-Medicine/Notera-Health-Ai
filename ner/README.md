# NER Sidecar

Free/open Python medical NER (doc `06 §3`). Extracts the hard facts — medications,
doses, diagnoses, allergies — that ground Gemini's prompt and validate its output.
Runs in-house so **no PHI leaves this service** (doc `04 §1`).

## Models

| Source | Model | Extracts |
|--------|-------|----------|
| Med7 | `en_core_med7_lg` | drug, dose, strength, form, frequency, route, duration |
| scispaCy | `en_ner_bc5cdr_md` | diseases + chemicals/drugs |
| medspaCy | ConText | negation ("denies chest pain") + section context |

All optional at runtime — the service boots and degrades gracefully if a model
wheel is missing (returns fewer entities, never 500s).

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# (optional) install the model wheels listed in requirements.txt / Dockerfile
uvicorn main:app --host 0.0.0.0 --port 8000
```

## API

```
GET  /healthz  → { ok, models_loaded }
POST /ner      → { entities: [{text,label,start,end,source,negated}], models_loaded }
     body: { "text": "..." }
```

## Deploy (Cloud Run, private)

See `../deploy/deploy-all.sh`. Give it 2Gi memory and keep it private — only the
backend service account may invoke it (doc `07 §4`/§5).
