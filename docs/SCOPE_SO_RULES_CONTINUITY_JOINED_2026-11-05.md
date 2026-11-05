# Subjective / Objective rules, topic continuity, joined lines (2026-11-05)

Owner request: (3) stop Subjective and Objective leaking into each other, with thorough rules; (4) make the Subjective read as continuous topic groups without headings; (5) scope the Heidi-style semicolon lines. "Do not degrade, only improve."
Style Spec v2 is locked, so everything below is built **around** the pipeline in shadow mode, and what needs a locked file is marked **UNLOCK**.

## 1. Subjective / Objective rules (built: `soGuard.js`, running in SHADOW since 2026-11-05)

| Section | Holds | Examples |
|---|---|---|
| Subjective | what the patient (or family) said or did | symptoms and their story, what was taken / not taken, habits, worries, what they tried, **readings taken at home**, "(patient reported)" values, their own account of past illness |
| Objective | what the clinician saw, examined, measured or reviewed in this visit | clinic vitals, examination findings, results of labs / imaging that were looked at |

| Rule | Action |
|---|---|
| O to S: Objective line is the patient's account (reports, denies, did not take, tried, at home, "(patient reported)", since returning, history, concerns) and has no exam / clinic-measurement / result marker | move to Subjective, under the topic with the most words in common (heading counts double), else at the end |
| S to O: Subjective line is an exam finding, clinic vital or test result, short (150 characters or less), with no patient-account marker, no history marker (previously, in 2018, family, surgery) and no story marker (worsened, by Sunday, started) | move to Objective (vitals into Vital Signs, else Examination) |
| Doctor's own action in Subjective ("Asked if...", "Discussed...", "Blood pressure check.", "Review iron...") | listed for review in `note.metadata.soGuard.review`, never moved (the structured plan has no safe slot) |
| Mixed line (both kinds of marker), neither kind, a pending / planned item, a medicine-dose statement | stays where it is |
| Safety | a line is only moved, never edited or dropped; if the set of lines would change, nothing moves (fail closed); a section is never emptied; no model call |

Modes: `SO_GUARD` unset = off, `shadow` = proposals only (production now), `1` = apply. **Applying needs the owner's go.**

Measured (read-only, stored notes): 120 latest notes, 25 proposed moves, 0 lines lost; Seema's 25 latest: 6 moves, all correct (abdominal exam and two results in Subjective; a "(patient reported)" weight, a home BP reading and a missed-medicine line in Objective). Two audit rounds removed 14 false positives (lab trends read as patient talk, "no swelling", "Awaiting biopsy results", "wheezing" as a symptom, a weight inside a story). A fresh 6-note live run (22 to 40 s per note, all lossless) still produced 4 questionable proposals under the first rules, which led to the third tightening; **shadow data from real notes is the next gate** before `SO_GUARD=1`.
Known limit: a "topic" such as Abdominal Exam can sit in Subjective with several lines; only lines that carry an exam marker move. The cleaner cure is the writer / story prompt (**UNLOCK**), not more patterns.

## 2. Continuity without headings (scoped, not built)

What the data says (Seema, 24 latest notes, stored structure):
- The story agent already orders lines by topic: 96.8 % of 248 Subjective lines sit in the topic that fits them best; none are stranded at the end. The "late lines land at the end" theory is **not** supported.
- The stored note has topic headings (2.7 per note), but `renderMarkdown.js` flattens them: the rendered Subjective is a plain bullet list, so the topic boundaries are invisible. That is why it does not "feel" continuous.
- 31 % of topics have a single line (median 2), 10 of 24 notes have opening lines with no topic.

Plan:
1. **Visible grouping without headings**: render each topic as its own run of bullets with a small gap between runs (a blank line in markdown, and a spacer in the copy module, which I already built for the plan). Needs `renderMarkdown.js` (**UNLOCK**) and a one-line change in `noteRender.ts` / `copyNote.ts`.
2. **Re-homing** of the few stray lines (3 %) with the same word-overlap placement `soGuard.js` uses, as another shadow proposal.
3. Success test: 30 gold notes + the 24 stored notes, no line lost, topics in the same order, 60 s rule unchanged (no model call).

## 3. Heidi-style joined lines (scoped, not built)

Heidi writes "Walking 10-12 miles daily during trip; initially difficult, improved by end of week". Ours: 10.3 Subjective lines per note against the doctors' median of 7; only 9 of 248 lines contain a semicolon even though `STORY_COMPACT` already asks the story agent to join.

Safe route:
1. A **joiner post-pass** (new file, unlocked layer like `relevanceFilter.js`): within one topic only, one short model call proposes which consecutive lines to join with a semicolon; wording is kept word for word, only the line break becomes "; " (first letter lower-cased).
2. Code check on every proposal: same words in the same order (a pure concatenation), same numbers / doses / negations, never across topics, never into a line longer than about 28 words, never when either line is protected (dose, vital, plan verb).
3. Shadow first (`JOIN_LINES=shadow`), then 5-6 note test, then owner go. Cost: one 1-2 s call in parallel with the last checks.
4. Expected effect: Subjective from about 10 to 7-8 lines without losing a fact; the copy-paste into the EHR also gets shorter.
Risk if skipped: none. Risk if rushed: joined lines hide a denial or a number; hence the concatenation-only rule.

## 4. Order of work and what I need from the owner

| Step | State |
|---|---|
| S/O guard shadow data from real notes (a few days) | running |
| Read `note.metadata.soGuard` on ~30 new notes, then decide `SO_GUARD=1` | next, owner go |
| Joiner post-pass in shadow | build next |
| Topic gaps in the rendered note and copy | needs **UNLOCK STYLE SPEC v1** for `renderMarkdown.js` |
| Writer / story prompt rule "exam findings never in Subjective" | needs **UNLOCK STYLE SPEC v1** |
