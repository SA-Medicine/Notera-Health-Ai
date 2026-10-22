// Two deterministic checks on the Assessment & Plan, from the candidate-v5 review of 2026-10-22 (Style Spec v2):
//  1. DIAGNOSIS MUST BE THE CLINICIAN'S: Style Spec v1 says "Diagnosis: only if the clinician named one". A "Diagnosis:" whose key words
//     are mostly absent from the transcript (e.g. "Vitamin B12 deficiency" when the doctor said "your B12 is low") is cleared; the problem title stays.
//  2. NO SPOKEN WORDS IN THE PLAN: lines copied from speech ("And you did that for seven days") are removed from the plan fields,
//     and "your kidneys" becomes "the kidneys". Nothing else is reworded.
// Part of Style Spec v2 (approved by the owner 2026-10-22). On by default; opts.qualityGuards=false or QUALITY_GUARDS=0 switches it off.
'use strict';

import { checkLaterality } from './laterality.js';
import { conditionGuard } from './conditionGuard.js';
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

// ── third parties: Style Spec v1 "document only the PATIENT" (a partner's age, surgery, therapy or ex-wife is not the patient's history) ──
const NOUN = String.raw`(?:partner|boyfriend|girlfriend|husband|wife|ex[- ]?(?:wife|husband|partner|boyfriend|girlfriend)|fianc[eé]e?|friend|neighbou?r|colleague|co-?worker|boss|in-laws?|step-?(?:son|daughter|child|children))`;
// a clause ABOUT another person starts with that person ("Boyfriend is 52", "partner in therapy", "Partner's ex-wife is moving"); "Lives with wife" is the patient's own social line and stays
const THIRD_SUBJECT = new RegExp(String.raw`^(?:the |her |his |their |patient's )?${NOUN}\b`, 'i');
const clauses = (l) => String(l || '').split(/;\s*/);
export function thirdPartyLine(line) { return clauses(line).some((c) => THIRD_SUBJECT.test(c.trim())); }
export function dropThirdParty(note, log = () => {}) {
  const removed = [];
  for (const sec of ['past_medical_history']) for (const k of Object.keys(note?.[sec] || {})) {
    const v = note[sec][k]; if (typeof v !== 'string' || !v.trim()) continue;
    const keep = [];
    for (const l of v.split('\n')) {
      if (!thirdPartyLine(l)) { keep.push(l); continue; }
      const kept = clauses(l).filter((c) => !THIRD_SUBJECT.test(c.trim())); removed.push(clauses(l).filter((c) => THIRD_SUBJECT.test(c.trim())).join('; '));
      if (kept.length) keep.push(kept.join('; '));   // the patient's own clauses of the same line stay
    }
    note[sec][k] = keep.join('\n');
  }
  if (removed.length) log('[v2:quality] ' + removed.length + ' line(s) about other people removed from Past Medical History (' + removed.map((x) => x.slice(0, 50)).join(' | ') + ')');
  return removed;
}

export function qualityGuards(note, transcript, log = () => {}, o = {}) {
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
  if (o.thirdParty !== false) out.thirdParty = dropThirdParty(note, log);
  if (o.conditions !== false) out.conditions = conditionGuard(note, transcript, log);   // o.conditions=false (opts.conditionGuard=false / CONDITION_GUARD=0) lets the lab compare with and without it
  out.laterality = checkLaterality(note, transcript);
  if (out.laterality.length) {
    const seen = new Set(); const msg = out.laterality.filter((x) => !seen.has(x.part + x.noteSide) && seen.add(x.part + x.noteSide)).map((x) => 'the note says ' + x.noteSide + ' ' + x.part + ', the recording names the ' + x.transcriptSide + ' ' + x.part).join('; ');
    note.metadata = note.metadata || {}; note.metadata.flags = [...(note.metadata.flags || []), { type: 'laterality_check', field: 'note', message: 'Please check the side: ' + msg + '.', severity: 'warning' }];
    log('[v2:quality] side flagged for review: ' + msg);
  }
  if (out.dxCleared.length || out.speechRemoved) log(`[v2:quality] ${out.dxCleared.length} unsupported diagnosis line(s) cleared${out.dxCleared.length ? ' (' + out.dxCleared.join(' | ') + ')' : ''}; ${out.speechRemoved} spoken fragment(s) removed from the plan`);
  return out;
}
