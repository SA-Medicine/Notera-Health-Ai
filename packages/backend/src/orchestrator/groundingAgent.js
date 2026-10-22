// Grounding agent ("no hallucination"): a last fact check of every line of the note against the transcript.
//   1. FIRST LOOK (one call): a model reads the transcript and the numbered note lines and lists ONLY the lines it doubts ("unsupported" or "unclear").
//      Lines it does not list count as supported, so the answer is short and fast.
//   2. CODE decides what a doubt means. A line is a REMOVAL CANDIDATE only if the model says "unsupported" AND most of its key words (numbers, drug
//      names, rare words) are missing from the transcript. Otherwise a doubted line stays, and is flagged only if some key words are missing.
//   3. SECOND LOOK (one small call per candidate, in parallel): "find the exact transcript words that show this". If a quote is found and code
//      confirms it is in the transcript, the line is KEPT (a true fact in different words, e.g. "freeze it" for cryotherapy). Only a line that fails
//      both looks is removed.
//   4. SAFETY CAP: if more than a fifth of the lines would be removed, nothing is removed; the lines are flagged instead (the checker is probably
//      wrong, not the note).
// The model never edits the note. Removals and flags go to note.metadata.flags and the trace. Style Spec v2 stage (GROUNDING=0 switches off).
'use strict';

import { quoted } from './planSweep.js';

export const GROUND_SYS = `You are a strict fact checker for a clinic note. You receive the TRANSCRIPT (the only truth) and numbered NOTE LINES.
List ONLY the lines the transcript does not clearly support:
- "unsupported": the line states a fact, drug, dose, number, body site or side, diagnosis, exam finding, result, event or plan item that the transcript does not say, or that contradicts it, or that happened at an EARLIER visit but is written as done now;
- "unclear": the transcript is ambiguous about it.
Supported = said by the clinician or the patient (paraphrase, medical wording, and a spelling variant of a drug or term caused by speech recognition are fine when the same thing is clearly meant). Do not list supported lines.
Be strict about: drug names and doses, numbers and units, left/right and body site, diagnoses, exam findings (never invent an exam), test results (normal vs abnormal), and what was done in THIS visit.
Return ONLY JSON: {"doubtful":[{"n":1,"verdict":"unsupported","why":"short reason"}]}. If every line is supported return {"doubtful":[]}.`;

export const VERIFY_SYS = `You check ONE statement from a clinic note against a transcript. Find the exact words in the transcript that show the statement was said or done in THIS visit (the same thing in different words counts, for example "freeze it" for cryotherapy; "you gave me the shot" only counts if it was this visit).
Return ONLY JSON: {"found":true,"quote":"exact transcript words, at most 25 words"} or {"found":false,"quote":""}.`;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const stem = (w) => w.replace(/ae/g, 'e').replace(/oe/g, 'e').replace(/(osis|itis|emia|ia|ing|ion|ed|es|s|y)$/, '').slice(0, 6);
const NUMW = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMRE = new RegExp(String.raw`\b(${Object.keys(NUMW).join('|')})\b`, 'g');
const spoken = (t) => norm(String(t || '').toLowerCase().replace(/(\d)\.(\d)/g, '$1dotx$2')).replace(NUMRE, (w) => NUMW[w])
  .replace(/\b([2-9]0) ([1-9])\b/g, (m, a, b) => String(Number(a) + Number(b)))
  .replace(/\b(\d+) hundred(?: (\d+))?\b/g, (m, a, b) => String(Number(a) * 100 + (b ? Number(b) : 0)))                // fifteen hundred -> 1500                                   // sixty four -> 64
  .replace(/\b(\d+) point (\d(?: \d)*)\b/g, (m, a, b) => a + 'dotx' + b.replace(/ /g, '')).replace(/(\d)dotx(\d)/g, '$1.$2');   // one point four four -> 1.44
const SKIP = /^(medications?|allergies|preventive care|occupation|social|family)\s*:/i;
const FILLER = new Set(['the', 'and', 'with', 'for', 'from', 'that', 'this', 'patient', 'planned', 'continue', 'provided', 'given', 'noted', 'reports', 'also', 'were', 'have', 'has', 'been']);
export const FLAG_BELOW = 0.75;
export const REMOVAL_CAP = 0.2;   // never remove more than this share of the lines

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

/** Accepts the short format {"doubtful":[...]} and the old long format {"lines":[...]} (supported lines are then ignored). */
export function parseGround(raw) {
  try {
    const j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim());
    if (Array.isArray(j?.doubtful)) return j.doubtful;
    if (Array.isArray(j?.lines)) return j.lines;
  } catch { /* fall through */ }
  return null;
}

/**
 * A line may only be REMOVED when it carries a hard fact the recording does not contain: a number (dose, value, count) that is not in the
 * transcript, a capitalised name (drug, place, person) that is not in the transcript, or an invented exam finding (an examination line whose
 * key words are mostly absent). Soft lines (statuses such as "Improved", plain wording, a diagnosis word) are flagged at most, never removed.
 */
export function hardMissing(part, transcript) {
  const T = spoken(transcript); const tokens = new Set(T.split(' ')); const TW = new Set(T.split(' ').map(stem));
  const { nums } = keyWords(part.text);
  const joined = [...T.split(' ')].filter((w) => /^\d+$/.test(w)).join('');   // spoken digits that run together: "one ten over sixty"
  if (nums.some((n) => !tokens.has(n) && !joined.includes(n.replace('.', '')))) return 'number';
  const caps = (String(part.text).match(/(?<!^)(?<![.:]\s)\b[A-Z][a-z]{4,}\b/g) || []).filter((w) => !TW.has(stem(w.toLowerCase())));
  if (caps.length) return 'name';
  if (part.key === 'examination' && wordSupport(part.text, transcript) < 0.34) return 'exam';
  return '';
}

/** Decide, in code, what to do with each model verdict. Pure. */
export function decide(parts, verdicts, transcript) {
  const out = { remove: [], flag: [], doubtful: [], kept: 0 };
  const byN = new Map((verdicts || []).map((v) => [Number(v.n), v]));
  parts.forEach((p, idx) => {
    const v = byN.get(idx + 1); if (!v || v.verdict === 'supported') { out.kept++; return; }
    const support = wordSupport(p.text, transcript);
    const hard = v.verdict === 'unsupported' && support < 0.5 && String(p.text).split(/\s+/).length >= 3 ? hardMissing(p, transcript) : '';
    if (hard) out.remove.push({ idx, text: p.text, why: (v.why || 'not in the transcript') + ' [' + hard + ']', support, hard });
    else if (v.verdict === 'unsupported' && support < 0.5) out.flag.push({ idx, text: p.text, why: v.why || 'unclear', support, verdict: v.verdict });   // some of its key words really are missing from the recording
    else out.doubtful.push({ idx, text: p.text, why: v.why || 'unclear', support, verdict: v.verdict });   // the model doubts it but its words are all in the recording: trace only
  });
  return out;
}

/** Second look at each removal candidate (parallel). Returns { rescued, confirmed }. */
export async function secondLook(llm, transcript, candidates, { timeoutMs = 20000 } = {}) {
  const txNorm = norm(transcript); const rescued = [], confirmed = [];
  await Promise.all(candidates.map(async (c) => {
    try {
      const raw = await llm.generateContent(VERIFY_SYS, `TRANSCRIPT:\n"""\n${String(transcript).slice(0, 60000)}\n"""\n\nSTATEMENT:\n${c.text}\n\nReturn ONLY the JSON.`, null,
        { maxOutputTokens: 400, temperature: 0, timeoutMs, retries: 1, hedgeMs: 0, thinkingBudget: 512, responseMimeType: 'application/json' });
      const j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim());
      if (j?.found === true && quoted(String(j.quote || ''), txNorm)) rescued.push({ ...c, quote: String(j.quote).slice(0, 160) }); else confirmed.push(c);
    } catch { confirmed.push(c); }   // the second look failed: the first look stands
  }));
  return { rescued, confirmed };
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
  if (parts.length < 3) return { checked: 0, removed: [], flagged: [], doubtful: [], rescued: [], ms: 0 };
  const listing = parts.map((p, i) => `${i + 1}. ${p.text}`).join('\n');
  const raw = await llm.generateContent(GROUND_SYS, `TRANSCRIPT:\n"""\n${String(transcript).slice(0, 60000)}\n"""\n\nNOTE LINES:\n${listing}\n\nReturn ONLY the JSON.`, null,
    { maxOutputTokens: 2500, temperature: 0, timeoutMs, retries: 2, hedgeMs: 0, thinkingBudget: 1024, responseMimeType: 'application/json' });
  const verdicts = parseGround(raw); if (verdicts === null) { log('[v2:ground] no usable answer — note unchanged'); return { checked: parts.length, removed: [], flagged: [], doubtful: [], rescued: [], ms: Date.now() - t0, error: 'unparseable' }; }
  const d = decide(parts, verdicts, transcript);
  let removeNow = []; let rescued = []; let capped = false;
  if (d.remove.length) {
    const sl = await secondLook(llm, transcript, d.remove); rescued = sl.rescued; removeNow = sl.confirmed;
    if (removeNow.length > Math.max(3, Math.ceil(parts.length * REMOVAL_CAP))) { capped = true; d.flag.push(...removeNow.map((r) => ({ ...r, verdict: 'unsupported' }))); removeNow = []; }
  }
  const removed = applyRemovals(parts, removeNow);
  const flags = [];
  if (removeNow.length) flags.push({ type: 'removed_unsupported', field: 'note', message: `${removeNow.length} line(s) the recording does not support were removed: ${removeNow.slice(0, 4).map((r) => '"' + r.text.slice(0, 60) + '"').join('; ')}`, severity: 'info' });
  if (d.flag.length) flags.push({ type: 'check_against_recording', field: 'note', message: `Please check against the recording${capped ? ' (many lines looked doubtful, none were removed)' : ''}: ${d.flag.slice(0, 4).map((r) => '"' + r.text.slice(0, 60) + '" (' + String(r.why).slice(0, 60) + ')').join('; ')}`, severity: 'warning' });
  note.metadata = note.metadata || {}; note.metadata.flags = [...(note.metadata.flags || []), ...flags];
  log(`[v2:ground] checked ${parts.length} lines · doubted ${verdicts.length} · kept after second look ${rescued.length} · removed ${removed}${removeNow.length ? ' (' + removeNow.map((r) => r.text.slice(0, 40)).join(' | ') + ')' : ''} · flagged ${d.flag.length}${capped ? ' · removal cap hit' : ''}`);
  return { checked: parts.length, removed: removeNow, flagged: d.flag, doubtful: d.doubtful, rescued, capped, ms: Date.now() - t0 };
}
