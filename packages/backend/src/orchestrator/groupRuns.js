// Group runs (2026-11-12, the doctor's feedback on Seema Aggarwal's notes): "Continue Liderm / Continue Protopic / Continue Lorazepam" must read "Continue Liderm, Protopic, Lorazepam",
// and twelve Subjective lines that each start with "Often ..." must read as a few bullets of 2-3 points.
// Pure text, no model call: only a REPEATED first word is dropped; every other word of every line stays, in the same order. GROUP_RUNS=0 switches it off.
//   PLAN      a run of 2+ neighbouring bullets of one problem that start with the same verb (Continue, Start, Stop, Arrange, Avoid, ...) becomes one bullet "Verb A, B, C"
//             (or "Verb A; B; C" when an item has its own comma or a number). Conditional lines (if / unless / until / when) and labelled lines stay as they are.
//   PLAN      two bullets of one problem that say the same thing (the content words of one are the content words of the other, or 60% overlap) -> the longer one stays.
//   SUBJECTIVE a run of 3+ neighbouring bullets that start with the same plain word ("Often", "Denies", "No", "Reports", "Feels" ...) becomes bullets "Often: a; b; c" / "Denies a, b, c"
//             of up to about 135 characters, so the doctor reads two or three points per bullet.
'use strict';

const PLAN_VERBS = /^(continue|start|stop|arrange|avoid|increase|decrease|recommend(?:ed)?|prescrib(?:e|ed)|order(?:ed)?|refill|renew|reduce)\s+(.+)$/i;
const CONDITIONAL = /\b(if|unless|until|when|should|as needed|prn)\b/i;
const STOP = new Set('with that this from have been will were they them then than into over about after before while patient plan discussed planned requested provided given needed'.split(' '));
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');
const cwords = (s) => new Set((String(s).toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w)).map(stem));
const bullet = (ln) => { const m = String(ln).match(/^(\s*[-•*]\s+)(.*\S)\s*$/); return m ? { pre: m[1], text: m[2] } : null; };
const wc = (s) => (String(s).match(/\S+/g) || []).length;

function mergeVerbRun(items, verb) {
  const simple = items.every((x) => !/[,;\d]/.test(x) && wc(x) <= 4);
  return verb + ' ' + items.join(simple ? ', ' : '; ');
}

function planProblem(group, stats) {
  // group: [{raw, pre, text}] bullets of one problem, in order
  const out = []; let i = 0;
  while (i < group.length) {
    const g = group[i]; const m = g.text.match(PLAN_VERBS);
    const ok = (x) => { const mm = x.text.match(PLAN_VERBS); return mm && mm[1].toLowerCase() === (m && m[1].toLowerCase()) && !CONDITIONAL.test(x.text) && !/^[^:]{2,30}:\s/.test(x.text) && wc(x.text) <= 12; };
    if (m && ok(g)) {
      let j = i; const items = []; while (j < group.length && ok(group[j])) { items.push(group[j].text.match(PLAN_VERBS)[2].replace(/[.;,\s]+$/, '')); j++; }
      if (items.length >= 2) {
        const verb = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
        out.push({ ...g, text: mergeVerbRun(items, verb) }); stats.planMerged += items.length - 1; i = j; continue;
      }
    }
    out.push(g); i++;
  }
  // near duplicates: the longer stays
  const dropped = new Set();
  for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++) {
    if (dropped.has(a) || dropped.has(b)) continue;
    const A = cwords(out[a].text), B = cwords(out[b].text); if (A.size < 2 || B.size < 2) continue;
    const inter = [...A].filter((w) => B.has(w)).length; const small = Math.min(A.size, B.size);
    const same = inter === small || inter / (A.size + B.size - inter) >= 0.6;
    const nums = (t) => (String(t).match(/\d+(?:\.\d+)?/g) || []).sort().join(',');
    if (!same || nums(out[a].text) !== nums(out[b].text)) continue;   // never fold lines that carry different numbers
    const keepA = out[a].text.length >= out[b].text.length; dropped.add(keepA ? b : a); stats.planDupes++;
  }
  return out.filter((_, k) => !dropped.has(k));
}

const SUBJ_LEAD = new Set('often,sometimes,occasionally,rarely,usually,always,never,denies,no,reports,feels,notes,describes,complains'.split(','));
const DENY = new Set(['denies', 'no', 'never']);

function subjectiveRuns(lines, stats, maxChars = 135) {
  // lines: [{pre,text}] bullets of one blank-line group
  const out = []; let i = 0;
  const lead = (t) => { const w = t.match(/^([A-Za-z]+)\s+(.+)$/); return w && SUBJ_LEAD.has(w[1].toLowerCase()) ? { w: w[1].toLowerCase(), rest: w[2] } : null; };
  while (i < lines.length) {
    const l0 = lead(lines[i].text);
    if (l0) {
      let j = i; const items = [];
      while (j < lines.length) { const l = lead(lines[j].text); if (!l || l.w !== l0.w || wc(lines[j].text) > 16 || /^[^:]{2,30}:\s/.test(lines[j].text)) break; items.push(l.rest.replace(/[.;,\s]+$/, '')); j++; }
      if (items.length >= 3) {
        const W = l0.w[0].toUpperCase() + l0.w.slice(1); const deny = DENY.has(l0.w);
        const head = deny ? W + ' ' : W + ': '; const sep = deny ? ', ' : '; ';
        let cur = [];
        const flushChunk = () => { if (!cur.length) return; out.push({ pre: lines[i].pre, text: head + cur.join(sep) }); cur = []; };
        for (const it of items) { if (cur.length && (head + cur.join(sep) + sep + it).length > maxChars) flushChunk(); cur.push(it); }
        flushChunk(); stats.subjMerged += items.length - 1; i = j; continue;
      }
    }
    out.push(lines[i]); i++;
  }
  // a chunk that ended with one item alone is the original line again
  return out;
}

// PAST MEDICAL HISTORY: two or more lifestyle lines ("Works as a teacher", "Attends yoga regularly", "Lives with husband", "Occasionally smoked, now stopped") become one labelled line
// "Social: works as a teacher; attends yoga regularly", in the place of the first of them, the way "Medications:" is one labelled line. Wording is kept, only the first letter goes lower case.
const SOCIAL = /^(?:lives?|living|works?|working|worked|retired|married|single|divorced|widowed|attends|exercises?|walks|smokes?|smoker|non-?smoker|drinks?|alcohol|vapes?|occasionally smoked|former (?:occasional )?(?:smoker|smoking)|never (?:smoked|consumed|drank|drinks?)|cannabis|has (?:\w+ )?(?:children|kids))\b/i;
function pmhSocial(lines, stats, maxChars = 135) {
  const idx = lines.map((l, i) => (SOCIAL.test(l.text) && wc(l.text) <= 20 && !/^[^:]{2,30}:\s/.test(l.text) ? i : -1)).filter((i) => i >= 0);
  if (idx.length < 2) return lines;
  const items = idx.map((i) => lines[i].text.replace(/[.;,\s]+$/, '').replace(/^./, (c) => c.toLowerCase()));
  const chunks = []; let cur = [];
  for (const it of items) { if (cur.length && ('Social: ' + cur.join('; ') + '; ' + it).length > maxChars) { chunks.push(cur); cur = []; } cur.push(it); }
  chunks.push(cur);
  const out = []; const first = idx[0];
  lines.forEach((l, i) => { if (i === first) chunks.forEach((c) => out.push({ pre: l.pre, text: 'Social: ' + c.join('; ') })); else if (!idx.includes(i)) out.push(l); });
  stats.socialGrouped += idx.length - chunks.length; return out;
}

export function groupRuns(md) {
  const L = String(md || '').split('\n'); const out = []; const stats = { planMerged: 0, planDupes: 0, subjMerged: 0, socialGrouped: 0 };
  let hGroup = [];
  const flushPmh = () => { if (!hGroup.length) return; pmhSocial(hGroup, stats).forEach((g) => out.push(g.pre + g.text)); hGroup = []; };
  let sec = '', group = null; let blockStart = -1;
  const flushPlan = () => { if (!group) return; planProblem(group, stats).forEach((g) => out.push(g.raw ? g.pre + g.text : g.text)); group = null; };
  let sGroup = [];
  const flushSubj = () => { if (!sGroup.length) return; subjectiveRuns(sGroup, stats).forEach((g) => out.push(g.pre + g.text)); sGroup = []; };
  for (const ln of L) {
    const h = ln.match(/^###\s+(.*)$/);
    if (h) { flushPlan(); flushSubj(); flushPmh(); sec = /assessment/i.test(h[1]) ? 'ap' : /^subjective/i.test(h[1].trim()) ? 's' : /^past medical/i.test(h[1].trim()) ? 'h' : ''; out.push(ln); continue; }
    if (sec === 'h') {
      const b = bullet(ln);
      if (b) { hGroup.push(b); continue; }
      flushPmh(); out.push(ln); continue;
    }
    if (sec === 's') {
      const b = bullet(ln);
      if (b) { sGroup.push(b); continue; }
      flushSubj(); out.push(ln); continue;
    }
    if (sec === 'ap') {
      if (/^\s*\d+\.\s+\*\*/.test(ln)) { flushPlan(); out.push(ln); group = []; continue; }
      const b = bullet(ln);
      if (b && group) { group.push({ ...b, raw: ln }); continue; }
      flushPlan(); out.push(ln); if (/^\s*\d+\.\s+\*\*/.test(ln)) group = []; continue;
    }
    out.push(ln);
  }
  flushPlan(); flushSubj(); flushPmh();
  return { md: out.join('\n'), ...stats };
}
