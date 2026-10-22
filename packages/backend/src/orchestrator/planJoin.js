// "Each label once per problem, items joined" (format principle F2, from the gold-note analysis of 2026-10-22).
// The renderer prints one line per sentence of investigations_planned / treatment_planned / referrals, so one problem could show
// "Treatment planned:" four times. Gold notes write one line per label with the items joined. This step joins the parts of each
// field with "; " before rendering. It only joins existing text: nothing is added, removed (except exact repeats) or reworded,
// and no label, heading or order changes. Lives outside the locked files; Style Spec v1 hashes are unchanged.
'use strict';

const FIELDS = ['investigations_planned', 'treatment_planned', 'referrals'];

/** Same split the renderer uses: lines, then sentence boundaries ("…ing. Next" but not "Dr. Smith"). */
export function parts(val) {
  const arr = Array.isArray(val) ? val : String(val || '').split('\n'); const out = [];
  for (const raw of arr) {
    const line = String(raw).trim().replace(/^[-•*]\s*/, ''); if (!line) continue;
    for (const p of line.split(/(?<=[a-z0-9]{3}[.!?])\s+(?=[A-Z(])/)) { const t = p.trim(); if (t) out.push(t); }
  }
  return out;
}
export function joinParts(val) {
  const seen = new Set(); const ps = [];
  for (const p of parts(val)) { const t = p.replace(/[.;,\s]+$/, ''); const k = t.toLowerCase(); if (t && !seen.has(k)) { seen.add(k); ps.push(t); } }
  return ps.length > 1 ? ps.join('; ') : (ps[0] ?? '');
}

/** Joins in place; returns how many fields had more than one part. */
export function joinPlanLines(note, log = () => {}) {
  let joined = 0;
  for (const it of (note?.assessment_and_plan || [])) {
    if (!it || typeof it !== 'object') continue;
    for (const f of FIELDS) {
      if (!it[f]) continue; const n = parts(it[f]).length; if (n < 2) continue;
      it[f] = joinParts(it[f]); joined++;
    }
  }
  if (joined) log(`[v2:join] ${joined} plan field(s) with several lines joined into one line per label`);
  return joined;
}
