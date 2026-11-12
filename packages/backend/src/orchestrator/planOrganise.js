// Plan organiser (2026-11-05, owner: "fix and complete plan quality"). A plan line that sits under the wrong problem, most often a lone line under a generic title
// ("Investigations", "Medication prescriptions", "Preventive care"), is moved under the problem it is about.
// Same rules as joinLines.js: the model only SAYS which problem a line belongs to, CODE moves the line (words untouched, nothing added or reworded), finds lines and
// problems by their text, vetoes anything unsure, fails closed. A generic problem that ends up with no line is dropped and the rest renumbered.
// PLAN_ORGANISE=shadow|1 (off when unset). Only the Assessment & Plan section is touched.
'use strict';

const GENERIC = /^(investigations?|medications?( prescriptions?)?|treatments?|preventive care|health maintenance|other|others|general|plan|prescriptions?|referrals?|advice|counselling|counseling|lifestyle|medication)\b/i;
const FOLLOWUP = /^follow-?\s?up/i;

export const ORGANISE_SYS = `You tidy the Assessment & Plan of a clinic note. The input is a numbered list of problems, each with numbered plan lines. You do NOT rewrite anything. You only say which plan lines sit under the wrong problem.
Move a line only when it clearly belongs under a DIFFERENT problem of the list: a lone line under a generic heading ("Investigations", "Medication prescriptions", "Treatment", "Preventive care") that is about one of the specific problems (a drug for that condition, a test for that condition, advice for that condition), or a line about one condition sitting under another.
Do not move when unsure. Do not move follow-up lines. Never move a line to a generic heading or to Follow-up. Never invent a problem.
Return ONLY JSON: {"moves":[{"line":"L7","to":3}]}   where "line" is the line id and "to" is the number of the problem it belongs to. {"moves":[]} when nothing is wrong.`;

/** The Assessment & Plan as blocks, or null when it holds anything that is not a numbered title or a bullet (then nothing is touched). */
export function planBlocks(md) {
  const lines = String(md || '').split('\n'); const start = lines.findIndex((l) => /^###\s+assessment/i.test(l)); if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^###\s+/.test(l)); if (end < 0) end = lines.length;
  const problems = []; let cur = null; let tail = [];
  for (let i = start + 1; i < end; i++) {
    const t = lines[i].match(/^\s*\d+\.\s+\*\*(.+?)\*\*\s*$/);
    if (t) { cur = { title: t[1].replace(/\.+\s*$/, '').trim(), raw: lines[i], items: [] }; problems.push(cur); continue; }
    const b = lines[i].match(/^(\s*[-*]\s+)(.*\S)\s*$/);
    if (b && cur) { cur.items.push({ indent: b[1], text: b[2] }); continue; }
    if (!lines[i].trim()) { if (cur) tail.push(i); continue; }
    return null;
  }
  return { lines, start, end, problems };
}

export function candidates(md) {
  const pb = planBlocks(md); if (!pb || pb.problems.length < 2) return null;   // 2 problems is enough: a line can sit under the wrong one of two (owner, 2026-11-12)
  let n = 0; return pb.problems.map((p, pi) => ({ no: pi + 1, title: p.title, items: p.items.map((it) => ({ id: 'L' + (++n), text: it.text })) }));
}

const norm = (s) => String(s).toLowerCase().replace(/[.\s]+$/, '').replace(/\s+/g, ' ').trim();

const STOP = new Set('with that this from have been will were they them then than into over under about after before while which would could should continue start arrange consider discussed advised return prescription follow patient'.split(' '));
const contentWords = (s) => new Set((String(s).toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')));

/** The model's answer -> [{ text, from, to }] (titles of the snapshot), with vetoes. */
export function parseMoves(raw, cands) {
  let j; try { j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); } catch { return null; }
  if (!j || !Array.isArray(j.moves)) return null;
  const byId = new Map(); for (const p of cands) for (const it of p.items) byId.set(it.id, { p, it });
  const left = new Map(cands.map((p) => [p.no, p.items.length])); const moves = [], vetoed = [];
  for (const m of j.moves.slice(0, 8)) {
    const src = byId.get(String(m?.line)); const dst = cands.find((p) => p.no === Number(m?.to));
    const why = !src ? 'unknown line' : !dst ? 'unknown problem' : src.p.no === dst.no ? 'same problem' : GENERIC.test(dst.title) ? 'target is generic' : FOLLOWUP.test(dst.title) || FOLLOWUP.test(src.p.title) ? 'follow-up' : (!GENERIC.test(src.p.title) && left.get(src.p.no) <= 1) ? 'would empty a specific problem' : '';
    // a line that leaves a SPECIFIC problem must share a real word with the problem it goes to (its title or its lines); from a generic heading the model's word is enough
    const shares = !why && !GENERIC.test(src.p.title) ? ((a, b) => [...a].some((w) => b.has(w)))(contentWords(src.it.text), contentWords(dst.title + ' ' + dst.items.map((i) => i.text).join(' '))) : true;
    if (!why && !shares) { vetoed.push({ line: src.it.text, why: 'no shared word with the other problem' }); continue; }
    if (why) { vetoed.push({ line: src?.it.text || String(m?.line), why }); continue; }
    left.set(src.p.no, left.get(src.p.no) - 1); moves.push({ text: src.it.text, from: src.p.title, to: dst.title });
  }
  return { moves, vetoed };
}

/** Moves the lines (found by text), drops a generic problem left empty, renumbers. @returns {{md, moved, dropped, ok}} */
export function applyMoves(md, parsed) {
  const pb = planBlocks(md); if (!pb || !parsed?.moves?.length) return { md, moved: 0, dropped: [], ok: !!pb };
  const P = pb.problems; let moved = 0;
  for (const m of parsed.moves) {
    const src = P.find((p) => norm(p.title) === norm(m.from) && p.items.some((i) => norm(i.text) === norm(m.text)));
    const dst = P.find((p) => norm(p.title) === norm(m.to));
    if (!src || !dst || src === dst) continue;
    const k = src.items.findIndex((i) => norm(i.text) === norm(m.text)); const [it] = src.items.splice(k, 1);
    dst.items.push({ indent: dst.items[0]?.indent || it.indent, text: it.text }); moved++;
  }
  if (!moved) return { md, moved: 0, dropped: [], ok: true };
  const dropped = []; const keep = P.filter((p) => { if (!p.items.length && GENERIC.test(p.title)) { dropped.push(p.title); return false; } return true; });
  const body = []; keep.forEach((p, i) => { body.push(p.raw.replace(/^(\s*)\d+\./, `$1${i + 1}.`)); p.items.forEach((it) => body.push(it.indent + it.text)); });
  const out = [...pb.lines.slice(0, pb.start + 1), ...body, '', ...pb.lines.slice(pb.end)];
  return { md: out.join('\n').replace(/\n{3,}/g, '\n\n'), moved, dropped, ok: true };
}

/** @returns {Promise<{moves: object[], vetoed: object[], checked: number, ms: number, error?: string}>} */
export async function proposeMoves(llm, md, log = () => {}, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  try {
    const cands = candidates(md); if (!cands) return { moves: [], vetoed: [], checked: 0, ms: 0 };
    const txt = cands.map((p) => `${p.no}. ${p.title}\n` + p.items.map((i) => `  ${i.id} ${i.text}`).join('\n')).join('\n');
    const raw = await llm.generateContent(ORGANISE_SYS, txt + '\n\nReturn ONLY the JSON.', null, { maxOutputTokens: 500, temperature: 0, timeoutMs, retries: 1, hedgeMs: 0, thinkingBudget: 0, responseMimeType: 'application/json' });
    const parsed = parseMoves(raw, cands);
    if (parsed) log(`[v2:plan] ${parsed.moves.length} line(s) to move${parsed.vetoed.length ? `, ${parsed.vetoed.length} vetoed` : ''}`);
    return { moves: parsed?.moves || [], vetoed: parsed?.vetoed || [], checked: cands.length, ms: Date.now() - t0 };
  } catch (e) { return { moves: [], vetoed: [], checked: 0, ms: Date.now() - t0, error: String(e.message || e) }; }
}
