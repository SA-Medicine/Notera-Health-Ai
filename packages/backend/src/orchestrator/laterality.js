// Laterality: a side error (left vs right) is a patient-safety error.
// If the transcript names only ONE side for a body part ("left eye") and the note names the other side for that same part, the note's side is
// replaced by the transcript's. If the transcript names both sides for the part, or none, nothing is touched. Candidate quality guard (see qualityGuards.js).
'use strict';

export const PARTS = ['eye', 'ear', 'knee', 'hip', 'ankle', 'foot', 'hand', 'arm', 'leg', 'shoulder', 'elbow', 'wrist', 'breast', 'ovary', 'testicle', 'testis', 'kidney', 'lung', 'thigh', 'calf', 'heel', 'toe', 'finger', 'thumb', 'clavicle', 'flank', 'groin', 'jaw', 'cheek', 'temple'];
const GAP = String.raw`(?:[\s,'-]+\w+){0,2}?[\s,'-]+`;   // at most two words between the side and the body part

const sideRe = (side, part, flags = '') => new RegExp(String.raw`\b${side}\b(?=${GAP}${part}s?\b)`, flags);

/** Sides the text names for a body part ("left eye", "left upper eye lid"). */
export function sidesFor(text, part) {
  const t = String(text || '').toLowerCase(); const sides = new Set();
  for (const s of ['left', 'right']) if (sideRe(s, part).test(t)) sides.add(s);
  return sides;
}

export function fixLaterality(note, transcript, log = () => {}) {
  const fixes = []; const flip = { left: 'right', right: 'left' }; const sideOf = {};
  for (const p of PARTS) { const s = sidesFor(transcript, p); if (s.size === 1) sideOf[p] = [...s][0]; }
  if (!Object.keys(sideOf).length) return fixes;
  const fixText = (text) => {
    let out = text;
    for (const [p, good] of Object.entries(sideOf)) {
      const bad = flip[good];
      if (!sideRe(bad, p, 'i').test(out)) continue;
      if (sideRe(good, p, 'i').test(out)) continue;   // the same line already names the right side too
      out = out.replace(sideRe(bad, p, 'gi'), (m) => { fixes.push(`${m.toLowerCase()} ${p} -> ${good}`); return m[0] === m[0].toUpperCase() ? good[0].toUpperCase() + good.slice(1) : good; });
    }
    return out;
  };
  const walk = (v) => {
    if (typeof v === 'string') return fixText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = walk(v[k]); return v; }
    return v;
  };
  for (const sec of ['subjective', 'past_medical_history', 'objective']) if (note?.[sec]) note[sec] = walk(note[sec]);
  if (note?.assessment_and_plan) note.assessment_and_plan = walk(note.assessment_and_plan);
  if (fixes.length) log(`[v2:quality] laterality corrected ${fixes.length} time(s): ${[...new Set(fixes)].join(', ')}`);
  return fixes;
}
