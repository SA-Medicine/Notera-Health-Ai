# 04 — Deployment, Compliance & Scaling

Getting from "it runs on my machine" to "it runs for the company, safely, at scale." In healthcare, compliance is not optional and it's not last — it's a design input.

> **Not legal advice.** This section describes the technical and organizational controls typically required. Confirm the specifics with a qualified healthcare-privacy lawyer for your jurisdiction(s) before handling real patient data.

---

## 1. Compliance first (because it constrains everything else)

Patient consult data is **Protected Health Information (PHI)**. Depending on where you operate, the relevant regimes include **HIPAA (US)**, **GDPR + local health-data law (EU/UK)**, and others (e.g. Australia's Privacy Act if that's your market). Core obligations that shape the architecture:

- **Minimum necessary:** only process the PHI you actually need.
- **Encryption:** in transit (TLS) and at rest (disk/db encryption).
- **Access control:** role-based, least-privilege, audited.
- **Audit logging:** who accessed/changed what, when — immutable.
- **Business Associate Agreements (BAAs):** any vendor that touches PHI (ASR, Gemini/Vertex AI, cloud, tuning) must sign one. **If a vendor won't sign a BAA, PHI cannot go to them.** For us this means Gemini must be used via **Google Cloud Vertex AI under a BAA** (not a consumer Gemini endpoint), and ASR must be BAA-covered too.
- **Data residency:** PHI may be legally required to stay in-region.
- **Right to deletion / retention limits:** be able to delete a patient's data and enforce retention policies.
- **Consent / legal basis:** confirm you have the right to use consult recordings for documentation *and* for model training. These can be different permissions. `[DECIDE]`

**Practical implication (our stack):** everything is **all-GCP** — Next.js + Node backend on **Cloud Run**, **Firestore** for data, **MedASR** for speech, **Gemini** for generation. NER runs in-house (Python sidecar), so entity extraction never leaves our service.

> ⚠️ **AI Studio vs Vertex AI — the one compliance gotcha.** We're calling Gemini via the **AI Studio API**, which is **not HIPAA-eligible / not under a BAA**. So the rule is: **no raw PHI to the AI Studio endpoint.** Mitigation, which our pipeline already supports:
> - De-identify the transcript (and NER entities) **before** the Gemini call (`02 §5`).
> - Gemini writes the note from de-identified text.
> - Re-insert identifiers (name, DOB, MRN) into the final note **inside our own systems**, after generation.
>
> Firestore, Cloud Run, MedASR, and GCS **can** be covered by a Google Cloud BAA — so PHI at rest and PHI in ASR is fine; only the AI Studio LLM hop must stay de-identified. **For full production at scale, migrate the Gemini call to Vertex AI under the BAA** (same models/prompts) so you can send PHI directly if a de-identify/re-identify step proves lossy. `[DECIDE]`

---

## 2. Environments & data separation

- **Dev / staging / prod** separated. No real PHI in dev — use de-identified or synthetic data.
- **Training environment** isolated, with de-identified data only where possible.
- **Secrets management** (keys, tokens) in a vault, never in code or notebooks.
- **PHI boundary** clearly drawn: know exactly which systems can see raw PHI and lock the rest out.

---

## 3. Serving the model in production

**Generation = Gemini (AI Studio API now → Vertex for prod).** We don't run GPUs for the LLM — Google serves it. Our Cloud Run backend calls Gemini behind our own generation interface (`01 §3`).

- **AI Studio now:** API-key call, de-identified input only (see caveat above). Store the key in **Secret Manager**, never in code.
- **Model tiers:** Gemini Pro-tier for final notes; Flash-tier for cheap high-volume or first-draft passes.
- **Vertex later:** for tuning + full PHI production, swap the endpoint to Vertex AI under the BAA — same models/prompts.
- **Fallback:** on Gemini error/timeout, retry, drop to a lower tier, or queue — never drop a transcript.

**App + NER serving = Cloud Run.** The Node backend and the Python NER sidecar (scispaCy/Med7/medspaCy) both run as Cloud Run services — autoscaling, scale-to-zero, no VMs. NER is the only ML we self-run and it keeps PHI in-house. Setup in `07`.

**Data = Firestore.** Transcripts, entities, drafts, final notes, feedback, and audit log live in Firestore (`09`); audio files (if kept) in GCS. Both BAA-eligible on Google Cloud.

**General serving concerns:**
- Async job model: transcript in → job queued → note ready → notify. Don't block the clinician's UI on a slow model.
- Idempotency + retries: a retried consult must not create duplicate notes.
- Timeouts + graceful degradation everywhere.

---

## 4. Reliability & operations (MLOps)

- **CI/CD** for both code and models. Model promotion goes through the eval gate from `03`.
- **Model registry:** every deployed model versioned, with its data version, schema version, and eval scorecard attached.
- **Shadow deployment:** run a candidate model silently alongside the champion on live traffic; compare before promoting.
- **A/B testing / canary:** route a small % of traffic to the new model; watch acceptance rate and error flags.
- **Rollback:** one command to revert to the previous champion. Always possible.
- **On-call / incident process:** who gets paged when generation fails or quality drops.

---

## 5. Monitoring & observability

Track three layers continuously:

**System health:** latency (p50/p95/p99), error rate, throughput, GPU/CPU utilization, queue depth, cost per note.

**Model quality (live):**
- acceptance rate and edit distance trends (the real quality signal),
- schema-validation failure rate,
- guardrail trigger rate (hallucination flags, missing sections),
- drift: are incoming transcripts shifting away from the training distribution?

**Safety:** any clinically significant error must be logged, alerted, and reviewed. Trend it to zero.

Dashboards + alerts on all three. A silent quality regression in a medical system is the nightmare case — instrument against it.

---

## 6. Security

- TLS everywhere; encrypted storage.
- RBAC + SSO; least privilege; regular access reviews.
- Full audit trail of PHI access and note changes.
- Pen-testing / security review before go-live and periodically.
- Prompt-injection defense: transcripts are untrusted input — the model must not follow instructions embedded in a transcript.
- Vendor security review + signed BAAs for every PHI-touching dependency.

---

## 7. Scaling to company-wide use

Scaling isn't only servers — it's people and process:

- **Throughput:** autoscale inference; batch; cache where safe. Load-test before rollout.
- **Multi-specialty / multi-site:** the base-schema + extension design (from `02`) is what lets you add specialties without a rewrite.
- **Onboarding clinicians:** training, a feedback channel, and a clear "the model drafts, you decide" message. Adoption depends on trust.
- **Cost model:** track $/note. Unit economics improve by (a) NER pre-extraction + Gemini tuning shortening prompts, (b) using a Flash-tier Gemini for first drafts/high-volume, and (c) caching. Quantify each.
- **Support & SLAs:** define uptime and response commitments as internal users depend on it.
- **Change management:** schema/model changes are announced, versioned, and reversible.

---

## 8. Go-live readiness checklist

- [ ] Legal basis + consent for documentation and training confirmed.
- [ ] Google Cloud BAA signed (covers Gemini/Vertex AI + MedASR); NER kept in-house.
- [ ] Encryption in transit + at rest verified.
- [ ] RBAC, SSO, audit logging live.
- [ ] De-identification validated on real samples.
- [ ] Eval gate + golden set passing; champion model chosen.
- [ ] Human sign-off enforced — no note auto-finalizes.
- [ ] Monitoring, alerting, on-call in place.
- [ ] Rollback tested.
- [ ] Load test passed at expected peak volume.
- [ ] Incident + data-breach response plan documented.

> Next: `05_ROADMAP.md` — how this sequences into phases with milestones, cost, and risk.
