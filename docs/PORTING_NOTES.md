# Porting Notes — DAS prototype → Notera-Health-Ai

How the original prototype maps onto the production system, and what changed.

## What was ported unchanged

| Prototype (`extension/`) | Now (`Notera-Health-Ai/`) | Change |
|--------------------------|---------------------------|--------|
| `pipeline/` (86 files, `PipelineEngine` + agents/engines) | `backend/src/pipeline/` | **Copied verbatim.** No agent uses `chrome`/`window`/`document`/`localStorage`, and they use native `fetch`/`AbortController`, so they run on Node 20 unchanged. |
| `services/LLMService.js` (browser, key from `chrome.storage`) | `backend/src/services/LLMService.js` | Rewritten for Node: key from env/Secret Manager; adds a Vertex AI backend + model tiers behind the same `generateContent` contract. |
| `webapp/` (vanilla JS, direct Groq/Gemini from browser) | `web/` (Next.js App Router) | Rebuilt. Browser now talks only to Next.js server code → private backend. No keys/PHI in the browser. |
| `auto-tester/` (eval over `data_heidi`) | `eval/` + `data/` | Ported; retargeted at the backend pipeline; added schema-validity / coverage / med-grounding metrics and a dataset/tuning builder. |
| `data_heidi/*.txt` | `data/gold/*.txt` | Copied so the monorepo is self-contained. |

## What is new (the production wrapper)

- **Versioned schema** (`schema/note.schema.v1.0.0.json`) + AJV validator — the note is now a contract, not free text.
- **Structuring step** (`orchestrator/structureNote.js`) — maps the pipeline's rich note into schema JSON via Gemini structured output, with a deterministic heading-parser fallback.
- **De-identification** (`deid/`) — PHI redaction/pseudonymization + `deidMap` re-identify, so nothing PHI hits AI Studio.
- **Guardrails** (`validation/guardrails.js`) — schema validation + NER medication cross-check (the highest-harm error class) + missing/low-confidence flags.
- **NER sidecar** (`ner/`) — free scispaCy + Med7 + medspaCy, grounding + validation.
- **Firestore data layer** (`firestore/`) — consults/drafts/finals/feedback + append-only audit + locked-down `deidMap`; pluggable memory driver for dev.
- **Orchestrator** (`orchestrator/generateNote.js`) — wires all of the above into the doc-`01 §2` layered flow.

## Not touched

The original `planning/*.md` planning docs, `extension/`, `auto-tester/`, and `data_heidi/`
in the parent `DAS` folder are left exactly as they were — Notera-Health-Ai is a new,
self-contained monorepo beside them.

## Follow-ups (mapped to the roadmap, `planning/05_ROADMAP.md`)

- Wire Firebase Auth / Identity Platform into `web/` (currently a demo clinician id).
- Live status streaming (Firestore listener or poll) for the async note flow (`10 §5`).
- Custom BioClinicalBERT NER head if pre-trained models miss schema entities (`03 §3b`).
- Gemini supervised tuning on Vertex once prompt+NER+few-shot plateaus (`03 §4`, `05` Phase 4).
- Shadow-deploy / canary / model-registry promotion gate (`04 §4`).
