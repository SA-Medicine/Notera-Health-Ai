// ─────────────────────────────────────────────────────────────────────────────
// condenseNote — cross-section condenser (Agent 1).
//
// Intent: Subjective / Objective stay DETAILED (full description of the problem),
// but Assessment & Plan must be CONCISE. So any A&P narrative sentence that merely
// repeats — at the same level of detail — something already described above is
// dropped from A&P (the detail lives above; A&P keeps the unique diagnosis/plan).
// Also merges duplicate Objective content (exam findings that are identical to a
// completed-investigation line become one).
//
// Deterministic and grounded: it only REMOVES redundant text, never rewrites or
// invents. Similarity is measured on word sets (Jaccard + containment).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { isBledHistory, isPlanAction } from '../validation/clinicalPhrasing.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const splitLines = (v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean);
// sentence split that never breaks on abbreviations ("Dr.", "e.g.", "St.")
const splitSentences = (line) => String(line).split(/(?<=[a-z0-9]{3}[.!?])\s+(?=[A-Z(])/).map((s) => s.trim()).filter(Boolean);
const wordsOf = (s) => norm(s).split(' ').filter((w) => w.length > 2);
// Pertinent negatives ("No fever", "denies chest pain", "no chest pain, SOB") are clinically
// required and must survive de-dup even when the same topic word appears in the narrative
// above (e.g. HPI mentions "fever", Associated Symptoms says "No fever" — keep BOTH).
const isPertinentNegative = (s) => /(^|\b)(no|not|non|never|nil|none|neg|negative|without|absent|denies|denied|deny)\b/i.test(String(s || ''));

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
// how much of the SHORT set is covered by the LONG set (A&P sentence ⊂ a detailed line)
function containment(short, long) {
  if (!short.length) return 0;
  const L = new Set(long);
  let c = 0;
  for (const w of short) if (L.has(w)) c++;
  return c / short.length;
}

// Remove near-duplicate sentences WITHIN a section object (across its fields), keeping the
// first occurrence. Fixes "the Subjective repeats the same timeline in several sub-headings".
function dedupWithinSection(obj, threshold, log) {
  if (!obj) return 0;
  const seen = []; let removed = 0;
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] !== 'string') continue;
    const kept = [];
    for (const line of splitLines(obj[k])) {
      for (const s of splitSentences(line)) {
        const w = wordsOf(s);
        if (w.length < 4) { kept.push(s); continue; }
        // Never drop a pertinent negative, even if its topic appears in the story above.
        if (isPertinentNegative(s)) { seen.push(w); kept.push(s); continue; }
        const dup = seen.some((a) => jaccard(w, a) >= threshold || containment(w, a) >= 0.85);
        if (dup) { removed++; log(`[upgrade:condense] dropped duplicate sentence within a section: "${s.slice(0, 80)}"`); continue; }
        seen.push(w); kept.push(s);
      }
    }
    obj[k] = kept.join('\n');
  }
  return removed;
}

export function condenseNote(note, opts = {}, log = () => {}) {
  const simThreshold = opts.simThreshold ?? 0.55;
  const containThreshold = opts.containThreshold ?? 0.8;
  const withinThreshold = opts.withinThreshold ?? 0.6;
  if (!note) return { removed: 0, deduped: 0, withinRemoved: 0 };

  // 0) Remove intra-section repetition first (e.g. Subjective restating the timeline).
  let withinRemoved = 0;
  withinRemoved += dedupWithinSection(note.subjective, withinThreshold, log);
  withinRemoved += dedupWithinSection(note.past_medical_history, withinThreshold, log);
  withinRemoved += dedupWithinSection(note.objective, withinThreshold, log);
  for (const p of (note.assessment_and_plan || [])) {
    if (typeof p.assessment === 'string') {
      const box = { a: p.assessment };
      withinRemoved += dedupWithinSection(box, withinThreshold, log);
      p.assessment = box.a;
    }
  }

  // Is the history actually documented in the Subjective? If not, narrative sitting in a
  // plan field is the ONLY record of it and must not be removed.
  const subjectiveHasContent = Object.values(note.subjective || {})
    .some((v) => typeof v === 'string' && v.trim().length > 0);

  // 1) Collect the "above" (detailed) content as one word-set per sentence.
  const above = [];
  const collect = (obj) => {
    if (!obj) return;
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] !== 'string') continue;
      for (const line of splitLines(obj[k])) for (const s of splitSentences(line)) {
        const w = wordsOf(s);
        if (w.length >= 3) above.push(w);
      }
    }
  };
  collect(note.subjective);
  collect(note.past_medical_history);
  collect(note.objective);

  // 2) Condense each A&P assessment: drop sentences that repeat above detail.
  // A plan-ACTION verb marks a legitimate plan step (continue X, refer, order, RTC…) that must
  // NEVER be pruned even if it echoes a fact above — only pure narrative echoes are bleed.
  // isPlanAction / isBledHistory live in clinicalPhrasing.js — see the note there about
  // the trailing-\b bug that made every stem ("continu", "prescrib", "refer") unmatchable,
  // which silently disabled this guard.
  let removed = 0;
  for (const p of (note.assessment_and_plan || [])) {
    if (typeof p.assessment === 'string') {
      const kept = [];
      for (const line of splitLines(p.assessment)) {
        for (const s of splitSentences(line)) {
          const w = wordsOf(s);
          if (w.length < 4) { kept.push(s); continue; }   // keep short crisp points as-is
          const dup = above.some((a) => jaccard(w, a) >= simThreshold || containment(w, a) >= containThreshold);
          if (dup) { removed++; log(`[upgrade:condense] dropped redundant A&P sentence (already detailed above): "${s.slice(0, 90)}"`); continue; }
          kept.push(s);
        }
      }
      p.assessment = kept.join('\n');
    }
    // Subjective-narrative BLEED into the Plan. The composer regularly dumps history into
    // treatment_planned / investigations_planned / referrals, where it reads as the note
    // restating the same thing in different words ("Takes amlodipine 5 mg daily with good
    // adherence", "Headaches have returned over the last 3 weeks") next to the real orders.
    //
    // A line goes ONLY when it either duplicates history stated above, or positively reads
    // as patient history — and in both cases carries no plan-action verb. isBledHistory()
    // is two-sided for that reason, so a valid plan entry with no verb at all ("Paracetamol
    // 1 g PRN", "Kidney function and electrolytes") is never removed.
    //
    // Guarded by subjectiveHasContent: if the Subjective is empty, this text is the only
    // record of the history and removing it would lose clinical information outright.
    //
    // Sentence-split, not just newline-split: the tightener routinely returns a plan field
    // as ONE line holding several sentences, and the renderer sentence-splits it into
    // separate bullets afterwards. Checking whole lines meant a single action verb anywhere
    // in that blob ("Increase amlodipine…") protected every bled history sentence sitting
    // beside it, so the bleed survived into the rendered Plan.
    for (const fld of ['treatment_planned', 'investigations_planned', 'referrals']) {
      if (typeof p[fld] !== 'string') continue;
      const kept = [];
      for (const line of splitLines(p[fld]).flatMap(splitSentences)) {
        const w = wordsOf(line);
        if (isPlanAction(line)) { kept.push(line); continue; }          // a real order always stays
        // The short-line exemption applies only to the FUZZY duplicate test, where a tiny
        // word set makes Jaccard unreliable. It must not gate the narrative test, which is
        // already two-sided — that is how "Adherent to amlodipine 5 mg daily." (3 content
        // words) stayed in the Plan.
        const isDupe = w.length >= 4
          && above.some((a) => jaccard(w, a) >= simThreshold || containment(w, a) >= containThreshold);
        const isNarrative = subjectiveHasContent && isBledHistory(line);
        if (isDupe || isNarrative) { removed++; log(`[upgrade:condense] dropped subjective-narrative bleed from A&P ${fld}: "${line.slice(0, 90)}"`); continue; }
        kept.push(line);
      }
      p[fld] = kept.join('\n');
    }
  }

  // 3) Dedup Objective: an exam-finding line identical to a completed-investigation line → one.
  let deduped = 0;
  if (note.objective && typeof note.objective.examination === 'string') {
    const inv = splitLines(note.objective.completed_investigations).map((l) => wordsOf(l));
    const exam = splitLines(note.objective.examination).filter((line) => {
      const w = wordsOf(line);
      const dup = inv.some((iv) => jaccard(w, iv) >= 0.85 || containment(w, iv) >= 0.9);
      if (dup) { deduped++; return false; }
      return true;
    });
    note.objective.examination = exam.join('\n');
  }

  if (removed || deduped || withinRemoved) log(`[upgrade:condense] ${withinRemoved} intra-section duplicate(s) removed; ${removed} redundant A&P sentence(s) removed; ${deduped} duplicate exam/objective line(s) merged`);
  else log('[upgrade:condense] no redundancy found');
  return { removed, deduped, withinRemoved };
}
