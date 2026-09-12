// ─────────────────────────────────────────────────────────────────────────────
// dedupeNote — the FINAL no-duplicates pass over the assembled note.
//
// Runs last, after every composer/tightener/guardrail, so nothing downstream can
// reintroduce a repeat. It only ever REMOVES or MERGES existing text — it never
// rewrites a sentence or invents one, so it cannot change clinical meaning.
//
// What it fixes (the reported bug: on long transcripts the Assessment restates the
// same point in different words):
//   1. DUPLICATE PROBLEMS — the story engine / tightener can emit "Hypertension"
//      and "Elevated blood pressure" as two numbered A&P entries covering one
//      problem. They are merged into one, field by field.
//   2. CROSS-PROBLEM REPEATS — a point already made under problem 1 is dropped
//      from problem 3 (previously nothing compared two A&P entries to each other).
//   3. CROSS-FIELD REPEATS — a plan action echoed in both `assessment` and
//      `treatment_planned` stays only in the plan field, where it belongs.
//   4. A&P ↔ SUBJECTIVE/OBJECTIVE REPEATS — paraphrased retellings of the history
//      are dropped from the Assessment, while plan ACTIONS are always kept.
//   5. SECTION-INTERNAL REPEATS — paraphrases inside Subjective / PMH / Objective.
//
// Safety comes from textSimilarity's guards: conflicting numbers, conflicting
// drug/analyte names, and conflicting meaning markers (left/right, improving/
// worsening, start/stop, negated/affirmed) can never be merged.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { isPlanAction } from '../validation/clinicalPhrasing.js';
import { addsInformation, compareSignatures, conflictReason, dedupeList, moreInformative, signature } from '../validation/textSimilarity.js';

const splitLines = (v) => String(v == null ? '' : v).split('\n').map((x) => x.trim()).filter(Boolean);
// Sentence split that never breaks on abbreviations ("Dr.", "e.g.", "St.").
const splitSentences = (line) => String(line)
  .split(/(?<=[a-z0-9]{3}[.!?])\s+(?=[A-Z(])/)
  .map((s) => s.trim())
  .filter(Boolean);
const toUnits = (v) => splitLines(v).flatMap(splitSentences);


// Plan fields hold the actions; the assessment holds interpretation. When the same
// point appears in both, the plan field wins and the assessment copy goes.
const PLAN_FIELDS = ['treatment_planned', 'investigations_planned', 'referrals'];

/** Problem title/identity for one A&P entry. */
function problemTitle(p) {
  const isPlaceholder = (t) => !t || /^(?:issue|problem|point|dx|#)?\s*#?\d+\.?$/i.test(t);
  const issue = String(p?.issue || '').trim();
  const diag = String(p?.diagnosis || '').trim();
  return (!isPlaceholder(issue) ? issue : '') || diag || issue;
}

// Titles are short, so the fuzzy signals would fire on too little evidence. Require
// a strong containment/identity match instead, with all the meaning guards still active.
const TITLE_OPTS = { jaccard: 0.8, dice: 0.86, containment: 0.95, minTokens: 2 };

/** Union two A&P entries, keeping the more specific title and de-duplicated fields. */
function mergeProblems(keepP, dropP, log) {
  const keepTitle = problemTitle(keepP);
  const dropTitle = problemTitle(dropP);
  // The surviving entry keeps its own title — A&P order is clinical ranking, and the
  // first mention is the one the composer chose as the heading. Only a STRICTLY more
  // specific title takes over ("Anaemia" yielding to "Iron deficiency anaemia"); a mere
  // rewording must not demote a proper diagnosis to a descriptive phrase
  // ("Hypertension" → "Elevated blood pressure").
  const keepTokens = signature(keepTitle).tokens;
  const dropTokens = signature(dropTitle).tokens;
  const dropIsStrictlyMoreSpecific = dropTokens.size > keepTokens.size
    && [...keepTokens].every((t) => dropTokens.has(t));
  if (dropIsStrictlyMoreSpecific) keepP.issue = dropTitle;
  if (!String(keepP.diagnosis || '').trim() && String(dropP.diagnosis || '').trim()) keepP.diagnosis = dropP.diagnosis;

  for (const field of ['assessment', ...PLAN_FIELDS]) {
    const seen = [];
    const merged = dedupeList([...toUnits(keepP[field]), ...toUnits(dropP[field])], { seen });
    keepP[field] = merged.join('\n');
  }
  const diffs = [
    ...(Array.isArray(keepP.differential_diagnoses) ? keepP.differential_diagnoses : []),
    ...(Array.isArray(dropP.differential_diagnoses) ? dropP.differential_diagnoses : []),
  ];
  keepP.differential_diagnoses = dedupeList(diffs, { opts: TITLE_OPTS });
  log(`[dedupe] merged duplicate A&P problem "${dropTitle}" into "${keepTitle}"`
    + (dropIsStrictlyMoreSpecific ? ` (retitled to the more specific "${dropTitle}")` : ''));
}

/** 1. Collapse A&P entries that describe the same problem. */
function mergeDuplicateProblems(note, log) {
  const ap = note.assessment_and_plan;
  if (!Array.isArray(ap) || ap.length < 2) return 0;
  const kept = [];
  let merges = 0;
  for (const p of ap) {
    const title = problemTitle(p);
    const sig = title ? signature(title) : null;
    const match = sig && kept.find((k) => k.sig && compareSignatures(sig, k.sig, TITLE_OPTS).duplicate);
    if (match) {
      mergeProblems(match.problem, p, log);
      match.sig = signature(problemTitle(match.problem));
      merges += 1;
      continue;
    }
    kept.push({ problem: p, sig });
  }
  note.assessment_and_plan = kept.map((k) => k.problem);
  return merges;
}

/**
 * De-duplicate one field across every problem, keeping the first mention.
 *
 * Cross-problem comparison needs the PROBLEM as context: "Likely osteoarthritis" under
 * "Left knee pain" and the identical line under "Right knee pain" are two findings, not
 * one, and the lines alone carry nothing to tell them apart. So a match is only accepted
 * when the two problem titles are themselves compatible — if the titles conflict on
 * laterality, numbers, drugs or meaning, the lines are left alone.
 *
 * @param {Array} entries  [{ problem, titleSig, lines }]
 * @param {Array} extraSeen  signatures from other fields of the SAME problem (by index)
 */
function dedupeFieldAcrossProblems(entries, field, log, extraSeen = null) {
  let removed = 0;
  const seen = [];        // { sig, titleSig, slot, entryIndex }
  entries.forEach((entry, ei) => {
    if (entry.problem[field] == null) return;
    const kept = [];
    for (const line of toUnits(entry.problem[field])) {
      const sig = signature(line);
      // Same-problem echo from another field (a plan action restated in the narrative).
      const own = (extraSeen?.[ei] || []).find((s) => compareSignatures(sig, s).duplicate && !addsInformation(sig, s));
      if (own) {
        removed += 1;
        log(`[dedupe] dropped A&P ${field} line already stated in this problem's plan: "${line.slice(0, 90)}"`);
        continue;
      }
      const dup = seen.find((s) => {
        if (!compareSignatures(sig, s.sig).duplicate) return false;
        // Information-preservation guard: this line is kept if it names a drug, test or
        // number the earlier one does not. Without it, "Liver function tests and repeat
        // lipid panel in 3 months (combined with HbA1c)" was discarded as a duplicate of
        // "Repeat HbA1c in 3 months", silently dropping two orders.
        if (addsInformation(sig, s.sig)) return false;
        if (s.entryIndex === ei) return true;                       // same problem → always a repeat
        return !conflictReason(entry.titleSig, s.titleSig);         // different problems → titles must agree
      });
      if (dup) {
        removed += 1;
        log(`[dedupe] dropped repeated A&P ${field} line: "${line.slice(0, 90)}" (already stated as "${dup.sig.raw.slice(0, 60)}")`);
        continue;
      }
      seen.push({ sig, titleSig: entry.titleSig, slot: kept.length, entryIndex: ei });
      kept.push(line);
    }
    entry.problem[field] = kept.join('\n');
  });
  return removed;
}

/**
 * 2+3. De-duplicate A&P field content. Plan fields go first because they own the
 * actions; the assessment is then compared against its own problem's plan fields (so a
 * plan action echoed in the narrative stays only in the plan) and against every earlier
 * problem's assessment.
 */
function dedupeAssessmentAndPlan(note, log) {
  const ap = note.assessment_and_plan;
  if (!Array.isArray(ap) || !ap.length) return 0;
  const entries = ap.map((problem) => ({ problem, titleSig: signature(problemTitle(problem)) }));
  let removed = 0;

  for (const field of PLAN_FIELDS) removed += dedupeFieldAcrossProblems(entries, field, log);

  const ownPlan = ap.map((p) => PLAN_FIELDS.flatMap((f) => toUnits(p[f])).map((raw) => signature(raw)));
  removed += dedupeFieldAcrossProblems(entries, 'assessment', log, ownPlan);
  return removed;
}

/** 4. Drop Assessment lines that merely retell Subjective/Objective detail. */
function dropRetoldHistory(note, log) {
  const above = [];
  for (const section of [note.subjective, note.past_medical_history, note.objective]) {
    if (!section) continue;
    for (const v of Object.values(section)) {
      if (typeof v !== 'string') continue;
      for (const unit of toUnits(v)) above.push(signature(unit));
    }
  }
  if (!above.length) return 0;
  let removed = 0;
  for (const p of (note.assessment_and_plan || [])) {
    if (typeof p.assessment !== 'string') continue;
    const kept = [];
    for (const unit of toUnits(p.assessment)) {
      // A plan action always survives, even when it echoes a fact stated above.
      if (isPlanAction(unit)) { kept.push(unit); continue; }
      const sig = signature(unit);
      // Same information-preservation guard: an Assessment line that names a drug, test or
      // value the history above does not mention is adding something, not repeating.
      const dup = above.find((a) => compareSignatures(sig, a).duplicate && !addsInformation(sig, a));
      if (dup) {
        removed += 1;
        log(`[dedupe] dropped Assessment line already detailed above: "${unit.slice(0, 90)}"`);
        continue;
      }
      kept.push(unit);
    }
    p.assessment = kept.join('\n');
  }
  return removed;
}

/** 5. Paraphrase de-duplication inside one section, across all of its fields. */
function dedupeSection(section, label, log) {
  if (!section) return 0;
  let removed = 0;
  const seen = [];
  for (const key of Object.keys(section)) {
    if (typeof section[key] !== 'string') continue;
    const kept = dedupeList(toUnits(section[key]), {
      seen,
      keep: 'first',
      onDrop: (what, against) => {
        removed += 1;
        log(`[dedupe] dropped repeated ${label} line: "${String(what).slice(0, 90)}" (already stated as "${String(against).slice(0, 60)}")`);
      },
    });
    section[key] = kept.join('\n');
  }
  return removed;
}

/**
 * Remove every duplicate from an assembled note, in place.
 * @param {object} note  schema v2 note (mutated)
 * @param {{log?:Function}} [opts]
 * @returns {{merges:number, removed:number}}
 */
export function dedupeNote(note, opts = {}) {
  const log = opts.log || (() => {});
  if (!note) return { merges: 0, removed: 0 };

  const merges = mergeDuplicateProblems(note, log);
  // Snapshot every problem's content so de-duplication can never strip a problem down
  // to a bare heading: a distinct problem whose text happened to match another one's
  // keeps its own wording rather than rendering as an empty numbered item.
  const before = (note.assessment_and_plan || []).map((p) => ({
    problem: p,
    fields: Object.fromEntries(['assessment', ...PLAN_FIELDS].map((f) => [f, p[f]])),
    hadContent: ['assessment', ...PLAN_FIELDS].some((f) => String(p[f] || '').trim()),
  }));

  let removed = 0;
  removed += dedupeSection(note.subjective, 'Subjective', log);
  removed += dedupeSection(note.past_medical_history, 'PMH', log);
  removed += dedupeSection(note.objective, 'Objective', log);
  removed += dedupeAssessmentAndPlan(note, log);
  removed += dropRetoldHistory(note, log);

  let restored = 0;
  for (const snap of before) {
    if (!snap.hadContent) continue;
    if (['assessment', ...PLAN_FIELDS].some((f) => String(snap.problem[f] || '').trim())) continue;
    Object.assign(snap.problem, snap.fields);
    restored += 1;
    log(`[dedupe] restored "${problemTitle(snap.problem)}" — de-duplication had emptied it, so its own wording is kept`);
  }
  removed -= restored;

  if (merges || removed) log(`[dedupe] ${merges} duplicate problem(s) merged, ${removed} duplicate line(s) removed`);
  else log('[dedupe] no duplicates found');
  return { merges, removed };
}

export { problemTitle as _problemTitle };
