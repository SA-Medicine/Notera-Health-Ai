// Placement rules (Style Spec v2.2, owner 2026-10-24: "still misplaces of data"). A review of 77 real notes found "misplaced fact" to be the most
// common finding (86 plan gaps and 107 wrong lines): a measurement written as a treatment, a vaccine given in the visit written as an examination
// finding, the history repeated under Referrals. Each rule here MOVES a line to where it belongs; none deletes content and none adds wording.
//   1. a vital sign with a number sitting in a plan field            -> Objective, Vital Signs
//   2. a vaccine / injection given in the visit, written as Objective  -> the plan, "Immunisation" problem, as an item given today
//   3. a very long Referrals text that names no referral              -> removed from Referrals (it repeats the history; nothing is lost because the Subjective has it)
// Off switch: PLACEMENT_RULES=0.
'use strict';

import { overlap } from './planSweep.js';

const VITAL = /\b(blood pressure|bp|pulse|heart rate|hr|temperature|temp|spo2|oxygen sat\w*|saturation|weight|bmi|respiratory rate|rr|height)\b[^.;]{0,30}\d/i;
const ACTION = /\b(start|stop|continue|increase|decrease|prescrib\w*|monitor|check|repeat|recheck|refer\w*|follow|advis\w*|take|avoid|reduce|aim|target|goal|home)\b/i;
const GIVEN_IN_VISIT = /\b(administered|vaccine given|vaccine administered|injection given|lot[:#\s]|expiry|exp\.?\s)\b/i;
const REFERRAL_WORDS = /\b(refer\w*|consult\w*|specialist|clinic|surgeon|cardiolog\w*|dermatolog\w*|neurolog\w*|physio\w*|therap\w*|hospital|urgent care|referral|see\b)/i;
const lines = (v) => String(v || '').split(/\n|;\s+/).map((x) => x.trim()).filter(Boolean);
const join = (a, b) => [String(a || '').trim(), b].filter(Boolean).join('\n');

export function fixPlacementV2(note, log = () => {}) {
  const moved = { vitals: 0, given: 0, referralsCut: 0 }; const obj = (note.objective ||= {});
  for (const p of note.assessment_and_plan || []) {
    if (!p) continue;
    for (const f of ['treatment_planned', 'investigations_planned', 'assessment']) {
      const keep = [];
      for (const l of lines(p[f])) {
        if (VITAL.test(l) && !ACTION.test(l) && /\d/.test(l) && l.length < 80 && overlap(l, obj.vital_signs || '') < 0.8) { obj.vital_signs = join(obj.vital_signs, l.replace(/^./, (c) => c.toUpperCase())); moved.vitals++; } else keep.push(l);
      }
      if (keep.length !== lines(p[f]).length) p[f] = keep.join(f === 'assessment' ? '\n' : '; ');
    }
    const ref = String(p.referrals || ''); if (ref.length > 220 && !REFERRAL_WORDS.test(ref)) { p.referrals = ''; moved.referralsCut++; }
  }
  for (const f of ['examination', 'completed_investigations']) {
    const keep = [];
    for (const l of lines(obj[f])) {
      if (GIVEN_IN_VISIT.test(l) && /\b(vaccin\w*|injection|shot|mmr|tdap|flu|influenza|covid|hepatitis|shingrix|prevnar|pneumo\w*)\b/i.test(l)) {
        const ap = (note.assessment_and_plan ||= []); let prob = ap.find((x) => /vaccin|immuni|injection/i.test(String(x?.issue || '')));
        if (!prob) { prob = { issue: 'Immunisation', diagnosis: '', assessment: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: '', referrals: '' }; ap.push(prob); }
        prob.treatment_planned = prob.treatment_planned ? `${String(prob.treatment_planned).replace(/[;\s]+$/, '')}; ${l.replace(/^./, (c) => c.toUpperCase())}` : l.replace(/^./, (c) => c.toUpperCase()); moved.given++;
      } else keep.push(l);
    }
    if (keep.length !== lines(obj[f]).length) obj[f] = keep.join('\n');
  }
  if (moved.vitals || moved.given || moved.referralsCut) log(`[v2:place2] moved ${moved.vitals} vital sign(s) to Objective, ${moved.given} given-in-visit item(s) to the plan, cut ${moved.referralsCut} history text(s) from Referrals`);
  return moved;
}
