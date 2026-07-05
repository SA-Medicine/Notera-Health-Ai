# Master Plan — AI Medical Scribe System

> **One-line vision:** Turn 2,000+ real consult transcripts and their gold-standard Heidi notes into a proprietary, self-improving clinical documentation engine that our company owns end-to-end — accurate, compliant, and cheaper to run at scale than a generic prompted API.

---

## 1. What this document set is

This is the complete plan for taking the current medical-scribe system from a **prompted-API prototype** to a **production, industry-ready, deployed product** running for the company. It is split into six files so each concern stays readable:

| File | What it covers |
|------|----------------|
| `00_MASTER_PLAN.md` (this file) | Vision, goals, current vs target state, how the pieces fit |
| `01_ARCHITECTURE.md` | How the system works today and the target architecture |
| `02_DATA_PIPELINE_AND_SCHEMA.md` | The 2k transcript↔note pairs, the output schema, data cleaning |
| `03_TRAINING_AND_IMPROVEMENT.md` | Back-training / fine-tuning methods, evals, the feedback loop |
| `04_DEPLOYMENT_AND_SCALING.md` | Production infra, HIPAA/privacy, monitoring, scaling |
| `05_ROADMAP.md` | Phased milestones, timeline, cost, risks |
| `06_TECH_STACK.md` | **Concrete tools: Gemini API + open-source Python NER + medical ASR** |
| `07_SETUP_CLOUD_RUN.md` | Init + deploy Node backend and Python NER sidecar on Cloud Run |
| `08_SETUP_ASR.md` | Enable and call medical speech-to-text |
| `09_SETUP_FIRESTORE.md` | Firestore data model, security, audit log |
| `10_NEXTJS_FRONTEND.md` | Scalable Next.js UI + full deployed architecture |

> **Stack decision (locked):** all-GCP, single vendor. **Next.js** frontend + **Node backend on Cloud Run** + **Python NER sidecar on Cloud Run** + **medical ASR** + **Gemini via Google AI Studio API** (→ Vertex AI for PHI/tuning) + **Firestore** data. We do **not** host our own LLM; the only ML we self-run is the free open-source NER. See `06_TECH_STACK.md` and the setup guides `07`–`10`.
>
> ⚠️ **One compliance rule:** the AI Studio Gemini API is not HIPAA/BAA-covered, so we **de-identify before the Gemini call** and re-insert identifiers afterward, or migrate that hop to Vertex AI for full PHI production. Details in `04` and `06`.

Read them in order. This file is the map; the rest are the territory.

---

## 2. The problem we're solving

Clinicians spend a large share of their day writing notes. A medical scribe system listens to (or ingests a transcript of) a patient consult and produces a **structured clinical note** — history of present illness, examination, assessment, plan, etc.

Right now we get that output by **prompting a hosted LLM** (GPT/Claude-class). That works, but it has four structural weaknesses:

1. **We don't own the quality.** Output changes when the vendor changes the model. We can't guarantee consistency.
2. **Cost scales linearly with usage.** Every note is a full API call with a long prompt. At company scale that gets expensive fast.
3. **The schema is implicit.** The "shape" of a good note lives inside a prompt, not in a spec we control and can version.
4. **We're not learning from our own data.** We have 2,000+ transcript→note pairs that are effectively free training signal, and we're currently throwing that signal away.

The whole plan is about fixing those four things.

---

## 3. The core idea ("back-training")

We already have the single most valuable asset in this domain: **2,000+ pairs of `(consult transcript → ideal clinical note)`**, where the ideal note was produced/validated through Heidi and is trusted as gold-standard.

That is a ready-made **supervised dataset**. Each pair is:

```
INPUT:  the raw consult transcript (+ any context: specialty, note type)
OUTPUT: the gold clinical note in our target schema
```

"Back-training" here means: **use these historical pairs to teach a model our exact house style and schema**, instead of describing that style in a prompt every time. Two complementary tracks:

- **Track A — Design a canonical schema** from what the gold notes actually contain (see `02`).
- **Track B — Train a model to hit that schema** via fine-tuning + evaluation (see `03`).

This converts institutional knowledge that currently lives in prompts and human reviewers into a durable, versioned model asset.

---

## 4. Current state vs target state

| Dimension | Current (prototype) | Target (production) |
|-----------|--------------------|--------------------|
| Model | Gemini via prompt only | Gemini + NER-grounded prompt (+ optional Gemini supervised tuning) |
| Output shape | Implicit, lives in prompt | Explicit versioned JSON schema |
| Quality control | Eyeballing | Automated eval suite + human-in-the-loop review |
| Data usage | Pairs unused | Pairs power training + eval + continuous learning |
| Cost per note | High (long prompt, big model) | Lower (NER pre-extraction, cached context, right-sized Gemini tier) |
| Compliance | Ad-hoc | HIPAA-aligned, auditable, PHI-controlled |
| Deployment | Manual / notebook | CI/CD, monitored, on-call, scalable |

---

## 5. Guiding principles

1. **Schema first.** Nothing trains well against a fuzzy target. We define the note schema before we train anything.
2. **Evaluate before you optimize.** We build the eval harness early so every change is measurable, not vibes.
3. **Human-in-the-loop, always.** A clinician signs off. The model drafts; it never has final authority over a medical record.
4. **Privacy is a feature, not a checkbox.** PHI handling is designed in from day one (see `04`).
5. **Gemini is the LLM; keep the *rest* modular.** We commit to Gemini for generation, but the ASR and NER layers sit behind clean interfaces so they can be swapped without a rewrite.
6. **Ship in phases.** Each phase in `05` delivers something usable, not a big-bang launch.

---

## 6. Success metrics (what "working" means)

- **Note quality:** ≥ X% of generated notes accepted by clinicians with no or minor edits (target the metric in `03`).
- **Edit distance:** downward trend in average human edits per note over time.
- **Latency:** note generated within the clinician's expected wait (e.g. < 20s for a standard consult).
- **Cost:** measured $/note trending down as we move off pure prompting.
- **Safety:** zero unreviewed notes entering the medical record; PHI never leaves approved boundaries.

---

## 7. How to use this plan

- If you're an engineer: start at `01`, then `02` and `03`.
- If you're planning resourcing/timeline: go to `05`.
- If you're handling compliance/security: go to `04`.
- Anything marked **`[DECIDE]`** in the other files is an open decision that needs an owner and a date.

> This is a living plan. Version it in git alongside the code. When reality diverges from the plan, update the plan.
