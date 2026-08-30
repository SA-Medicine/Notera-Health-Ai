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
  const ACTION_RX = /\b(continu|start|start(?:ed|ing)?|initiat|increas|decreas|titrat|refer|referral|order|arrang|schedul|rtc|return|follow.?up|monitor|repeat|x-?ray|ultrasound|mri|\bct\b|prescrib|renew|refill|advis|counsel|educat|await|review|discontinu|\bstop\b|\bhold\b|switch|trial|sampl|inject|vaccinat|consider|recommend|plan|await)\b/i;
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
    // Subjective-narrative BLEED into the Plan: drop a treatment line ONLY when it echoes history
    // already stated above AND carries no plan-action verb (so "Continue Amlodipine 5mg", "Refer
    // to ENT", "RTC 2 weeks" are always preserved — only duplicated HPI narrative is removed).
    if (typeof p.treatment_planned === 'string') {
      const kept = [];
      for (const line of splitLines(p.treatment_planned)) {
        const w = wordsOf(line);
        const isBleed = w.length >= 4 && !ACTION_RX.test(line) &&
          above.some((a) => jaccard(w, a) >= simThreshold || containment(w, a) >= containThreshold);
        if (isBleed) { removed++; log(`[upgrade:condense] dropped subjective-narrative bleed from A&P treatment: "${line.slice(0, 90)}"`); continue; }
        kept.push(line);
      }
      p.treatment_planned = kept.join('\n');
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
