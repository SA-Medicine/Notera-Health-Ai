// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Deterministic post-writer guardrails, built from the diagnosis reports of the improvement loop (no model call):
//   1. enforceTemplate     the clinic template has no "current medications" list and no separate "Follow-up" problem
//   2. fixMisplacement     patient-reported symptoms found under Objective are moved to Subjective
//   3. drugPlausibility    FLAG-ONLY: a common drug with no matching indication anywhere in the transcript
//   4. checkInput          a schedule / list / ward round pasted as a "transcript" is flagged (or refused, by setting)
// Every function returns what it did so the lab trace and the admin console can show it. Nothing here invents text.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
'use strict';

const flag = (note, f) => { (note.metadata.flags ||= []).push({ severity: 'warning', ...f }); };
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const addLine = (cur, line) => (lines(cur).some((l) => l.toLowerCase() === line.toLowerCase()) ? cur : (cur ? cur + '\n' : '') + line);

/** 1) Template conformance. A separate "Follow-up" problem is folded into the last real problem. (The doctor WANTS one "Medications:" line in Past Medical History, so it is kept; only a duplicate "Current/Home/Regular medications:" line is dropped when a "Medications:" line exists.) */
export function enforceTemplate(note, log = () => {}) {
  const out = { medLinesRemoved: 0, followUpFolded: 0 };
  const pmh = note.past_medical_history || {};
  for (const k of Object.keys(pmh)) {
    const all = lines(pmh[k]); const hasPlain = Object.values(pmh).some((v) => lines(v).some((l) => /^medications?\s*:/i.test(l)));
    const kept = all.filter((l) => { const bad = hasPlain && /^(current|home|regular|usual)\s+medications?\s*:/i.test(l); if (bad) out.medLinesRemoved++; return !bad; });
    if (kept.length !== lines(pmh[k]).length) pmh[k] = kept.join('\n');
  }
  const ap = note.assessment_and_plan || [];
  const isFu = (p) => /^(follow[\s-]?up|return visit|rtc|next visit|review)\b/i.test(String(p.issue || '').trim()) && !p.diagnosis;
  const real = ap.filter((p) => !isFu(p));
  if (real.length && real.length < ap.length) {
    const host = real[real.length - 1];
    for (const p of ap.filter(isFu)) {
      const t = [p.treatment_planned, p.assessment, p.investigations_planned].flatMap(lines);
      for (const l of t) host.treatment_planned = addLine(host.treatment_planned, /^follow/i.test(l) ? l : `Follow-up: ${l}`);
      out.followUpFolded++;
    }
    note.assessment_and_plan = real;
  }
  if (out.medLinesRemoved || out.followUpFolded) log(`[v2:template] removed ${out.medLinesRemoved} medication-list line(s), folded ${out.followUpFolded} follow-up problem(s) into the last real problem`);
  return out;
}

const REPORTED = /^(patient\s+)?(reports?|reported|complains?|complained|c\/o|states?|stated|describes?|denies|denied|admits|endorses|has been (having|feeling|experiencing)|feels?|feeling|notes?\s+that|pain\b|cough\b|nausea\b|vomit)/i;
const EXAM = /\b(exam|auscult|palpat|inspect|tender(ness)?\s+on|bp\b|blood pressure|hr\b|heart rate|temp(erature)?|spo2|sat(uration)?s?|resp(iratory)? rate|weight|bmi|lungs? (clear|sounds?)|abdomen (soft|non)|no (rash|edema|oedema|murmur)|normal (rate|rhythm|exam)|on exam|noted on)\b/i;

/** 2) Patient-reported statements under Objective belong to Subjective (history). Exam findings never move. */
export function fixMisplacement(note, log = () => {}) {
  const moved = [];
  const obj = note.objective || {}; const subj = note.subjective || {};
  if (!('hpi_details' in subj)) return { moved };
  for (const k of Object.keys(obj)) {
    const keep = [];
    for (const l of lines(obj[k])) {
      if (REPORTED.test(l) && !EXAM.test(l)) { moved.push(l); subj.hpi_details = addLine(subj.hpi_details, l); } else keep.push(l);
    }
    if (keep.length !== lines(obj[k]).length) obj[k] = keep.join('\n');
  }
  // a "vital sign" without any number is a statement, not a measurement ("Blood pressure stable per history"): it belongs to the history
  if ('vital_signs' in obj) {
    const keep = [];
    for (const l of lines(obj.vital_signs)) { if (/\d/.test(l)) keep.push(l); else { moved.push(l); subj.hpi_details = addLine(subj.hpi_details, l); } }
    if (keep.length !== lines(obj.vital_signs).length) obj.vital_signs = keep.join('\n');
  }
  if (moved.length) log(`[v2:place] moved ${moved.length} patient-reported line(s) from Objective to Subjective`);
  return { moved };
}

// A small dictionary of very common drugs → words that justify them. Used ONLY to flag, never to edit.
const DRUG_USE = {
  metformin: /diabet|glyc|a1c|glucose|sugar|pcos|polycystic|prediab|insulin resist/, insulin: /diabet|glucose|sugar|a1c/, gliclazide: /diabet|glucose|sugar|a1c/, empagliflozin: /diabet|glucose|heart failure|kidney|ckd/,
  atorvastatin: /cholesterol|lipid|statin|cardiovasc|heart|stroke|ldl|hyperlip/, rosuvastatin: /cholesterol|lipid|statin|cardiovasc|heart|stroke|ldl/, simvastatin: /cholesterol|lipid|statin|cardiovasc|heart|stroke|ldl/,
  amlodipine: /blood pressure|hypertens|bp\b|angina/, ramipril: /blood pressure|hypertens|bp\b|heart|kidney|ckd|diabet/, lisinopril: /blood pressure|hypertens|bp\b|heart|kidney|ckd|diabet/, losartan: /blood pressure|hypertens|bp\b|kidney|ckd|diabet|heart/, valsartan: /blood pressure|hypertens|bp\b|heart/, hydrochlorothiazide: /blood pressure|hypertens|bp\b|edema|oedema|swelling/,
  levothyroxine: /thyroid|tsh|hypothyroid/, warfarin: /clot|afib|atrial|fibrillation|dvt|embol|valve|inr|anticoag|blood thin/, apixaban: /clot|afib|atrial|fibrillation|dvt|embol|anticoag|blood thin/, rivaroxaban: /clot|afib|atrial|fibrillation|dvt|embol|anticoag|blood thin/,
  amoxicillin: /infect|strep|throat|sinus|ear|otitis|pneumon|bronch|tonsil|uti|abscess|antibiotic|tooth|dental/, azithromycin: /infect|pneumon|bronch|chlamyd|antibiotic|sinus|throat|strep/, nitrofurantoin: /uti|urin|bladder|cystitis|dysuria|infect/, ciprofloxacin: /infect|uti|urin|antibiotic|diarr/, doxycycline: /infect|acne|lyme|antibiotic|pneumon|chlamyd|rosacea|malaria/,
  omeprazole: /reflux|gerd|heartburn|ulcer|gastr|stomach|dyspep|indigest|ppi|acid/, pantoprazole: /reflux|gerd|heartburn|ulcer|gastr|stomach|dyspep|indigest|ppi|acid/, famotidine: /reflux|gerd|heartburn|ulcer|stomach|acid|dyspep/,
  sertraline: /depress|anxi|mood|panic|ocd|ptsd|stress/, escitalopram: /depress|anxi|mood|panic|ocd|stress/, fluoxetine: /depress|anxi|mood|panic|ocd|bulimi/, citalopram: /depress|anxi|mood|panic/, venlafaxine: /depress|anxi|mood|panic/, mirtazapine: /depress|sleep|appetite|mood/,
  salbutamol: /asthma|wheez|copd|breath|bronch|inhaler|cough/, albuterol: /asthma|wheez|copd|breath|bronch|inhaler|cough/, prednisone: /asthma|copd|flare|inflamm|arthrit|rash|allerg|steroid|gout|croup|crohn|colitis|polymyalgia/, prednisolone: /asthma|copd|flare|inflamm|arthrit|rash|allerg|steroid|gout|croup/,
  cetirizine: /allerg|hay fever|rhinitis|itch|hives|urticaria|rash/, loratadine: /allerg|hay fever|rhinitis|itch|hives|urticaria|rash/, montelukast: /asthma|allerg|rhinitis|wheez/,
  gabapentin: /nerve|neuropath|pain|seizure|neuralgia|shingles|zoster/, pregabalin: /nerve|neuropath|pain|seizure|anxi|neuralgia|fibromyalg/, sumatriptan: /migraine|headache/, tamsulosin: /prostate|urin|bph|flow|retention|stone/,
  allopurinol: /gout|uric|urate/, colchicine: /gout|pericard|flare|joint/, alendronate: /osteopor|bone|fracture|dexa/, sildenafil: /erectile|ed\b|erection|pulmonary hypertension/, finasteride: /prostate|hair|bph|alopecia/,
};
const DRUG_RX = new RegExp('\\b(' + Object.keys(DRUG_USE).join('|') + ')\\b', 'gi');

/** 3) Flag-only: drug named in the plan whose usual indication is not hinted anywhere in the transcript or the note. */
export function drugPlausibility(note, transcript, log = () => {}) {
  const T = (String(transcript || '') + '\n' + JSON.stringify(note.assessment_and_plan || []) + JSON.stringify(note.past_medical_history || {})).toLowerCase();
  const flagged = [];
  const seen = new Set();
  for (const p of note.assessment_and_plan || []) {
    for (const m of String([p.treatment_planned, p.assessment].join(' ')).matchAll(DRUG_RX)) {
      const d = m[1].toLowerCase(); if (seen.has(d)) continue; seen.add(d);
      if (!DRUG_USE[d].test(T)) {
        flagged.push({ drug: d, issue: p.issue });
        flag(note, { type: 'drug_indication_unclear', field: 'treatment_planned', message: `"${m[1]}" is planned under "${p.issue}", but nothing in the transcript mentions what it is for — please verify the drug.` });
      }
    }
  }
  if (flagged.length) log(`[v2:plausible] flagged ${flagged.map((f) => f.drug).join(', ')} (no indication in transcript)`);
  return { flagged };
}

/** 4) Is this a consultation at all? A schedule / roster / shopping-list style paste has many time or list markers and few sentences. */
export function checkInput(transcript) {
  const t = String(transcript || ''); const ls = t.split('\n').map((x) => x.trim()).filter(Boolean);
  const words = (t.match(/\S+/g) || []).length;
  if (words < 25) return { ok: false, reason: 'too_short', message: `Only ${words} words — too short to be a consultation.` };
  const timed = ls.filter((l) => /^(\[?\d{1,2}[:.]\d{2}\]?|\d{1,2}\s?(am|pm)\b|mon|tue|wed|thu|fri|sat|sun)\b/i.test(l)).length;
  const bullets = ls.filter((l) => /^([-*•]|\d+[.)])\s/.test(l)).length;
  const speech = (t.match(/\b(I|you|my|your|me|we|doctor|patient|feel|have|been|take|taking|pain|how|what|okay|yes|no)\b/gi) || []).length;
  const listy = ls.length >= 6 && (timed + bullets) / ls.length >= 0.6;
  if (listy && speech / Math.max(words, 1) < 0.12) return { ok: false, reason: 'schedule_or_list', message: 'The text looks like a schedule or a list, not a spoken consultation.' };
  return { ok: true };
}

const EMPTY_STATEMENT = /\b(none|nothing|not|no)\s+(mentioned|stated|documented|specified|recorded|discussed|reported)\b|:\s*(n\/?a|none|nil|unknown)\.?\s*$/i;
/** Removes lines that only say something was not mentioned ("Preventive care: none mentioned."). Real denials ("Denies nausea") never match. */
export function sweepEmptyStatements(note, log = () => {}) {
  let n = 0;
  for (const sec of ['subjective', 'past_medical_history', 'objective']) {
    for (const k of Object.keys(note[sec] || {})) {
      const all = lines(note[sec][k]); const kept = all.filter((l) => !EMPTY_STATEMENT.test(l));
      if (kept.length !== all.length) { n += all.length - kept.length; note[sec][k] = kept.join('\n'); }
    }
  }
  if (n) log(`[v2:sweep] removed ${n} "not mentioned" line(s)`);
  return { removed: n };
}

const cw = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !/^(patient|today|planned|with|that|this|from|will|have|following|after|your|their|should|would|please)$/.test(w)));
const similar = (a, b, th = 0.75) => { const A = cw(a), B = cw(b); if (!A.size || !B.size) return false; const sh = [...A].filter((w) => B.has(w)).length; return sh / Math.min(A.size, B.size) >= th; };
/** The plan states every item once: a bare "Rtc", and an investigation/treatment item that repeats an earlier one (in the same or another problem), are dropped; the Medications line has no repeated drug. */
export function tidyPlan(note, log = () => {}) {
  let dropped = 0; const seen = [];
  const items = (v) => String(v || '').split(/\n|;/).map((x) => x.trim()).filter(Boolean);
  for (const p of note.assessment_and_plan || []) {
    for (const f of ['investigations_planned', 'treatment_planned', 'referrals']) {
      const keep = [];
      for (const it of items(p[f])) {
        if (/^(rtc|rtc:|follow[- ]?up:?)$/i.test(it)) { dropped++; continue; }
        const th = f === 'investigations_planned' ? 0.6 : 0.75;
        if (seen.some((x) => x.f === f && similar(x.t, it, th)) || keep.some((k) => similar(k, it, th))) { dropped++; continue; }
        keep.push(it); seen.push({ f, t: it });
      }
      if (keep.length !== items(p[f]).length) p[f] = keep.join(f === 'treatment_planned' ? '; ' : '\n');
    }
  }
  // test results restated under Past Medical History (usually "Preventive care: …") when the Objective already holds them
  const objText = String(JSON.stringify(note.objective || {})).toLowerCase();
  const RESULT = /\b(test|scan|x-?ray|ultrasound|blood|haemoglobin|hemoglobin|ldl|hdl|cholesterol|mibi|echo|stress|perfusion|a1c|tsh|result)/i;
  for (const k of Object.keys(note.past_medical_history || {})) {
    const all = lines(note.past_medical_history[k]);
    const keep = all.filter((l) => {
      if (/^medications?\s*:/i.test(l) || !RESULT.test(l) || /vaccin|immuni|mammogra|colonoscop|\bpap\b|\bpsa\b|screen|shot|bone density/i.test(l)) return true;
      const w = [...cw(l)]; const nums = (l.match(/\d+(?:\.\d+)?/g) || []).filter((n) => !/^(19|20)\d\d$/.test(n));
      const inObj = w.filter((x) => objText.includes(x.slice(0, 5))).length / Math.max(1, w.length);
      const dup = (inObj >= 0.6 && nums.every((n) => objText.includes(n))) || (nums.length === 0 && inObj >= 0.75);
      if (dup) dropped++; return !dup;
    });
    if (keep.length !== all.length) note.past_medical_history[k] = keep.join('\n');
  }
  const other = note.past_medical_history?.other;
  if (other) {
    note.past_medical_history.other = String(other).split('\n').map((l) => {
      const m = l.match(/^(\s*medications?\s*:\s*)(.*)$/i); if (!m) return l;
      const seenDrug = new Set(); const parts = m[2].split(/,\s*/).filter((x) => { const k = (x.toLowerCase().match(/[a-z]+/) || [''])[0].slice(0, 6); if (!k || seenDrug.has(k)) { dropped++; return false; } seenDrug.add(k); return true; });
      return m[1] + parts.join(', ');
    }).join('\n');
  }
  if (dropped) log(`[v2:tidy] removed ${dropped} repeated / empty plan or medication item(s)`);
  return { dropped };
}
