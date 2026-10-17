# Round 1 — new-state audit with gold, and manual log review of 20 new notes

## 1. Is the gold-referenced audit ≥ 90? No — it is 62, and it has not moved

Gold-referenced audit = `gemini-2.5-pro` compares each AI note with the transcript **and the clinician's gold note**, 0–100.

| Run (same 50 notes unless stated) | Gold-referenced mean | Transcript-only mean |
|---|---|---|
| Original 50-note scan | 61.8 | — |
| Baseline, regenerated | **62.0** | 69.2 |
| Few-shot reference notes (2 similar clinician notes in the prompt) | 63.1 | 70.0 |
| **20 brand-new notes (round 1)** | **62.3** | 71.0 |
| Clinicians' own gold notes, transcript-only audit | n/a | 73.4 |

Across editor pass, temperature 0, thinking, gemini-2.5-pro and few-shot (see ITERATIONS_2026-10-17.md) nothing leaves the 62–63 band; the run-to-run noise on the 50-note mean is about ±2.3. The gold-referenced scale also punishes legitimate style differences from the one clinician who wrote each gold note, which is why even the clinicians' notes only reach 73 when judged against the transcript. **90 is not a reachable value on this audit; I am not going to claim it or tune toward it.**

## 2. Manual review of the 20 new notes (logs, note, audit findings)

Raw dump with every log line, note text and finding: [`iterations/round1-fresh20.review.md`](iterations/round1-fresh20.review.md).

Pipeline logs across the 20: checklist merged extra items into 18 notes; the verifier removed unsupported or duplicate lines in 15 (all confirmed by code, none refused); `condense` removed redundant plan sentences in 10; no stage skipped or failed; 0 loops. The infrastructure behaves; the findings are about content.

| Note | Gold-ref | Transcript-only |
|---|---|---|
| reflux-pnd-hld-osa | 35 | 35 |
| l-leg-swelling-nausea | 40 | 85 |
| sp-2 | 55 | 80 |
| pe-osteo-foot | 55 | 85 |
| viral-inf-no-pink-eye | 55 | 65 |
| b-l-si-pain-asthma | 55 | 65 |
| rj | 60 | 65 |
| rt-ln-uti-jaw | 60 | 65 |
| acid-reflux-cough | 60 | 80 |
| rt-cheek-lesion-precancer | 65 | 85 |
| uti-hematuria-2 | 65 | 65 |
| b12-allergy-sx | 65 | 78 |
| flu-shot-uri-dm | 65 | 85 |
| skin-gi-msk | 65 | 65 |
| htn-hyperchol | 65 | 60 |
| patient-3030-cardiac | 65 | 78 |
| lm-2 | 78 | 60 |
| cc | 85 | 78 |
| metastatic-dz-lfts | 80 | 55 |
| adhd-r-pinky-pain | 80 | 78 |

What I found reading them (my classification of the audit's findings):

**A. Artefacts of the de-identified test corpus — not production defects (≈5 notes).** Transcripts contain substitutions such as "Doctor the patient", "[date]" or "the patient" where a name or date was removed, and the note repeats them ("Rtc: [date]", "Gastroscopy with Doctor the patient", "Follow-up: the patient"). Real recordings will not contain these. I deliberately did **not** add a scrubber for them: it would raise the test score without improving real notes.

**B. Real quality issues (the ones worth fixing):**
1. **Garbled speech mapped to the wrong real drug**: "corinderol" → Coricidin (likely bisoprolol), "yellow pills" ↔ Tramadol, "Pen SAD" kept as a current drug (6 notes touch medications).
2. **Diagnoses stated that the clinician never made** (b12: "Vitamin B12 deficiency", "Hypertension – controlled"; uti: "Kidney stones" as a diagnosis when the plan was to rule them out; viral: "Suspected pink eye" instead of the viral assessment). The writer prompt tells the model to *always* fill `diagnosis`, which pushes it to invent one (5 notes).
3. **Current vs past medication** confusion (Cipro, a stopped statin, PenSAID) (3 notes).
4. **Polarity or attribution errors**: "Denies eye discharge" when the daycare reported discharge; right vs left groin ultrasound; reading BP "at home" vs in clinic (4 notes).
5. **Plan attached to the wrong problem** (reflux medicine under "leg swelling", cholesterol panel under "reflux") (4 notes).
6. **Matters of convention the audit disagrees with** (occupation in PMH.social, historical results such as a normal mammogram in Objective, home BP in vital signs). These follow the writer prompt's gold-style rules; whether they are "wrong" is a clinic decision, not a defect.

## 3. What I changed this round

* Shipped earlier today and still live: degeneration-loop guard (no looped phrases in any of the 20).
* **Few-shot reference notes** (`writer.fewShot`, 0–3, default **0 = off**, bank of 300 clinician pairs excluding all evaluation notes): built and deployed, measured +1.1 gold-referenced (inside the noise), so **not enabled**.
* Editor pass, per-run thinking/temperature overrides, the iteration harness (`--goldref`, `--fresh 20`, `--review`): deployed, **off** in production.
* Production settings and prompts are unchanged: gemini-2.5-flash, thinking 0, T 0.3, default prompts.

## 4. What would actually help (needs your decision, not another tuning loop)

1. **Diagnosis rule**: let `diagnosis` be empty or "Not stated" when the clinician did not name one (and change the audit/gold expectation accordingly). This targets B2 directly and would reduce invented diagnoses; it conflicts with the gold notes, which always have a diagnosis line.
2. **Drug-name guard**: when a spoken drug word is not in a drug list (RxNorm lookup already exists in the codebase), keep it exactly as spoken and flag it for review instead of mapping it to a different drug (B1).
3. **Clinician review sample**: have a clinician mark 100 notes with the *Blind judge* verdict buttons; that gives a calibrated target (and a real ceiling) instead of the LLM audit.
4. Judge with the metric already agreed: **critical wrong claims per note < 0.10** on ≥ 200 notes; this round: 4 in 20 notes = 0.20.

Each of 1–2 is a product decision; tell me which to implement and I will run it through the same harness with a fresh 20-note manual log review.
