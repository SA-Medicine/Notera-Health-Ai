// Placement rules (Style Spec v2.2, owner 2026-10-24: "still misplaces of data"). A review of 77 real notes found "misplaced fact" to be the most
// common finding (86 plan gaps and 107 wrong lines): a measurement written as a treatment, a vaccine given in the visit written as an examination
// finding, the history repeated under Referrals. Each rule here MOVES a line to where it belongs; none adds wording.
//   1. a vital sign with a number sitting in a plan field            -> Objective, Vital Signs
//   2. a vaccine / injection given in the visit, written as Objective  -> the plan, "Immunisation" problem, as an item given today
//   3. Referrals that are not referrals: a refill / prescription / vaccine / note goes to Treatment; a bare repeat of the problem or of a symptom is
//      removed (an echo such as "Referrals: Hair thinning" carries nothing); anything else moves to Treatment
//   4. a very long Referrals text that names no referral              -> removed from Referrals (it repeats the history; the Subjective has it)
// Off switch: PLACEMENT_RULES=0.
'use strict';

import { overlap } from './planSweep.js';

const VITAL = /\b(blood pressure|bp|pulse|heart rate|hr|temperature|temp|spo2|oxygen sat\w*|saturation|weight|bmi|respiratory rate|rr|height)\b[^.;]{0,30}\d/i;
const ACTION = /\b(start|stop|continue|increase|decrease|prescrib\w*|monitor|check|repeat|recheck|refer\w*|follow|advis\w*|take|avoid|reduce|aim|target|goal|home)\b/i;
const GIVEN_IN_VISIT = /\b(administered|vaccine given|vaccine administered|injection given|lot[:#\s]|expiry|exp\.?\s)\b/i;
const REFERRAL_WORDS = /\b(refer\w*|consult\w*|specialist|clinic|surgeon|cardiolog\w*|dermatolog\w*|neurolog\w*|physio\w*|therap\w*|hospital|urgent care|referral|see\b)/i;
const NOT_A_REFERRAL = /refill|renew|prescri|medication|\brx\b|requisition|vaccine|shot\b|injection|note for|letter|\bform\b/i;
const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
const lines = (v) => String(v || '').split(/\n|;\s+/).map((x) => x.trim()).filter(Boolean);
const join = (a, b) => [String(a || '').trim(), b].filter(Boolean).join('\n');
const cap = (l) => l.replace(/^./, (c) => c.toUpperCase());
const addTreatment = (p, l) => { p.treatment_planned = p.treatment_planned ? `${String(p.treatment_planned).replace(/[;\s]+$/, '')}; ${cap(l)}` : cap(l); };

export function fixPlacementV2(note, log = () => {}) {
  const moved = { vitals: 0, given: 0, referralsCut: 0, referralsMoved: 0, echoes: 0 }; const obj = (note.objective ||= {});
  const subjText = strings(note.subjective).join(' ');
  for (const p of note.assessment_and_plan || []) {
    if (!p) continue;
    for (const f of ['treatment_planned', 'investigations_planned', 'assessment']) {
      const keep = [];
      for (const l of lines(p[f])) {
        if (VITAL.test(l) && !ACTION.test(l) && /\d/.test(l) && l.length < 80 && overlap(l, obj.vital_signs || '') < 0.8) { obj.vital_signs = join(obj.vital_signs, cap(l)); moved.vitals++; } else keep.push(l);
      }
      if (keep.length !== lines(p[f]).length) p[f] = keep.join(f === 'assessment' ? '\n' : '; ');
    }
    // a short line with no number that only repeats the problem or a symptom the Subjective already has
    const echo = (l) => l.split(/\s+/).length <= 6 && !/\d/.test(l) && (overlap(l, String(p.issue || '')) >= 0.7 || overlap(l, subjText) >= 0.8);
    const ref = String(p.referrals || ''); if (ref.length > 220 && !REFERRAL_WORDS.test(ref)) { p.referrals = ''; moved.referralsCut++; }
    const keepRef = [];
    for (const l of lines(p.referrals)) {
      if (REFERRAL_WORDS.test(l) || l.length > 220) { keepRef.push(l); continue; }
      if (NOT_A_REFERRAL.test(l)) { addTreatment(p, l); moved.referralsMoved++; }
      else if (echo(l)) moved.echoes++;
      else { addTreatment(p, l); moved.referralsMoved++; }
    }
    if (keepRef.length !== lines(p.referrals).length) p.referrals = keepRef.join('; ');
    for (const f of ['treatment_planned', 'investigations_planned']) {
      const k = lines(p[f]).filter((l) => { if (echo(l) && overlap(l, String(p.issue || '')) >= 0.8) { moved.echoes++; return false; } return true; });
      if (k.length !== lines(p[f]).length) p[f] = k.join(f === 'treatment_planned' ? '; ' : '\n');
    }
  }
  for (const f of ['examination', 'completed_investigations']) {
    const keep = [];
    for (const l of lines(obj[f])) {
      if (GIVEN_IN_VISIT.test(l) && /\b(vaccin\w*|injection|shot|mmr|tdap|flu|influenza|covid|hepatitis|shingrix|prevnar|pneumo\w*)\b/i.test(l)) {
        const ap = (note.assessment_and_plan ||= []); let prob = ap.find((x) => /vaccin|immuni|injection/i.test(String(x?.issue || '')));
        if (!prob) { prob = { issue: 'Immunisation', diagnosis: '', assessment: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: '', referrals: '' }; ap.push(prob); }
        addTreatment(prob, l); moved.given++;
      } else keep.push(l);
    }
    if (keep.length !== lines(obj[f]).length) obj[f] = keep.join('\n');
  }
  if (moved.vitals || moved.given || moved.referralsCut || moved.referralsMoved || moved.echoes) log(`[v2:place2] moved ${moved.vitals} vital sign(s) to Objective, ${moved.given} given-in-visit item(s) to the plan, ${moved.referralsMoved} non-referral(s) from Referrals to Treatment, cut ${moved.referralsCut} history text(s) from Referrals, dropped ${moved.echoes} echo line(s)`);
  return moved;
}
