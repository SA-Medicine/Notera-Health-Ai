// Conditions nobody said: a disease name may only be in Past Medical History or in a problem title if the recording says it
// (or says what proves it, such as the drug that treats it). "Your sugars are 6.1" does not make "Diabetes"; "your LDL is 1.4" does not make
// "Hypercholesterolemia". Found on newer test notes (2026-10-22): a condition inferred from a result appeared in PMH and as a plan problem.
//   * PMH: a condition line the recording does not support is removed.
//   * Problem title: a disease part of the title the recording does not support is dropped ("Diabetes and cholesterol management" -> only the
//     supported part). If nothing in the title is supported the title stays and the note is flagged for the doctor.
// Style Spec v2 (part of the quality guards; QUALITY_GUARDS=0 switches it off).
'use strict';

// disease word -> what in the recording counts as saying it (the name itself or a drug that is only given for it)
const ALIASES = [
  [/hypertens|\bblood pressure\b/i, /hypertens|high blood pressure|\b(candesartan|amlodipine|ramipril|perindopril|valsartan|losartan|metoprolol|bisoprolol|hydrochlorothiazide|lisinopril|irbesartan|telmisartan|olmesartan)\b/i],
  [/diabet|\bglyc/i, /diabet|\b(metformin|insulin|glipizide|gliclazide|jardiance|empagliflozin|ozempic|semaglutide|forxiga|dapagliflozin|januvia|sitagliptin)\b/i],
  [/cholesterol|lipid/i, /(high|elevated|bad) cholesterol|hypercholesterol|hyperlipid|dyslipid|\b(statin|rosuvastatin|atorvastatin|simvastatin|crestor|lipitor|ezetimibe)\b/i],
  [/thyroid/i, /hypothyroid|hyperthyroid|underactive thyroid|overactive thyroid|\b(levothyroxine|synthroid|eltroxin)\b|thyroid (medication|pill|dose)/i],
  [/asthma|copd|emphysema/i, /asthma|copd|emphysema|\b(ventolin|salbutamol|symbicort|advair|flovent|puffer|inhaler)\b/i],
  [/depress|anxiety/i, /depress|anxiety|anxious|\b(cipralex|escitalopram|sertraline|zoloft|venlafaxine|effexor|fluoxetine|prozac|citalopram|lorazepam|ativan)\b/i],
];
// when the disease is not said but its measurement is, the title names the measurement ("Diabetes" -> "Blood sugar" when sugars were discussed)
const OBSERVABLE = [
  [/diabet\w*/i, 'Blood sugar', /sugar|a1c|glucose/i],
  [/hypertens\w*/i, 'Blood pressure', /blood pressure|\bbp\b/i],
  [/hypercholesterol\w*|hyperlipid\w*|dyslipid\w*/i, 'Cholesterol', /cholesterol|\bldl\b|lipid/i],
  [/hypothyroid\w*|hyperthyroid\w*/i, 'Thyroid', /thyroid|\btsh\b/i],
];
const STEM = (w) => w.replace(/ae/g, 'e').replace(/oe/g, 'e').replace(/(osis|itis|emia|ia|ing|ion|ed|es|s|y)$/, '').slice(0, 6);
const WORDS = (s) => String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !['history', 'status', 'post', 'chronic', 'acute', 'type', 'with', 'and', 'management', 'care', 'follow', 'review', 'resolved', 'stable'].includes(w));

/** Does the recording say this condition? Disease words use the alias table; other words need most of their stems in the recording. */
export function conditionSaid(text, transcript) {
  const t = String(text || ''); const tx = String(transcript || '');
  let sawDisease = false;
  for (const [name, proof] of ALIASES) if (name.test(t)) { sawDisease = true; if (proof.test(tx)) return true; }
  if (sawDisease) return false;
  const ws = WORDS(t); if (!ws.length) return true;
  const have = new Set(WORDS(tx).map(STEM)); return ws.filter((w) => have.has(STEM(w))).length / ws.length >= 0.5;
}

const isConditionLine = (l) => { const s = String(l).trim(); return s.length >= 4 && s.split(/\s+/).length <= 6 && !/\d/.test(s) && !/^(medications?|allergies|preventive|occupation|social|family|lives|travel|no |never|denies)/i.test(s); };

export function conditionGuard(note, transcript, log = () => {}) {
  const out = { pmhRemoved: [], titlesChanged: [], titlesFlagged: [] };
  const pmh = note?.past_medical_history; const f = 'medical_surgical';
  if (pmh && typeof pmh[f] === 'string') {
    const keep = [];
    for (const l of pmh[f].split('\n')) { if (l.trim() && isConditionLine(l) && !conditionSaid(l, transcript)) out.pmhRemoved.push(l.trim()); else keep.push(l); }
    if (out.pmhRemoved.length) pmh[f] = keep.join('\n');
  }
  for (const it of note?.assessment_and_plan || []) {
    const title = String(it?.issue || '').trim(); if (!title) continue;
    const parts = title.split(/\s+(?:and|with)\s+|,\s*/i).filter(Boolean);
    const diseasePart = (p) => ALIASES.some(([name]) => name.test(p));
    const bad = parts.filter((p) => diseasePart(p) && !conditionSaid(p, transcript));
    if (!bad.length) continue;
    const fixed = parts.map((p) => {
      if (!bad.includes(p)) return p;
      for (const [re, label, seen] of OBSERVABLE) if (re.test(p) && seen.test(transcript)) return p.replace(re, label);
      return null;
    }).filter(Boolean);
    if (fixed.length) { it.issue = fixed.join(' and ').replace(/^./, (c) => c.toUpperCase()); out.titlesChanged.push(title + ' -> ' + it.issue); } else out.titlesFlagged.push(title);
  }
  if (out.pmhRemoved.length || out.titlesChanged.length || out.titlesFlagged.length) {
    const bits = [];
    if (out.pmhRemoved.length) bits.push(`${out.pmhRemoved.length} condition(s) nobody said removed from Past Medical History (${out.pmhRemoved.join(', ')})`);
    if (out.titlesChanged.length) bits.push(`problem title(s) shortened to what was said (${out.titlesChanged.join('; ')})`);
    if (out.titlesFlagged.length) { bits.push(`problem name(s) not said in the recording (${out.titlesFlagged.join(', ')})`); note.metadata = note.metadata || {}; note.metadata.flags = [...(note.metadata.flags || []), { type: 'condition_not_said', field: 'assessment_and_plan', message: `Please check the problem name against the recording: ${out.titlesFlagged.join(', ')} was not said.`, severity: 'warning' }]; }
    log('[v2:quality] ' + bits.join('; '));
  }
  return out;
}
