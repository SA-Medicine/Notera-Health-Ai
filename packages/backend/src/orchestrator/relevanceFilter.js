// Relevance filter (2026-11-04, from the owner's Malta-trip audit: a visit that was mostly storytelling gave a 24-bullet Subjective and 6 of 10 PMH lines nobody needs).
// Finds Subjective and Past Medical History lines that are personal or social narrative with no bearing on the visit, and proposes to remove them.
//   * One short model call on the note lines only (not the transcript), run in parallel with the last checks, so it adds no time.
//   * A code veto sits on top: a line that carries a dose, a number with a unit, a blood pressure, a test, a vaccine, a drug, a diagnosis, a symptom word, a plan verb
//     or a social-history item (smoking, alcohol, work, living situation) is NEVER removed, whatever the model says.
//   * Modes (env RELEVANCE_FILTER): unset = off; "shadow" = the proposal is stored in note.metadata.relevance and logged, the note is NOT changed; "1" = the lines are removed.
// Pure addition around the pipeline: it only reads the finished note. Nothing is invented, nothing is reworded.
'use strict';

export const RELEVANCE_SYS = `You review the Subjective and Past Medical History lines of a finished clinic note and mark the lines a doctor does NOT need in a medical record.
A line is NOT needed when it is personal or social narrative that has no bearing on the patient's symptoms, diagnoses, medicines, risks, daily function, the reason for the visit or the plan.
REMOVE these:
- stories and feelings about a trip, a family event, a house, a reunion, a celebration, a hobby; how people met; where relatives were born or lived; what relatives did or said; scenery, food, weather
- details about other people (a relative's or companion's own illness, job or story) that do not change this patient's care
- family or personal "history" that names no condition, no cause of death and no risk (for example "mother died 59 years ago", "father is from Holland")
- chat that only fills the visit (thanks, compliments, "feels like a puppy")
KEEP these (when in doubt, KEEP):
- every symptom with its timing, severity, trigger, what was tried; every medicine, dose, adherence; every test or result; diagnoses; surgeries; allergies; vaccines
- family history of a disease; occupation, who the patient lives with, smoking, alcohol, drugs
- what the patient asked for or worries about
- a trip or activity detail ONLY when it bears on health: missed medicines during travel, exertion tolerance ("walked 10-12 miles a day, hard at first"), a long flight, exposure to illness, a new symptom
- the clinical consequence of a story, even when the story itself goes ("Walking 10-12 miles daily" stays; "touched the wall of her mother's house and cried" goes)
Do not remove a line because it repeats another line or is badly worded: other steps handle that. Only judge relevance.
You get the PROBLEMS the plan covers and the numbered LINES. Return ONLY JSON: {"remove":[{"id":"S3","category":"personal_story|family_anecdote|other_person|non_clinical_history|social_chat","why":"at most 8 words"}]}. If every line is needed return {"remove":[]}.`;

// ── candidates ──────────────────────────────────────────────────────────────────────────────
/** The bullet lines of Subjective (S1, S2 ...) and Past Medical History (P1 ...) with their index in the markdown lines. */
export function candidates(md) {
  const lines = String(md || '').split('\n'); const out = []; let sec = '', s = 0, p = 0;
  lines.forEach((ln, idx) => {
    const h = ln.match(/^###\s+(.*)$/); if (h) { sec = h[1].trim(); return; }
    const b = ln.match(/^\s*[-•*]\s+(.*\S)\s*$/); if (!b) return;
    if (/^subjective/i.test(sec)) out.push({ id: 'S' + (++s), section: 'Subjective', line: b[1], idx });
    else if (/^past medical/i.test(sec)) out.push({ id: 'P' + (++p), section: 'Past Medical History', line: b[1], idx });
  });
  return out;
}
export function problemTitles(md) {
  return [...String(md || '').matchAll(/^\s*\d+\.\s+\*\*(.+?)\*\*\s*$/gm)].map((m) => m[1].trim()).filter((t) => !/^follow-?up$/i.test(t));
}

// ── the veto ────────────────────────────────────────────────────────────────────────────────
const UNIT = /\d\s?(mg|mcg|µg|g|ml|iu|units?|%|mmhg|mmol|bpm|kg|lbs?|cm|mm|degrees|times)\b/i;   // a duration alone ("59 years ago", "3 days") is not enough to keep a line: the model judges those
const BP = /\b\d{2,3}\s?\/\s?\d{2,3}\b/;
const TEST = /\b(psa|ct|mri|x-?ray|ultrasound|ecg|ekg|echo\w*|biopsy|scope|endoscop\w*|colonoscop\w*|mammogra\w*|pap|blood (test|work|pressure|sugar|glucose)|hba1c|a1c|glucose|cholesterol|ldl|hdl|tsh|ferritin|b12|hemoglobin|haemoglobin|creatinine|egfr|lab\w*|result\w*|culture|swab|scan|bone scan|density)\b/i;
const VACCINE = /\b(vaccin\w*|immuni[sz]\w*|shot|booster|rsv|flu|influenza|shingles|shingrix|covid\w*|tetanus|tdap|pneumo\w*|hpv|hepatitis)\b/i;
const CLINICAL = /\b(pain|ache|fever|cough|rash|bleed\w*|nausea|vomit\w*|diarrh\w*|constipat\w*|dizz\w*|faint\w*|fatigue|tired\w*|breath\w*|chest|palpitat\w*|swell\w*|swollen|infect\w*|diagnos\w*|history of|surgery|surgical|operation|allerg\w*|cancer|tumou?r|diabet\w*|hypertens\w*|asthma|copd|arthritis|depress\w*|anxi\w*|insomnia|sleep\w*|migraine|headache|stroke|heart|cardiac|kidney|renal|liver|thyroid|osteopor\w*|bone|cholesterol|seizure|epilep\w*|asthma|symptom\w*|denies|no (history|known|pain|fever)|negative|positive|stool|bowel|urin\w*|menstr\w*|period|pregnan\w*|breast|weight|appetite|memory|forget\w*|mood|stress\w*|worr\w*|concern\w*|scared|afraid|heart attack)\b/i;
const PLAN = /\b(refill|renew\w*|prescri\w*|referr\w*|follow[- ]?up|requisition|start\w*|stop\w*|continue\w*|resume\w*|recheck|review|asks?|asked|request\w*|inquir\w*|wants?|medication\w*|medicine\w*|pills?|tablet\w*|capsule\w*|cream|inhaler|insulin|dose\w*|supplement\w*)\b/i;
const SOCIAL = /\b(smok\w*|tobacco|cigarette\w*|vap\w*|alcohol|drink\w*|drug use|cannabis|marijuana|lives (alone|with)|living (alone|with)|occupation|works?\b|working|retired|unemployed|student|grade \d+|school|married|single|widow\w*|divorced|caregiver)\b/i;
const DRUGISH = /\b[A-Z][a-z]{3,}(?:\s*\([a-z]+\))?\s+\d/;   // "Lipitor 20" / "Metformin (metformin) 500"

/** Why a line can never be removed, or '' when the model may judge it. */
export function protectedReason(line) {
  const l = String(line || '');
  if (UNIT.test(l) || /\b\d+\s*(?:-|to)\s*\d+\s*miles?\b/i.test(l)) return 'number with a unit';
  if (BP.test(l)) return 'blood pressure';
  if (TEST.test(l)) return 'test or result';
  if (VACCINE.test(l)) return 'vaccine';
  if (SOCIAL.test(l)) return 'social history';
  if (PLAN.test(l)) return 'medicine or plan word';
  if (DRUGISH.test(l)) return 'drug and dose';
  if (CLINICAL.test(l)) return 'clinical word';
  return '';
}

// ── parse and apply ─────────────────────────────────────────────────────────────────────────
export function parseVerdicts(raw, cands) {
  let j; try { j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); } catch { return { drops: [], vetoed: [] }; }
  const byId = new Map(cands.map((c) => [c.id, c])); const drops = [], vetoed = [], seen = new Set();
  for (const r of Array.isArray(j?.remove) ? j.remove : []) {
    const c = byId.get(String(r?.id || '').toUpperCase()); if (!c || seen.has(c.id)) continue; seen.add(c.id);
    const why = protectedReason(c.line); const row = { id: c.id, section: c.section, line: c.line, idx: c.idx, category: String(r.category || 'non_clinical').slice(0, 40), why: String(r.why || '').slice(0, 80) };
    if (why) vetoed.push({ ...row, veto: why }); else drops.push(row);
  }
  return { drops, vetoed };
}
/** Remove the proposed lines from the markdown. A section is never emptied completely: its last line stays. */
export function applyDrops(md, drops) {
  if (!drops?.length) return md;
  const lines = String(md).split('\n'); const kill = new Set(drops.map((d) => d.idx));
  for (const section of ['Subjective', 'Past Medical History']) {
    const all = candidates(md).filter((c) => c.section === section); if (all.length && all.every((c) => kill.has(c.idx))) kill.delete(all[all.length - 1].idx);
  }
  return lines.filter((_, i) => !kill.has(i)).join('\n');
}

/**
 * @returns {Promise<{drops: object[], vetoed: object[], checked: number, ms: number, error?: string}>}
 */
export async function relevanceFilter(llm, md, log = () => {}, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  try {
    const cands = candidates(md); if (cands.length < 3) return { drops: [], vetoed: [], checked: cands.length, ms: 0 };
    const user = `PROBLEMS in the plan: ${problemTitles(md).join('; ') || '(none)'}\n\nLINES:\n` + cands.map((c) => `${c.id} [${c.section}] ${c.line}`).join('\n') + '\n\nReturn ONLY the JSON.';
    const raw = await llm.generateContent(RELEVANCE_SYS, user, null, { maxOutputTokens: 1500, temperature: 0, timeoutMs, retries: 1, hedgeMs: 0, thinkingBudget: 0, responseMimeType: 'application/json' });
    const { drops, vetoed } = parseVerdicts(raw, cands);
    if (drops.length || vetoed.length) log(`[v2:relevance] ${drops.length} line(s) not needed${vetoed.length ? ` (${vetoed.length} kept by the veto)` : ''}: ` + drops.map((d) => `${d.id} "${d.line.slice(0, 50)}" (${d.category})`).join(' | '));
    return { drops, vetoed, checked: cands.length, ms: Date.now() - t0 };
  } catch (e) { return { drops: [], vetoed: [], checked: 0, ms: Date.now() - t0, error: String(e.message || e) }; }
}
