// ─────────────────────────────────────────────────────────────────────────────
// reconcileNote — deterministic placement & consistency pass (runs after the note
// is composed, regardless of which composer produced it). Enforces the Heidi rules
// the LLM is asked to follow, so they hold even if it slips:
//   • lab / vital VALUES live in Objective, never Subjective (removes cross-section
//     contradictions like "Hgb 88" in Subjective vs "Hgb 87" in Objective);
//   • referral ACTIONS live in Assessment & Plan, never Subjective;
//   • normal lab results are not re-listed inside Assessment & Plan.
// Purely rule-based and grounded — it only moves/removes existing text, never invents.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const LAB_KW = /\b(ha?emoglobin|hgb|hb|ferritin|iron|glucose|sugar|cholesterol|ldl|hdl|triglyc\w*|creatinine|egfr|a1c|hba1c|platelet|wbc|white cell|potassium|sodium|tsh|bilirubin|albumin)\b/i;
const VITAL_KW = /\b(blood pressure|bp|pulse|heart rate|hr|respirat\w*|rr|temperature|temp|spo2|o2 sat|weight|height|bmi)\b/i;
const REFERRAL_RX = /\b(referr\w*|refer(?:red)?\s+to)\b/i;
const NORMALREPEAT_RX = /\b(glucose|sugar|kidney|renal|cholesterol|ldl|hdl|electrolyte|liver|lft|creatinine|egfr)\b[^\n]*\b(normal|wnl|stable|unremarkable)\b/i;
const hasNum = (s) => /\d/.test(s);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function splitLines(v) { return String(v || '').split('\n').map((x) => x.trim()).filter(Boolean); }

export function reconcileNote(note) {
  if (!note) return note;
  const obj = note.objective;
  // The matched lab/vital keyword (used for same-measurement dedup).
  const kwOf = (line) => { const m = String(line).match(LAB_KW) || String(line).match(VITAL_KW); return m ? m[0].toLowerCase() : ''; };
  const addObjective = (line, isVital) => {
    const kw = kwOf(line);
    // If Objective already documents this measurement, Objective is the source of truth —
    // drop the (possibly contradictory) Subjective copy rather than duplicating it.
    const already = [...splitLines(obj.completed_investigations), ...splitLines(obj.vital_signs)];
    if (kw && already.some((e) => e.toLowerCase().includes(kw))) return;
    if (already.some((e) => norm(e).includes(norm(line)) || norm(line).includes(norm(e)))) return;
    const field = isVital ? 'vital_signs' : 'completed_investigations';
    const existing = splitLines(obj[field]);
    existing.push(line);
    obj[field] = existing.join('\n');
  };

  // 1) Pull lab/vital VALUE lines out of Subjective → Objective (removes contradictions).
  for (const key of Object.keys(note.subjective)) {
    const kept = [];
    for (const line of splitLines(note.subjective[key])) {
      // strip a leading "Body Part:" label before testing for a bare lab value
      const body = line.replace(/^[A-Z][\w /-]{0,28}:\s*/, '');
      const isLabVal = hasNum(body) && LAB_KW.test(body) && !REFERRAL_RX.test(body);
      const isVitalVal = hasNum(body) && VITAL_KW.test(body);
      if (isLabVal || isVitalVal) { addObjective(body, isVitalVal && !isLabVal); continue; }
      kept.push(line);
    }
    note.subjective[key] = kept.join('\n');
  }

  // 2) Move referral ACTIONS from Subjective → primary problem's referrals.
  const primary = (note.assessment_and_plan || [])[0];
  for (const key of Object.keys(note.subjective)) {
    const kept = [];
    for (const line of splitLines(note.subjective[key])) {
      if (REFERRAL_RX.test(line) && primary) {
        const cur = splitLines(primary.referrals);
        if (!cur.some((e) => norm(e) === norm(line))) cur.push(line);
        primary.referrals = cur.join('\n');
        continue;
      }
      kept.push(line);
    }
    note.subjective[key] = kept.join('\n');
  }

  // 2b) Objective hygiene: a vital (weight/height/BMI/BP) must live in Vital Signs only —
  //      strip it from Completed Investigations to avoid duplication across subsections.
  {
    const vitalsTxt = String(obj.vital_signs || '');
    const labKept = splitLines(obj.completed_investigations).filter((line) => {
      if (!VITAL_KW.test(line)) return true;                 // not a vital → keep as a lab
      if (LAB_KW.test(line)) return true;                    // genuine lab that also matched → keep
      // it's a pure vital; drop if it (or its measurement) already appears in Vital Signs
      const m = line.match(VITAL_KW); const kw = m ? m[0].toLowerCase() : '';
      return !(kw && vitalsTxt.toLowerCase().includes(kw));
    });
    obj.completed_investigations = labKept.join('\n');
  }

  // 3) Drop NORMAL-lab relists from Assessment & Plan assessment text.
  for (const p of (note.assessment_and_plan || [])) {
    const kept = splitLines(p.assessment).filter((line) => !(NORMALREPEAT_RX.test(line) && !/abnormal|elevated|raised|low|high/i.test(line)));
    p.assessment = kept.join('\n');
  }
  return note;
}
