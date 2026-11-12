// Plan tidy (2026-11-05, owner's Heidi comparison: "consistent plan"). Pure text, no model call, nothing is added and no wording is changed except capital letters and full stops:
//   - a problem title loses its closing full stop ("Weight management." -> "Weight management")
//   - a plan bullet that starts in lower case gets a capital letter ("increased appetite" -> "Increased appetite")
//   - inside a plan bullet an everyday word that was written with a capital in the middle of the phrase ("Continue Current medication regimen", "Arrange Blood pressure check") is lower-cased;
//     only words from a fixed list of plain clinic words, never a name, a drug or a condition
//   - a bullet that repeats an earlier bullet of the same problem word for word (ignoring case and a closing full stop) is dropped once
//   - inside one problem the warning lines ("Return if…", "Go to the emergency department…") go last and the follow-up line after them: a stable re-order, no line changes
//   - Subjective, Past Medical History, Objective and the plan: a closing full stop on a one-sentence bullet is removed, so every bullet ends the same way
//   - Objective: a lower-case start gets a capital; "LDL 2.5 (up from 2.2). Abdominal wall ultrasound: ..." becomes two bullets
// PLAN_TIDY=0 switches it off.
'use strict';

const norm = (s) => String(s).toLowerCase().replace(/[.\s]+$/, '').replace(/\s+/g, ' ').trim();
const PLAIN = new Set(('current,sleeping,blood,monitoring,medication,medications,regimen,pressure,check,checks,test,tests,scan,therapy,treatment,dose,doses,cream,tablets,tablet,pain,exam,exams,review,appointment,referral,lifestyle,diet,exercise,weight,physical,activity,regular,daily,weekly,monthly,twice,once,symptoms,symptom,management,measures,fluid,intake,eye,foot,annual,supportive,shoes,pills,pill,course,plan,visit,results,result,levels,level,monitor,discussed,advised,deferred,stable,unchanged,further,repeat,urgent,routine,home,care,support,options,option').split(','));
const FILLER = new Set(['current management', 'management as discussed', 'as discussed', 'plan as discussed', 'discussed with patient', 'discussed']);   // lines that carry no clinical content
const KEEP_DOT = /(?:\b(?:dr|mr|mrs|ms|vs|etc|approx|no|e\.g|i\.e)|\d)\.$/i;
const WARN = /^(return|go to|seek|call|present|attend|come back|contact)\b/i;
const FU = /^(follow-?\s?up|recheck|re-?check|review in|see (?:you|again)|next (?:visit|appointment))\b/i;
const rank = (t) => (WARN.test(t) ? 1 : FU.test(t) ? 2 : 0);

function lowerPlain(t) {
  return t.replace(/(?<=[a-z]\s)([A-Z][a-z]+)(?=[\s,;.]|$)/g, (m, w) => (PLAIN.has(w.toLowerCase()) ? w.toLowerCase() : m));   // only after a lower-case word, so never after a colon, comma or full stop
}
const stripDot = (t) => (/\.$/.test(t) && !/\.\s/.test(t.slice(0, -1)) && !KEEP_DOT.test(t) ? t.slice(0, -1) : t);

export function planTidy(md) {
  const L = String(md || '').split('\n'); const out = []; let sec = '', seen = new Set(), titles = 0, caps = 0, dupes = 0, splitO = 0, dots = 0, lowered = 0, reordered = 0, echoes = 0, titleKey = '';
  let group = null;   // the bullets of the current plan problem, flushed in a stable re-order
  const flush = () => { if (!group) return; const r = group.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g.text) - rank(b.g.text) || a.i - b.i); if (r.some((x, i) => x.i !== i)) reordered++; r.forEach((x) => out.push(x.g.raw)); group = null; };
  let notes = 0;
  for (let ln of L) {
    if (/^\s*[-•*]\s/.test(ln) && /\s*\((?:note|nb)\s*:[^)]*\)\.?\s*$/i.test(ln)) { ln = ln.replace(/\s*\((?:note|nb)\s*:[^)]*\)(\.?)\s*$/i, '$1'); notes++; }   // the writer's own remark "(Note: concise synthesis of reported history)" is not part of the note
    const h = ln.match(/^###\s+(.*)$/);
    if (h) { flush(); sec = /assessment/i.test(h[1]) ? 'ap' : /^objective/i.test(h[1].trim()) ? 'o' : /^(subjective|past medical)/i.test(h[1].trim()) ? 's' : ''; out.push(ln); continue; }
    const ob = sec ? ln.match(/^(\s*[-•*]\s+)(.*\S)\s*$/) : null;
    if (sec === 'o' && ob) {
      const parts = ob[2].split(/\.\s+(?=[A-Z][^.:;]{2,40}:\s)/);
      parts.forEach((p, i) => { const w = p.match(/^[a-z]+(?=[\s,;:]|$)/); if (w && (w[0].length >= 3 || w[0] === 'no')) { caps++; p = p[0].toUpperCase() + p.slice(1); } const q = i < parts.length - 1 ? p + '.' : stripDot(p); if (q !== p) dots++; out.push(ob[1] + q); });
      splitO += parts.length - 1; continue;
    }
    if (sec === 's' && ob) { const q = stripDot(ob[2]); if (q !== ob[2]) dots++; out.push(ob[1] + q); continue; }
    if (sec !== 'ap') { out.push(ln); continue; }
    const t = ln.match(/^(\s*\d+\.\s+\*\*)(.+?)(\*\*\s*)$/);
    if (t) { flush(); seen = new Set(); const title = t[2].replace(/\.+\s*$/, ''); titleKey = norm(title); if (title !== t[2]) titles++; out.push(t[1] + title + t[3]); group = []; continue; }
    const b = ln.match(/^(\s*[-*]\s+)(.*\S)\s*$/);
    if (!b) { if (!ln.trim()) flush(); out.push(ln); continue; }
    const key = norm(b[2]); if (key && seen.has(key)) { dupes++; continue; } seen.add(key);
    if (key && (key === titleKey || FILLER.has(key))) { echoes++; continue; }   // "Medication renewals" under the problem "Medication renewals", or a line that says nothing ("Current management")
    let x = b[2]; const w = x.match(/^[a-z]+(?=[\s,;:]|$)/);
    if (w && (w[0].length >= 3 || w[0] === 'no')) { caps++; x = x[0].toUpperCase() + x.slice(1); }
    const lo = lowerPlain(x); if (lo !== x) { lowered++; x = lo; }
    const sd = stripDot(x); if (sd !== x) { dots++; x = sd; }
    const rec = { raw: b[1] + x, text: x };
    if (group) group.push(rec); else out.push(rec.raw);
  }
  flush();
  return { md: out.join('\n'), titles, caps, dupes, splitO, dots, lowered, reordered, notes, echoes };
}
