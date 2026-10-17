// ─────────────────────────────────────────────────────────────────────────────
// Drug-name guard. Speech recognition and de-identification garble drug names ("corinderol"). The writer then "fixes" the
// word into a DIFFERENT real drug (Coricidin), which is a patient-safety error. Rule: a drug name in the note must be
// something the transcript actually says. If a medication name is not in the transcript (not even as a near spelling),
// the note keeps the word AS SPOKEN (closest transcript word) and carries a review flag; if nothing resembles it, the
// name is left and flagged. Deterministic, no model call.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

const NOT_DRUG = new Set('medication medications medicine medicines pill pills tablet tablets capsule capsules cream ointment injection injections shot shots inhaler spray drops patch supplement supplements vitamin vitamins none daily twice once nightly weekly monthly morning evening night every needed prn oral topical current started stopped continue changed increase decrease dose doses'.split(' '));

/** Medication names the note refers to: the checklist's names and the "Current medications:" line. */
export function medNames(note, check) {
  const names = new Set();
  for (const m of (check?.medications || [])) { const n = String(m?.name || '').trim(); if (n) names.add(n); }
  const other = String(note?.past_medical_history?.other || '');
  for (const ln of other.split('\n')) {
    const body = ln.replace(/^\s*current medications?\s*:\s*/i, '');
    if (body === ln && !/medication/i.test(ln)) continue;
    for (const part of body.split(/[,;]/)) { const n = part.trim().replace(/\s+\d.*$/, '').replace(/\s+(daily|twice|once|bid|tid|qid|prn).*$/i, '').trim(); if (n && n.length >= 4) names.add(n); }
  }
  return [...names].filter((n) => !NOT_DRUG.has(letters(n)) && letters(n).length >= 4 && !/\s/.test(n.trim()) );
}

/** → { replaced: [{ from, to }], flagged: [{ name, why }] } and mutates `note` (as-spoken replacement) + metadata.flags. */
export function guardDrugNames(note, transcript, check, log = () => {}) {
  const T = String(transcript || '').toLowerCase();
  const tWords = [...new Set(T.match(/[a-z]{5,18}/g) || [])];
  const tSet = new Set(tWords);
  const out = { replaced: [], flagged: [] };
  for (const name of medNames(note, check)) {
    const key = letters(name);
    if (T.includes(key) || tSet.has(key)) continue;                                   // said as written
    if (tWords.some((w) => Math.abs(w.length - key.length) <= 2 && lev(w, key) <= 1)) continue;   // spelling variant of a spoken word
    // not said: find the word the patient/clinician actually said (as heard)
    let best = null, bs = 0;
    const prefix = (w) => { let i = 0; while (i < w.length && i < key.length && w[i] === key[i]) i++; return i; };
    for (const w of tWords) { if (w[0] !== key[0]) continue; const s = sim(w, key) + 0.04 * Math.min(prefix(w), 5); if (s > bs) { bs = s; best = w; } }
    if (best && (bs >= 0.55 || (prefix(best) >= 3 && bs >= 0.5))) {   // as heard: shares the start of the word, or is a close spelling
      const spoken = best[0].toUpperCase() + best.slice(1);
      const rx = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'); let n = 0;
      const fix = (v) => (typeof v === 'string' ? v.replace(rx, () => { n++; return spoken; }) : v);
      for (const sec of ['subjective', 'past_medical_history', 'objective']) for (const k of Object.keys(note[sec] || {})) note[sec][k] = fix(note[sec][k]);
      for (const p of (note.assessment_and_plan || [])) for (const f of ['issue', 'diagnosis', 'assessment', 'investigations_planned', 'treatment_planned', 'referrals']) p[f] = fix(p[f]);
      out.replaced.push({ from: name, to: spoken, occurrences: n });
      (note.metadata.flags ||= []).push({ type: 'medication_unverified', field: 'medications', message: `Heard "${spoken}"; the model had written "${name}", which is not in the transcript. Kept as spoken — please verify the drug name.`, severity: 'warning' });
      log(`[v2:drugs] "${name}" is not in the transcript — kept as spoken "${spoken}" (${n} place${n === 1 ? '' : 's'}) and flagged`);
    } else {
      out.flagged.push({ name, why: 'no similar word in the transcript' });
      (note.metadata.flags ||= []).push({ type: 'medication_unverified', field: 'medications', message: `"${name}" is not in the transcript and nothing similar was heard — please verify this medication.`, severity: 'warning' });
      log(`[v2:drugs] "${name}" is not in the transcript and nothing similar was heard — flagged`);
    }
  }
  return out;
}
