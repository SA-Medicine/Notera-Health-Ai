// Repeat trim (options 1 and 2 of the 2026-10-31 repeat audit). Deterministic, no model call, and it never removes a number or date the
// kept line does not also hold.
//   1. the same fact twice in one line ("Follow-up: 30 days; Return to clinic in 30 days"), or twice under different problems.
//   2. a plan action told as a story in Subjective ("Requisition for breast ultrasound", "Scheduled for MRI on Friday") when the plan already has it.
// Past Medical History and Objective are not touched: free flow keeps every history and exam line (docs/STYLE_SPEC_V2_LOCKED.md, v2.2).
// Off by default: REPEAT_TRIM=1 switches it on. Every removal is returned so a reviewer can read it.
'use strict';

const STOP = new Set('the a an of to and or in on for with at by is are was were be been has have had her his their its it this that these those as from not no per than then also up out over into off any all can will may would should could after before about patient pt he she they them which who whom while when where because since due plus'.split(' '));
const stem = (w) => w.replace(/(ing|ed|es|s|ly)$/, '');
const toks = (s) => String(s || '').toLowerCase().replace(/\*\*/g, '').replace(/[^a-z0-9./ -]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w) && w.length > 1).map(stem);
const nums = (t) => new Set(t.filter((w) => /\d/.test(w)));
const overlap = (a, b) => { const A = new Set(a), B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; return { i, min: Math.min(A.size, B.size) || 1 }; };
const subset = (a, b) => { for (const x of a) if (!b.has(x)) return false; return true; };
const sameSet = (a, b) => a.size === b.size && subset(a, b);

const LABEL = /^(\s*[-*]\s+)((?:Diagnosis|Differential diagnoses|Investigations planned|Treatment planned|Referrals|Advice|Follow-up|Started|Changed|Stopped|Continued|Given today|Other):\s*)?(.*)$/;
const PLAN_CUE = /\b(schedul\w*|requisition\w*|referr\w*|recommend\w*|planned|booked|appointment\w*|next .{0,25}\b(in|at|on)\b|to be (done|arranged)|order(ed)?|prescri\w*|advis\w*|instruct\w*|administer\w*|faxed|printed|will (be|have|see|need))\b/i;

/** Split on "; " that is not inside brackets. */
function clauses(text) {
  const out = []; let depth = 0, cur = '';
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === '(') depth++; else if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ';' && depth === 0 && text[k + 1] === ' ') { out.push(cur.trim()); cur = ''; k++; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function trimRepeats(md, opts = {}) {
  const removed = []; if (!md) return { md, removed };
  const lines = String(md).split('\n');
  let section = '', prob = '';
  const info = lines.map((ln, idx) => { const h = ln.match(/^###\s+(.*)$/); if (h) { section = h[1].trim(); prob = ''; } const pm = ln.match(/^\s*\d+\.\s+\*\*(.+?)\*\*/); if (pm) prob = pm[1]; return { idx, ln, section: h ? '' : section, prob, drop: false }; });

  // ── 1a. a fact twice in one line ──
  for (const r of info) {
    const m = r.ln.match(LABEL); if (!m || !/^\s*[-*]\s/.test(r.ln)) continue;
    const parts = clauses(m[3]); if (parts.length < 2) continue;
    const keep = parts.map(() => true);
    for (let x = 0; x < parts.length; x++) for (let y = x + 1; y < parts.length; y++) {
      if (!keep[x] || !keep[y]) continue;
      const a = toks(parts[x]), b = toks(parts[y]); if (a.length < 2 || b.length < 2) continue;
      const o = overlap(a, b);
      if (o.i >= 2 && o.i / o.min >= 0.8 && sameSet(nums(a), nums(b))) { const drop = a.length >= b.length ? y : x; keep[drop] = false; removed.push({ kind: 'repeat-in-line', line: parts[drop], keptAs: parts[drop === y ? x : y] }); }
    }
    if (keep.some((k) => !k)) r.ln = (m[1] + (m[2] || '') + parts.filter((_, k) => keep[k]).join('; '));
  }

  // ── 1b. the same line under two problems (or twice under one) ──
  // The copy under a generic heading ("Periodic health examination", "Investigations") goes; otherwise the later copy goes.
  const GENERIC = /^(periodic|health maintenance|investigations?\b|administrative|medication|refill|preventive|other|general|screening)/i;
  const ap = info.filter((r) => /assessment/i.test(r.section) && /^\s+[-*]\s/.test(r.ln));
  const seen = [];
  for (const r of ap) {
    const m = r.ln.match(LABEL); const body = (m ? m[3] : r.ln); const t = toks(body); if (t.length < 4) { seen.push({ t, r, body }); continue; }
    const n = nums(t); let dup = null;
    for (const p of seen) { if (p.t.length < 4 || p.r.drop) continue; const o = overlap(t, p.t); if (o.i >= 4 && o.i / o.min >= 0.85 && sameSet(n, nums(p.t))) { dup = p; break; } }
    if (!dup) { seen.push({ t, r, body }); continue; }
    if (dup.r.prob !== r.prob && GENERIC.test(dup.r.prob) && !GENERIC.test(r.prob)) { dup.r.drop = true; removed.push({ kind: 'repeat-between-lines', line: dup.body, keptAs: body, from: dup.r.prob, to: r.prob }); seen.push({ t, r, body }); }
    else { r.drop = true; removed.push({ kind: 'repeat-between-lines', line: body, keptAs: dup.body, from: r.prob, to: dup.r.prob }); }
  }

  // ── 2. plan action told as a story in Subjective, and the plan already holds it ──
  const planToks = info.filter((r) => /assessment/i.test(r.section) && !r.drop && /^\s+[-*]\s/.test(r.ln)).map((r) => { const m = r.ln.match(LABEL); const body = m ? m[3] : r.ln; const t = toks(body); return { t, n: nums(t), body }; });
  if (opts.subjective !== false) for (const r of info) {
    if (!/^subjective/i.test(r.section) || r.drop || !/^\s*[-*]\s/.test(r.ln)) continue;
    const body = r.ln.replace(/^\s*[-*]\s+/, ''); if (!PLAN_CUE.test(body) || /pharmacy|drug ?mart|shoppers|rexall|costco/i.test(body)) continue;
    const t = toks(body); if (t.length < 3) continue; const n = nums(t);
    for (const p of planToks) { const o = overlap(t, p.t); if (o.i >= 3 && o.i / new Set(t).size >= 0.8 && subset(n, p.n)) { r.drop = true; removed.push({ kind: 'plan-action-in-subjective', line: body, keptAs: p.body }); break; } }
  }

  const out = info.filter((r) => !r.drop).map((r) => r.ln);
  return { md: out.join('\n').replace(/\n{3,}/g, '\n\n'), removed };
}
