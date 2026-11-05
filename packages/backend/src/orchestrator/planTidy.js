// Plan tidy (2026-11-05, owner's Heidi comparison: "consistent plan"). Pure text, no model call, nothing is added and no wording is changed:
//   - a problem title loses its closing full stop ("Weight management." -> "Weight management"), like the titles without one
//   - a plan bullet that starts in lower case gets a capital letter ("increased appetite" -> "Increased appetite")
//   - a bullet that repeats an earlier bullet of the same problem word for word (ignoring case and a closing full stop) is dropped once
//   - Objective: a lower-case start gets a capital ("hemoglobin: fine"); "LDL 2.5 (up from 2.2). Abdominal wall ultrasound: ..." becomes two bullets
//   - the 2nd, 3rd... words stay as they are: no guessing which capital letter is a name
// PLAN_TIDY=0 switches it off. Only the Assessment & Plan section is touched.
'use strict';

const norm = (s) => String(s).toLowerCase().replace(/[.\s]+$/, '').replace(/\s+/g, ' ').trim();

export function planTidy(md) {
  const out = []; let inAP = false, seen = new Set(), titles = 0, caps = 0, dupes = 0;
  let inO = false, splitO = 0;
  for (const ln of String(md || '').split('\n')) {
    const h = ln.match(/^###\s+(.*)$/); if (h) { inAP = /assessment/i.test(h[1]); inO = /^objective/i.test(h[1].trim()); out.push(ln); continue; }
    if (inO) {   // Objective: a capital letter on a lower-case start ("hemoglobin: fine"), and a second labelled finding glued after a full stop gets its own bullet
      const ob = ln.match(/^(\s*[-•*]\s+)(.*\S)\s*$/);
      if (ob) {
        const parts = ob[2].split(/\.\s+(?=[A-Z][^.:;]{2,40}:\s)/);
        parts.forEach((p, i) => { const w = p.match(/^[a-z]+(?=[\s,;:]|$)/); if (w && w[0].length >= 3) { caps++; p = p[0].toUpperCase() + p.slice(1); } out.push(ob[1] + p + (i < parts.length - 1 ? '.' : '')); });
        splitO += parts.length - 1; continue;
      }
    }
    if (!inAP) { out.push(ln); continue; }
    const t = ln.match(/^(\s*\d+\.\s+\*\*)(.+?)(\*\*\s*)$/);
    if (t) {
      seen = new Set(); const title = t[2].replace(/\.+\s*$/, '');
      if (title !== t[2]) titles++;
      out.push(t[1] + title + t[3]); continue;
    }
    const b = ln.match(/^(\s*[-*]\s+)(.*\S)\s*$/);
    if (!b) { out.push(ln); continue; }
    const key = norm(b[2]); if (key && seen.has(key)) { dupes++; continue; } seen.add(key);
    const w = b[2].match(/^[a-z]+(?=[\s,;:]|$)/);
    if (w && w[0].length >= 3) { caps++; out.push(b[1] + b[2][0].toUpperCase() + b[2].slice(1)); } else out.push(ln);
  }
  return { md: out.join('\n'), titles, caps, dupes, splitO };
}
