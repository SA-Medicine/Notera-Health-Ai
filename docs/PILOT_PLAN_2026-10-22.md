# Supervised pilot — training doctor (Style Spec v2) — one page

**Goal:** show on 30–50 real notes that the v2 notes can be signed with light edits and never carry a wrong drug, dose, side or result into a signed record. **Length:** 2 weeks. **Reviewer:** the training doctor (Studio reviewer account); the owner decides at the end.

## 1. Before day 1 (must be built; not in the app today)
The doctor-facing screen (`Scribe.tsx`) shows only the rendered note. The new "please check" flags are in the note data but **not displayed**, and the only banner after a note is "saved to history". Build first (≈ 1–2 h plus a web deploy):
* **Draft banner** above every note: *"Draft — read every line before you sign. Check drug names, doses, side and results."*
* **Check box** under it listing the flags: *Please check against the recording* (doubtful lines, amber), *Check the side* (amber), *Lines removed because the recording did not support them* (grey, collapsed). Nothing is hidden; flags never edit the note.

## 2. How she reviews (≤ 5 minutes per note)
1. Use Notera as usual on her own visits; each note appears in her **Studio queue** automatically, with the Style Spec check done and the AI review running in the background.
2. In Studio open the item: transcript/audio on one side, note on the other (evidence map).
3. Score **"Would I sign this as it is?" 1–5** (adapted PDQI-9 rubric) and tick the error types: *wrong drug/dose/side/result · missing plan or problem · invented · wrong place · too long*.
4. One free-text comment in her own words. Her edits in the app are captured as well (draft → final) and become **proposals**, never applied automatically.
5. Mix: ≥10 renewals, ≥10 chronic follow-ups, ≥10 new/acute, ≥5 physicals, ≥5 long consults. Record how many flags were useful vs noise.

## 3. Weekly review (30 min, owner + doctor, Friday)
| Number | Target | Action if missed |
|---|---|---|
| "Sign as is" (score ≥ 4) | ≥ 70 % | list top 3 causes → fix in the lab, A/B before deploy |
| Wrong drug / dose / side / result in a note | **0** | stop the pilot, find the cause |
| Missing plan or problem | 0 | stop |
| Notes needing a major rewrite | < 10 % | fix, re-measure |
| Flags the doctor found useful | ≥ 50 % | tune the grounding agent |
| Median time / failed notes (Monitor) | ≤ 40 s / 0 | check quota, 429s |
Also read the pending Studio proposals; the owner accepts or declines each. Spec changes only with the owner's instruction and the unlock phrase.

## 4. Safety and privacy
Real patient notes go only to the reviewer accounts in Studio (schema `studio`); nothing is published; no lab runs during clinic hours (shared Gemini quota). Kill switches on the VM: `GROUNDING=0`, `PLAN_SWEEP=0`, `ADVICE_LINES=0`, `QUALITY_GUARDS=0`, `ATTRIBUTION=0`.

## 5. End of pilot
Go for wider use only if two weeks pass with 0 wrong drug/dose/side/result and 0 missing plans, sign-as-is ≥ 70 %, and the doctor confirms the layout (Advice / Follow-up lines). Otherwise fix and repeat one more week.
