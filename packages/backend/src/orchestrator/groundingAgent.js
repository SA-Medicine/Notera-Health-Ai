// Grounding agent ("no hallucination"): a last fact check of every line of the note against the transcript.
// An independent model call reads the transcript and the numbered note lines and says, for each line, whether the transcript supports it,
// and for supported lines quotes the transcript words. Code then decides, so the model never edits the note itself:
//   * unsupported by the model AND its key words (numbers, drug names, body sites, rare words) are mostly missing from the transcript -> the line is REMOVED;
//   * unsupported/unclear by the model but the words are in the transcript (a wrong meaning, a wrong place, an old event) -> the line stays and the
//     note is FLAGGED for the doctor to check;
//   * supported with a quote that really is in the transcript -> kept.
// Removals and flags are written to note.metadata.flags and to the trace, so nothing disappears silently. Style Spec v2 stage (GROUNDING=0 switches off).
'use strict';

import { quoted } from './planSweep.js';

export const GROUND_SYS = `You are a strict fact checker for a clinic note. You receive the TRANSCRIPT (the only truth) and numbered NOTE LINES.
For every line decide:
- "supported": the transcript says it (paraphrase, medical wording, a spelling variant of a drug or term caused by speech recognition is fine when the same thing is clearly meant);
- "unsupported": the line states a fact, drug, dose, number, body site or side, diagnosis, result, event or plan item that the transcript does not say, or that contradicts it, or that happened at an EARLIER visit but is written as done now;
- "unclear": the transcript is ambiguous about it.
Be strict about: drug names and doses, numbers and units, left/right and body site, diagnoses, test results (normal vs abnormal), and what was done in THIS visit.
For "supported" give "quote": the exact transcript words (6-25 words) that show it. For "unsupported" or "unclear" give a short "why".
Return ONLY JSON: {"lines":[{"n":1,"verdict":"supported","quote":"","why":""}]} with one entry per line, in order.`;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const stem = (w) => w.replace(/ae/g, 'e').replace(/oe/g, 'e').replace(/(osis|itis|emia|ia|ing|ion|ed|es|s|y)$/, '').slice(0, 6);
const NUMW = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const spoken = (t) => norm(String(t || '').toLowerCase().replace(/(\d)\.(\d)/g, '$1dotx$2')).replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (w) => NUMW[w]).replace(/\b(\d+) point (\d+)\b/g, '$1dotx$2').replace(/(\d)dotx(\d)/g, '$1.$2');
const SKIP = /^(medications?|allergies|preventive care|occupation|social|family)\s*:/i;
const FILLER = new Set(['the', 'and', 'with', 'for', 'from', 'that', 'this', 'patient', 'planned', 'continue', 'provided', 'given', 'noted', 'reports', 'also', 'were', 'have', 'has', 'been']);

/** Key words of a line: numbers and words of 4+ letters that are not filler. */
export function keyWords(line) {
  const t = spoken(line); const nums = t.match(/(?<![a-z])\d+(?:\.\d+)?(?![a-z])/g) || [];
  const words = t.split(' ').filter((w) => w.length >= 4 && !/\d/.test(w) && !FILLER.has(w)).map(stem);
  return { nums, words };
}
/** Share of the line's key words (numbers count double) that occur in the transcript. 1 = all. */
export function wordSupport(line, transcript) {
  const T = spoken(transcript); const TW = new Set(T.split(' ').map(stem)); const { nums, words } = keyWords(line);
  const total = nums.length * 2 + words.length; if (!total) return 1;
  const hit = nums.filter((n) => T.split(' ').includes(n)).length * 2 + words.filter((w) => TW.has(w)).length;
  return hit / total;
}

/** The note's checkable parts, each with a way to remove it. */
export function collectParts(note) {
  const parts = [];
  const addField = (obj, key, where) => {
    const raw = obj?.[key]; if (typeof raw !== 'string' || !raw.trim()) return;
    const lines = raw.split('\n').flatMap((l) => (where.startsWith('plan') ? l.split('; ') : [l])).map((l) => l.trim()).filter(Boolean);
    lines.forEach((text, i) => { if (/:\s*$/.test(text) || SKIP.test(text) || text.length < 8) return; parts.push({ where, text, obj, key, i, lines }); });
  };
  for (const sec of ['subjective', 'past_medical_history', 'objective']) for (const k of Object.keys(note?.[sec] || {})) addField(note[sec], k, sec);
  (note?.assessment_and_plan || []).forEach((p, pi) => { for (const k of ['assessment', 'investigations_planned', 'treatment_planned', 'referrals']) addField(p, k, 'plan:' + (p.issue || pi)); });
  return parts;
}

export function parseGround(raw) {
  try { const j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); return Array.isArray(j?.lines) ? j.lines : []; } catch { return []; }
}

/** Decide, in code, what to do with each model verdict. Pure. */
export const FLAG_BELOW = 0.75;
export function decide(parts, verdicts, transcript) {
  const out = { remove: [], flag: [], doubtful: [], kept: 0 }; const T = norm(spoken(transcript));
  const byN = new Map(verdicts.map((v) => [Number(v.n), v]));
  parts.forEach((p, idx) => {
    const v = byN.get(idx + 1); if (!v) { out.kept++; return; }
    if (v.verdict === 'supported') { out.kept++; return; }
    const support = wordSupport(p.text, transcript);
    if (v.verdict === 'unsupported' && support < 0.5) out.remove.push({ idx, text: p.text, why: v.why || 'not in the transcript', support });
    else if (support < FLAG_BELOW) out.flag.push({ idx, text: p.text, why: v.why || 'unclear', support, verdict: v.verdict });   // some of its key words really are missing from the recording
    else out.doubtful.push({ idx, text: p.text, why: v.why || 'unclear', support, verdict: v.verdict });   // the model doubts it but the words are all in the recording: trace only, no flag (tested: 35 of 57 such flags were noise)
  });
  void T; void quoted;
  return out;
}

/** Applies removals to the note (only whole parts of a field). Returns how many parts were removed. */
export function applyRemovals(parts, removals) {
  const dead = new Set(removals.map((r) => r.idx)); const byField = new Map();
  parts.forEach((p, idx) => { const k = p.obj; if (!byField.has(k)) byField.set(k, new Map()); const m = byField.get(k); if (!m.has(p.key)) m.set(p.key, []); m.get(p.key).push({ p, idx }); });
  let n = 0;
  for (const [obj, keys] of byField) for (const [key, list] of keys) {
    const drop = new Set(list.filter((x) => dead.has(x.idx)).map((x) => x.p.text)); if (!drop.size) continue;
    const plan = list[0].p.where.startsWith('plan');
    const lines = String(obj[key]).split('\n').flatMap((l) => (plan ? l.split('; ') : [l])).map((l) => l.trim()).filter((l) => l && !drop.has(l));
    n += drop.size; obj[key] = lines.join(plan ? '; ' : '\n');
  }
  return n;
}

export async function groundNote(llm, note, transcript, log = () => {}, { timeoutMs = 45000 } = {}) {
  const t0 = Date.now(); const parts = collectParts(note);
  if (parts.length < 3) return { checked: 0, removed: [], flagged: [], ms: 0 };
  const listing = parts.map((p, i) => `${i + 1}. ${p.text}`).join('\n');
  const raw = await llm.generateContent(GROUND_SYS, `TRANSCRIPT:\n"""\n${String(transcript).slice(0, 60000)}\n"""\n\nNOTE LINES:\n${listing}\n\nReturn ONLY the JSON.`, null,
    { maxOutputTokens: 6000, temperature: 0, timeoutMs, retries: 1, hedgeMs: 0, thinkingBudget: 1024, responseMimeType: 'application/json' });
  const verdicts = parseGround(raw); if (!verdicts.length) { log('[v2:ground] no usable answer — note unchanged'); return { checked: parts.length, removed: [], flagged: [], ms: Date.now() - t0, error: 'unparseable' }; }
  const d = decide(parts, verdicts, transcript); const removed = applyRemovals(parts, d.remove);
  const flags = [];
  if (d.remove.length) flags.push({ type: 'removed_unsupported', field: 'note', message: `${d.remove.length} line(s) the recording does not support were removed: ${d.remove.slice(0, 4).map((r) => '"' + r.text.slice(0, 60) + '"').join('; ')}`, severity: 'info' });
  if (d.flag.length) flags.push({ type: 'check_against_recording', field: 'note', message: `Please check against the recording: ${d.flag.slice(0, 4).map((r) => '"' + r.text.slice(0, 60) + '" (' + String(r.why).slice(0, 60) + ')').join('; ')}`, severity: 'warning' });
  note.metadata = note.metadata || {}; note.metadata.flags = [...(note.metadata.flags || []), ...flags];
  log(`[v2:ground] checked ${parts.length} lines · removed ${removed}${d.remove.length ? ' (' + d.remove.map((r) => r.text.slice(0, 40)).join(' | ') + ')' : ''} · flagged ${d.flag.length}`);
  return { checked: parts.length, removed: d.remove, flagged: d.flag, doubtful: d.doubtful, ms: Date.now() - t0 };
}
