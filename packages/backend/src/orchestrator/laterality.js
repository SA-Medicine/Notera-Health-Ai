// Laterality: a side error (left vs right) is a patient-safety error.
// If the transcript names only ONE side for a body part ("left eye") and the note names the OTHER side for that part, the note is FLAGGED for the
// doctor to check. The text is never changed automatically: a transcript that names one side once can still be about the other side
// (found on a real test note where an automatic swap would have turned a correct "right knee" into "left"). Candidate quality guard.
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

/** Lines of the note that name a side the transcript does not (when it names exactly one side for that part). Never changes the note. */
export function checkLaterality(note, transcript) {
  const flip = { left: 'right', right: 'left' }; const sideOf = {};
  for (const p of PARTS) { const sd = sidesFor(transcript, p); if (sd.size === 1) sideOf[p] = [...sd][0]; }
  const found = []; if (!Object.keys(sideOf).length) return found;
  const scan = (v) => {
    if (typeof v === 'string') { for (const [p, good] of Object.entries(sideOf)) { const bad = flip[good]; if (sideRe(bad, p, 'i').test(v) && !sideRe(good, p, 'i').test(v)) found.push({ part: p, noteSide: bad, transcriptSide: good, text: v.slice(0, 120) }); } }
    else if (Array.isArray(v)) v.forEach(scan); else if (v && typeof v === 'object') Object.values(v).forEach(scan);
  };
  for (const sec of ['subjective', 'past_medical_history', 'objective']) scan(note?.[sec]); scan(note?.assessment_and_plan);
  return found;
}
