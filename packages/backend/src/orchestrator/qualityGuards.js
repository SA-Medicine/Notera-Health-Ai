// Two deterministic checks on the Assessment & Plan, from the candidate-v5 review of 2026-10-22 (candidate, OFF by default):
//  1. DIAGNOSIS MUST BE THE CLINICIAN'S: Style Spec v1 says "Diagnosis: only if the clinician named one". A "Diagnosis:" whose key words
//     are mostly absent from the transcript (e.g. "Vitamin B12 deficiency" when the doctor said "your B12 is low") is cleared; the problem title stays.
//  2. NO SPOKEN WORDS IN THE PLAN: lines copied from speech ("And you did that for seven days") are removed from the plan fields,
//     and "your kidneys" becomes "the kidneys". Nothing else is reworded.
// Enabled per call (opts.qualityGuards) or with QUALITY_GUARDS=1.
'use strict';

import { checkLaterality } from './laterality.js';
export { checkLaterality, sidesFor } from './laterality.js';

const NUMWORD = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const stem = (w) => w.replace(/ae/g, 'e').replace(/oe/g, 'e').replace(/(osis|itis|emia|ia|ing|ion|ed|es|s|y)$/, '').slice(0, 6);
const STOP = new Set(['the', 'and', 'with', 'for', 'from', 'type', 'due', 'likely', 'acute', 'chronic', 'mild', 'mildly', 'status', 'post', 'bilateral', 'left', 'right', 'essential', 'primary', 'secondary', 'recurrent', 'persistent', 'unspecified', 'disease', 'disorder']);
const content = (s) => norm(s).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)).map(stem);
const spoken = (t) => norm(t).replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (w) => NUMWORD[w]);

/** Share of the diagnosis' key words found in the transcript (1 = all). */
export function diagnosisSupport(diagnosis, transcriptSet) {
  const ks = [...new Set(content(diagnosis))]; if (!ks.length) return 1;
  return ks.filter((k) => transcriptSet.has(k) || [...transcriptSet].some((t) => t.length >= 4 && k.length >= 4 && (t.startsWith(k.slice(0, 4)) && k.startsWith(t.slice(0, 4))))).length / ks.length;
}

const SPEECH = /\b(you|you're|you've|you'll|i|i'll|i'm|i've|we|we'll|let's|okay|yeah|uh|um)\b/i;
export function cleanSpeech(text) {
  const parts = String(text || '').split('\n').flatMap((l) => l.split('; ')).map((p) => p.trim()).filter(Boolean);
  const kept = parts.map((p) => p.replace(/\byour\b/gi, 'the')).filter((p) => !SPEECH.test(p));
  return { text: kept.join('; '), removed: parts.length - kept.length };
}

export function qualityGuards(note, transcript, log = () => {}) {
  const T = new Set(content(spoken(transcript))); const out = { dxCleared: [], speechRemoved: 0 };
  for (const it of note?.assessment_and_plan || []) {
    if (!it || typeof it !== 'object') continue;
    if (String(it.diagnosis || '').trim()) {
      const s = diagnosisSupport(it.diagnosis, T);
      if (s < 0.5) { out.dxCleared.push(String(it.diagnosis).trim()); it.diagnosis = ''; if (!String(it.issue || '').trim()) it.issue = out.dxCleared[out.dxCleared.length - 1]; }
    }
    for (const f of ['investigations_planned', 'treatment_planned', 'referrals']) {
      if (!it[f]) continue; const r = cleanSpeech(it[f]); if (r.removed || r.text !== it[f].split('\n').join('; ')) { out.speechRemoved += r.removed; it[f] = r.text; }
    }
  }
  out.laterality = checkLaterality(note, transcript);
  if (out.laterality.length) {
    const seen = new Set(); const msg = out.laterality.filter((x) => !seen.has(x.part + x.noteSide) && seen.add(x.part + x.noteSide)).map((x) => 'the note says ' + x.noteSide + ' ' + x.part + ', the recording names the ' + x.transcriptSide + ' ' + x.part).join('; ');
    note.metadata = note.metadata || {}; note.metadata.flags = [...(note.metadata.flags || []), { type: 'laterality_check', field: 'note', message: 'Please check the side: ' + msg + '.', severity: 'warning' }];
    log('[v2:quality] side flagged for review: ' + msg);
  }
  if (out.dxCleared.length || out.speechRemoved) log(`[v2:quality] ${out.dxCleared.length} unsupported diagnosis line(s) cleared${out.dxCleared.length ? ' (' + out.dxCleared.join(' | ') + ')' : ''}; ${out.speechRemoved} spoken fragment(s) removed from the plan`);
  return out;
}
