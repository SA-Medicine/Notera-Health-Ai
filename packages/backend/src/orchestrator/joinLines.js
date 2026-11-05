// Subjective continuity and joined lines (2026-11-05, owner request).
//   1. CONTINUITY: lines about one problem sit together (all the weight lines, then the bowel lines ...) as a visible group, without a heading.
//   2. JOINED LINES: neighbouring lines that tell ONE point become one line with a semicolon, the way the Heidi note reads
//      ("Walking 10-12 miles daily during trip; initially difficult, improved by end of week").
// One short model call labels each Subjective line with a topic and proposes joins. The model never writes a word of the note:
//   * the lines are only PERMUTED (a line moves next to the lines of its topic; its words are never touched);
//   * a join keeps the words of both lines exactly, only the full stop at the end of the first line goes and "; " goes in, and the second line
//     starts in lower case when its first word is a plain sentence starter;
//   * code vetoes: never across topics, never more than 3 lines or 32 words, never a denial with a finding, never a dose / "Label:" / doctor-action
//     line, never a line that is only a label; any problem with the lines (a line missing, a stray line) and the note is left as it is.
//   * the proposal was made on the note as it stood; the lines are found again BY TEXT when it is applied, so earlier steps (relevance filter, S/O guard)
//     that removed or moved other lines do not matter. A line the proposal does not know stays with the topic of the line before it.
// Modes (env JOIN_LINES): unset = off; "shadow" = the proposal is stored in note.metadata.joinLines and the note is not changed; "1" = it is applied.
'use strict';

export const JOIN_SYS = `You organise the Subjective section of a clinic note. The input is a numbered list of bullet lines. You do NOT rewrite anything. You only label and group.
1. TOPICS: group the lines so that every line about ONE problem or subject is in the same topic (for example "Weight and Wegovy", "Bowels", "Fluid intake", "Sleep", "Chest rash", "Toes"). The first lines that only list the reasons for the visit ("Weight check", "Medication refill", "Rash on chest") are one topic called "Reasons for visit". Put a line in the topic it is about even when it is far from the others in the list. Use 2 to 8 topics; a line that fits nowhere gets its own topic. EVERY id appears in exactly one topic.
2. JOIN: inside a topic, a line that only continues the line before it (course, trigger, effect, what helped or did not, how long, severity) can be joined to it with a semicolon, for example "Walking 10-12 miles daily during trip" + "Initially difficult" + "Improved by end of week", or "Constipation ongoing" + "Managed with daily stool softener, fibre and probiotics" + "Able to pass stool without suppositories for the last 1.5 weeks". Write it the way a physician writes a compact note: a topic usually ends up as 1 to 3 lines, each line one complete point of up to about 30 words, so join wherever a line only continues the one before it. Join only lines of the SAME topic that are neighbours in your topic list, in groups of 2 to 4 ids; never a denial ("No ...", "Denies ...") with a finding, never medicine and dose lines, never a line that is already long (over 22 words).
Return ONLY JSON: {"topics":[{"topic":"Weight and Wegovy","ids":["S6","S7","S8"]},{"topic":"Bowels","ids":["S9","S10"]}],"join":[["S7","S8"]]}. The join lists use ids that are neighbours inside one topic list, in that order. If nothing should be joined return "join":[].`;

/** The Subjective bullets: id, text, line index and topic group as written (a blank line between bullets starts a new group). */
export function subjectiveLines(md) {
  const lines = String(md || '').split('\n'); const out = []; let inS = false, n = 0, group = 1, blank = false;
  lines.forEach((ln, idx) => {
    const h = ln.match(/^###\s+(.*)$/); if (h) { inS = /^subjective/i.test(h[1].trim()); blank = false; return; }
    if (!inS) return;
    if (!ln.trim()) { blank = true; return; }
    const b = ln.match(/^\s*[-•*]\s+(.*\S)\s*$/); if (!b) return;
    if (blank && out.length) group++;
    blank = false; out.push({ id: 'S' + (++n), line: b[1], idx, group });
  });
  return out;
}

const NEG = /^(no|not|never|denies|denied|negative|without|nil)\b/i;
const DOSE = /\b\d+(?:\.\d+)?\s?(mg|mcg|µg|g|ml|iu|units?)\b/i;
const LABEL = /^[A-Z][A-Za-z ]{2,30}:\s/;
const ACTION = /^(prescription|follow-?up|medication refill|asked|discussed|advised|explained|reviewed|counsel\w*|recommended|suggested|plan(?:ned)?|will\b|to\b|refill|request\w*|requests)\b/i;
const words = (s) => (String(s).match(/\S+/g) || []).length;
// first words that can safely start in lower case after a semicolon (plain sentence starters, never a name, a drug or an abbreviation)
const LOWER_OK = new Set(('initially,then,later,now,currently,previously,recently,mainly,mostly,also,occasionally,sometimes,usually,often,worse,better,improved,improving,worsened,worsening,eased,relieved,helped,resolved,persistent,intermittent,constant,gradual,sudden,mild,moderate,severe,slight,slightly,no,not,never,denies,denied,has,had,have,was,were,is,are,tried,took,taking,takes,started,stopped,continues,continued,felt,feels,feeling,reports,reported,noticed,notices,associated,triggered,aggravated,lasting,lasts,occurs,occurred,occurring,present,absent,since,after,before,during,when,with,without,on,off,only,still,about,around,approximately,improves,eases,helps,relieves,wakes,getting,gets,got,became,becomes,going,went,goes,using,uses,used,applying,applied,drinking,drinks,eating,eats,walking,walks,exercising,onset,began,begins').split(','));
const ADVERB = /^[A-Za-z]{4,}(?:ly|ed|ing)$/;   // "Temporarily", "Appeared", "Flaring": never a name or a drug
export const lowerFirst = (s) => { const w = String(s).match(/^[A-Za-z]+/); return w && (LOWER_OK.has(w[0].toLowerCase()) || ADVERB.test(w[0])) && !/^[A-Z]{2,}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s; };

/** Why two or three neighbouring lines {line, idx, group} may not be joined, or '' when they may. */
export function vetoReason(lines) {
  if (lines.length < 2 || lines.length > 4) return 'size';
  if (new Set(lines.map((l) => l.group)).size > 1) return 'different topic';
  for (let i = 1; i < lines.length; i++) if (lines[i].idx !== lines[i - 1].idx + 1) return 'not neighbours';
  const negs = lines.map((l) => NEG.test(l.line)); if (negs.some(Boolean) && !negs.every(Boolean)) return 'denial with a finding';
  if (lines.some((l) => /^(medications?|preventive care|allerg\w*)\s*:/i.test(l.line))) return 'medication list line';   // a dose inside a story line is fine (the words are kept); only the list lines stay alone
  if (lines.some((l) => ACTION.test(l.line))) return 'doctor action line';
  if (lines.slice(1).some((l) => /^[A-Z][^:;]{2,40}:\s+\S/.test(l.line))) return 'labelled line';   // "Hernia: a; Hernia: b" is not one point
  if (words(lines[0].line) < 3) return 'first line is only a label';   // "Acne" / "Chart update" + a symptom line is not one point
  if (lines.some((l) => words(l.line) > 22)) return 'line already long';
  if (words(lines.map((l) => l.line).join(' ')) > 40) return 'too long when joined';
  return '';
}
export const joinText = (lines) => lines.map((l, i) => { let t = l.line.trim(); if (i < lines.length - 1) t = t.replace(/[.;,\s]+$/, ''); return i ? lowerFirst(t) : t; }).join('; ');

const WORDS_STOP = new Set('with that this from have been will were they them then than into over about after before while visit review follow'.split(' '));
const stems = (s) => new Set((String(s).toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !WORDS_STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')));
/**
 * The owner's note (2026-11-05, migraine + knee visit): the lines that only list the reasons for the visit ("Refill of migraine medication", "Left knee pain and swelling")
 * must not sit in a group of their own at the top while the rest of that problem comes later. A reason line whose words match the NAME of another topic goes first inside
 * that topic (lines only move, no word changes); a reason line that matches no topic stays in the reasons group, which disappears when it is empty.
 */
export function foldReasons(groups) {
  const ri = groups.findIndex((g) => /reason|chief|presenting|visit/i.test(g.name)); if (ri < 0 || groups.length < 2) return groups;
  const keep = [];
  for (const l of groups[ri].lines) {
    const w = stems(l.line); let best = null, bs = 0;
    groups.forEach((g, gi) => { if (gi === ri) return; const s = [...stems(g.name)].filter((x) => w.has(x)).length; if (s > bs) { bs = s; best = gi; } });
    if (best == null) keep.push(l); else groups[best].lines = [...groups[best].lines, l].sort((a, b) => a.idx - b.idx);
  }
  groups[ri].lines = keep;
  return groups.filter((g) => g.lines.length);
}

/**
 * The model's answer -> { topics: [{ name, lines: [{id, line, idx, group}] }], joins, vetoed, moved }.
 * Topics are ordered by their first line in the note and keep the order of the lines inside; a line the model forgot stays with the topic of the line before it.
 */
export function parsePlan(raw, cands) {
  let j; try { j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); } catch { return null; }
  const byId = new Map(cands.map((c) => [c.id, c])); const topicOf = new Map(); const names = [];
  for (const t of Array.isArray(j?.topics) ? j.topics : []) {
    if (!Array.isArray(t?.ids)) continue;
    const ti = names.length; let any = false;
    for (const id of t.ids) { const c = byId.get(String(id).toUpperCase()); if (c && !topicOf.has(c.id)) { topicOf.set(c.id, ti); any = true; } }
    if (any) names.push(String(t.topic || '').slice(0, 60));
  }
  if (!names.length) return null;
  let prev = 0; for (const c of cands) { if (topicOf.has(c.id)) prev = topicOf.get(c.id); else topicOf.set(c.id, prev); }
  const groups = foldReasons(names.map((name, ti) => ({ name, lines: cands.filter((c) => topicOf.get(c.id) === ti) })).filter((g) => g.lines.length)).sort((a, b) => a.lines[0].idx - b.lines[0].idx);
  // positions in the NEW order: a join must be neighbours there
  let pos = 0; const virt = new Map();
  groups.forEach((g, gi) => g.lines.forEach((l) => virt.set(l.id, { ...l, idx: pos++, group: gi })));
  const joins = [], vetoed = [], used = new Set();
  for (const ids of Array.isArray(j?.join) ? j.join : []) {
    if (!Array.isArray(ids)) continue;
    const ls = ids.map((id) => virt.get(String(id).toUpperCase())); if (ls.some((l) => !l) || ls.some((l) => used.has(l.id))) continue;
    const why = vetoReason(ls); const row = { ids: ls.map((l) => l.id), from: ls.map((l) => l.line), to: joinText(ls) };
    if (why) vetoed.push({ ...row, veto: why }); else { joins.push(row); ls.forEach((l) => used.add(l.id)); }
  }
  const order = groups.flatMap((g) => g.lines.map((l) => l.id)); const moved = order.filter((id, i) => id !== cands[i]?.id).length;
  return { topics: groups.map((g) => ({ name: g.name, ids: g.lines.map((l) => l.id), lines: g.lines.map((l) => l.line) })), joins, vetoed, moved };
}

const bulletOf = (l) => { const m = String(l).match(/^(\s*[-•*]\s+)(.*\S)\s*$/); return m ? { pre: m[1], text: m[2] } : null; };

/**
 * Applies a plan to the markdown, finding the lines by text. Returns { md, applied: joins made, moved: lines placed next to their topic, ok }.
 * Fails closed: if the Subjective holds anything but bullets and blank lines, or the lines do not add up, the markdown is returned as it was.
 */
export function applyPlan(md, plan, { gaps = true } = {}) {
  const none = { md, applied: 0, moved: 0, ok: false };
  if (!plan?.topics?.length) return none;
  const lines = String(md).split('\n');
  const s0 = lines.findIndex((l) => /^###\s+subjective/i.test(l)); if (s0 < 0) return none;
  let s1 = lines.findIndex((l, i) => i > s0 && /^###\s/.test(l)); if (s1 < 0) s1 = lines.length;
  const body = lines.slice(s0 + 1, s1);
  const first = body.findIndex((l) => l.trim()); if (first < 0) return none;
  let last = body.length - 1; while (last >= 0 && !body[last].trim()) last--;
  const block = body.slice(first, last + 1);
  if (block.some((l) => l.trim() && !bulletOf(l))) return none;
  const cur = block.filter((l) => l.trim()).map((l) => bulletOf(l));
  const pre = cur[0].pre;
  const topicOf = new Map(); plan.topics.forEach((t, ti) => t.lines.forEach((tx) => { if (!topicOf.has(tx)) topicOf.set(tx, ti); }));
  let prev = 0; const asg = cur.map((b) => { if (topicOf.has(b.text)) prev = topicOf.get(b.text); return { ...b, t: prev }; });
  const order = [...new Set(asg.map((a) => a.t))].sort((a, b) => asg.findIndex((x) => x.t === a) - asg.findIndex((x) => x.t === b));
  const groups = order.map((t) => asg.filter((a) => a.t === t).map((a) => a.text));
  if (groups.flat().length !== cur.length || [...groups.flat()].sort().join('\n') !== cur.map((b) => b.text).sort().join('\n')) return none;
  const moved = groups.flat().filter((tx, i) => tx !== cur[i].text).length;
  let applied = 0;
  for (const g of groups) for (const jn of plan.joins || []) {
    for (let i = 0; i + jn.from.length <= g.length; i++) if (jn.from.every((tx, k) => g[i + k] === tx)) { g.splice(i, jn.from.length, jn.to); applied++; break; }
  }
  const out = [];
  groups.forEach((g, gi) => {
    if (gi && gaps && !(groups[gi - 1].length <= 1 && g.length <= 1)) out.push('');
    for (const tx of g) out.push(pre + tx);
  });
  if (!moved && !applied && out.join('\n') === block.join('\n')) return { md, applied: 0, moved: 0, ok: true };   // the note already reads as these groups
  const regrouped = !moved && !applied;   // same order, only the groups (blank lines) are new
  // whatever the original blank lines were, the new block carries the groups; keep the lines around it
  const rebuilt = [...lines.slice(0, s0 + 1), ...body.slice(0, first), ...out, ...body.slice(last + 1), ...lines.slice(s1)];
  return { md: rebuilt.join('\n'), applied, moved, regrouped, ok: true };
}

/**
 * Objective, the Heidi way: a labelled line ("Bloods (August): Hb normal") followed by its own continuation fragments, which the note stores as separate
 * lines that start in lower case ("fasting glucose 4.6 mmol/L", "sodium normal"), becomes ONE line with the pieces separated by "; ".
 * Pure text, no model: only lower-case-start lines that follow a "Label: ..." line (or a line already joined) are joined; the words are untouched. A line
 * is never joined past maxWords words, and a new line starts after that. OBJ_JOIN=0 switches it off.
 */
export function joinObjective(md, { maxWords = 100 } = {}) {
  const lines = String(md || '').split('\n'); const out = []; let inO = false, head = -1, headWords = 0, joined = 0;
  for (const ln of lines) {
    const h = ln.match(/^###\s+(.*)$/); if (h) { inO = /^objective/i.test(h[1].trim()); head = -1; out.push(ln); continue; }
    const b = inO ? ln.match(/^(\s*[-•*]\s+)(.*\S)\s*$/) : null;
    if (!b) { if (ln.trim()) head = -1; out.push(ln); continue; }
    const text = b[2];
    // a fragment starts in lower case ("sodium normal") or is a lab abbreviation with its value ("A1c 5.5%", "LDL 2.5 (increased from 2.2)")
    if (head >= 0 && (/^[a-z]/.test(text) || /^[A-Z][A-Za-z0-9]{1,6}\s+[<>]?\d/.test(text)) && !/^[^:]{2,60}:\s*\S/.test(text) && headWords + words(text) <= maxWords) {
      out[head] = out[head].replace(/[.;,\s]+$/, '') + '; ' + text; headWords += words(text); joined++; continue;
    }
    if (/^[^:]{2,60}:\s*\S/.test(text)) { head = out.length; headWords = words(text); } else head = -1;
    out.push(ln);
  }
  return { md: out.join('\n'), joined };
}

/**
 * The owner's rule (2026-11-05): a bullet in Subjective or Objective is at most two lines on screen, never three. A joined bullet longer than maxChars is cut at its
 * own "; " boundaries into two or more bullets, each as full as possible; the pieces keep their order and every word, only the first letter of a piece that was
 * lower-cased for the join comes back as a capital. A single piece that is long on its own is left alone. LINE_CAP=0 switches it off.
 */
function splitTop(s, sep) {   // split at sep only outside (...) brackets
  const out = []; let depth = 0, from = 0;
  for (let i = 0; i < s.length; i++) { const c = s[i]; if (c === '(') depth++; else if (c === ')') depth = Math.max(0, depth - 1); else if (!depth && s.startsWith(sep, i)) { out.push(s.slice(from, i)); from = i + sep.length; i = from - 1; } }
  out.push(s.slice(from)); return out;
}
const upperFirst =(s) => (/^[a-z]+\b/.test(s) && !/^[a-z]+[A-Z]/.test(s) ? s[0].toUpperCase() + s.slice(1) : s);
export function capLines(md, { maxChars = 140 } = {}) {
  const out = []; let inSO = false, split = 0;
  for (const ln of String(md || '').split('\n')) {
    const h = ln.match(/^###\s+(.*)$/); if (h) { inSO = /^(subjective|objective|past medical)/i.test(h[1].trim()); out.push(ln); continue; }
    const b = inSO ? ln.match(/^(\s*[-•*]\s+)(.*\S)\s*$/) : null;
    if (!b || b[2].length <= maxChars || !/[;,] /.test(b[2])) { out.push(ln); continue; }
    // pieces: split at "; " first; a piece that is still too long is split at its own ", " (never inside brackets); separators are kept
    const segs = []; for (const [i, p] of splitTop(b[2], '; ').entries()) { const sep = i ? '; ' : ''; if (p.length > maxChars) splitTop(p, ', ').forEach((q, k) => segs.push({ sep: k ? ', ' : sep, t: q })); else segs.push({ sep, t: p }); }
    const chunks = []; let cur = '';
    for (const s of segs) {
      if (cur && (cur + s.sep + s.t).length > maxChars) { chunks.push(cur); cur = s.t; } else cur = cur ? cur + s.sep + s.t : s.t;
    }
    if (cur) chunks.push(cur);
    if (chunks.length < 2) { out.push(ln); continue; }
    chunks.forEach((c, i) => out.push(b[1] + (i ? upperFirst(c) : c))); split += chunks.length - 1;
  }
  return { md: out.join('\n'), split };
}

/** @returns {Promise<{plan: object|null, checked: number, ms: number, error?: string}>} */
export async function proposePlan(llm, md, log = () => {}, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  try {
    const cands = subjectiveLines(md); if (cands.length < 4) return { plan: null, checked: cands.length, ms: 0 };
    const raw = await llm.generateContent(JOIN_SYS, cands.map((c) => `${c.id} ${c.line}`).join('\n') + '\n\nReturn ONLY the JSON.', null, { maxOutputTokens: 900, temperature: 0, timeoutMs, retries: 1, hedgeMs: 0, thinkingBudget: 0, responseMimeType: 'application/json' });
    const plan = parsePlan(raw, cands);
    if (plan) log(`[v2:join] ${plan.topics.length} topic(s) [${plan.topics.map((t) => t.name + ' ' + t.ids.length).join(', ')}], ${plan.moved} line(s) to move, ${plan.joins.length} join(s)${plan.vetoed.length ? `, ${plan.vetoed.length} vetoed` : ''}`);
    return { plan, checked: cands.length, ms: Date.now() - t0 };
  } catch (e) { return { plan: null, checked: 0, ms: Date.now() - t0, error: String(e.message || e) }; }
}
