// ─────────────────────────────────────────────────────────────────────────────
// Notera — deterministic "System Upgrader" guardrails.
//
// These implement the source-grounded, LLM-free post-checks from
// SYSTEM_UPGRADER_ACTION_PLAN.md. They only move/relabel/flag EXISTING content —
// never invent — and every action is logged with an [upgrade:<id>] prefix so it
// shows up in the run logs (stdout streams to the Run tab).
//
//   A  section-router      medication dosing/titration must live in Plan, not
//                          Objective/Investigations or Subjective timing slots
//   G  temporal-validator  a future/planned investigation may not carry a
//                          completed result status ('normal'/'abnormal')
//   B  blank-encounter     empty / phatic-only encounter → emit an empty note
//                          instead of letting the generator confabulate
//   D1 value-flagger       flag medication doses fused with non-clinical tokens
//                          (e.g. "30 Brian") for sign-off
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// keep in sync with reconcileNote.js
const LAB_KW = /\b(ha?emoglobin|hgb|hb|ferritin|iron|glucose|sugar|cholesterol|ldl|hdl|triglyc\w*|creatinine|egfr|a1c|hba1c|platelet|wbc|white cell|potassium|sodium|tsh|bilirubin|albumin)\b/i;
const DOSE_RX = /\b\d+(?:\.\d+)?\s?(?:mg|mcg|µg|g|ml|units?|iu|puffs?|tabs?|caps?|capsules?)\b/i;
const FREQ_RX = /\b(?:once|twice|thrice|daily|nightly|bid|tid|qid|qhs|od|bd|nocte|weekly|q\d+h|every\s+\d+\s+(?:hours?|days?|weeks?)|at night|in the morning|per day|a day)\b/i;
const MED_ACTION_RX = /\b(?:start(?:ed|ing)?|increas\w+|titrat\w+|decreas\w+|taper\w*|up-?titrate|refill\w*|prescrib\w*|switch\w*|initiat\w+|commenc\w+|continu\w+ (?:at|on)\b)\b/i;
const FUTURE_RX = /\b(?:in\s+\d+\s+(?:days?|weeks?|months?)|next\s+(?:week|month|visit)|follow[-\s]?up|planned|to be (?:done|repeated|arranged|performed)|will (?:repeat|arrange|order|book)|repeat[^\n]*\bin\b|booked|scheduled|upcoming|await\w*|pending)\b/i;
const COMPLETED_STATUS_RX = /\b(normal|abnormal|unremarkable|wnl|within normal limits|stable findings?|completed|resolved|negative|positive)\b/i;
// dose value fused with a non-clinical proper noun: "30 Brian", "50 Sarah"
const GARBLED_VALUE_RX = /\b(\d+(?:\.\d+)?)\s+([A-Z][a-z]{2,})\b/;
const UNIT_WORD = /^(mg|mcg|µg|g|ml|units?|iu|puffs?|tabs?|caps?|capsules?|daily|bid|tid|qid|od|bd|nocte|weekly|milligrams?|micrograms?|grams?|millilitres?|milliliters?)$/i;

const splitLines = (v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean);
const STOP = new Set(['the', 'and', 'for', 'with', 'was', 'not', 'has', 'her', 'his', 'she', 'him', 'they', 'that', 'this', 'from', 'into', 'started', 'start', 'increase', 'daily', 'twice', 'once', 'mg', 'dose', 'dosing', 'plan', 'patient']);
const words = (s) => norm(s).split(' ').filter((w) => w.length > 3 && !STOP.has(w));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// ── R · de-repetition (degenerate LLM loop guard) ────────────────────────────
// LLMs sometimes fall into a repetition loop, emitting the same phrase hundreds of times
// (a note field ballooning to 100s of KB). Collapse repeated words, then cut the text at
// the first long chunk that repeats — keeping the legit content before the loop.
function deRepeat(text, maxChars = 2500) {
  let t = String(text || '');
  if (!t) return { text: t, collapsed: 0 };
  const before = t.length;
  if (t.length > 20000) t = t.slice(0, 20000);            // bound before regex work
  t = t.replace(/\b(\w{2,})(?:\s+\1\b){2,}/gi, '$1');     // "word word word" -> "word"
  const m = t.match(/([^]{20,300}?)\1{1,}/);              // first 20–300 char chunk that repeats
  if (m && m.index != null) {
    t = t.slice(0, m.index).replace(/[\s,;:–-]+$/, '').trim();
    if (t && !/[.!?]$/.test(t)) t += '.';
  }
  if (t.length > maxChars) { const cut = t.lastIndexOf('. ', maxChars); t = cut > 400 ? t.slice(0, cut + 1) : t.slice(0, maxChars).trim(); }
  t = t.trim();
  return { text: t, collapsed: before - t.length };
}
export function stripRepetition(note, log = () => {}) {
  let fixed = 0;
  const fix = (s) => { const r = deRepeat(s); if (r.collapsed > 200) { fixed++; log(`[upgrade:de-repeat] collapsed a ${r.collapsed}-char repetition loop in the note`); } return r.text; };
  for (const k of Object.keys(note.subjective || {})) note.subjective[k] = fix(note.subjective[k]);
  for (const k of Object.keys(note.past_medical_history || {})) note.past_medical_history[k] = fix(note.past_medical_history[k]);
  if (note.objective) for (const k of Object.keys(note.objective)) if (typeof note.objective[k] === 'string') note.objective[k] = fix(note.objective[k]);
  for (const p of (note.assessment_and_plan || [])) for (const f of ['assessment', 'investigations_planned', 'treatment_planned', 'referrals']) if (typeof p[f] === 'string') p[f] = fix(p[f]);
  if (!fixed) log('[upgrade:de-repeat] no repetition loops found');
  return { fixed };
}

// Is this line a medication-management statement (dose + action/frequency), and NOT a lab value?
function isMedManagement(line) {
  if (LAB_KW.test(line)) return false;                        // labs belong in Objective (reconcile handles them)
  const hasDose = DOSE_RX.test(line);
  return (hasDose && (MED_ACTION_RX.test(line) || FREQ_RX.test(line))) || (MED_ACTION_RX.test(line) && hasDose);
}

// Choose the A&P problem a medication line belongs to: best word overlap with an
// existing problem (issue/diagnosis/treatment), else the primary (first) problem.
function pickProblem(note, line) {
  const ap = note.assessment_and_plan || [];
  if (!ap.length) return null;
  const lw = new Set(words(line));
  let best = ap[0], bestScore = 0;
  for (const p of ap) {
    const pw = words(`${p.issue || ''} ${p.diagnosis || ''} ${p.treatment_planned || ''}`);
    const score = pw.filter((w) => lw.has(w)).length;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

// ── A · section-router ───────────────────────────────────────────────────────
export function routeMedicationToPlan(note, log = () => {}) {
  let moved = 0;
  const move = (section, key) => {
    const container = key ? note[section][key] : note[section];
    const kept = [];
    for (const line of splitLines(container)) {
      if (isMedManagement(line)) {
        const prob = pickProblem(note, line);
        if (prob) {
          const cur = splitLines(prob.treatment_planned);
          if (!cur.some((e) => norm(e) === norm(line))) cur.push(line);
          prob.treatment_planned = cur.join('\n');
          moved++;
          log(`[upgrade:section-router] moved medication line ${section}${key ? '.' + key : ''} → A&P["${prob.issue || '?'}"].treatment_planned: "${line}"`);
          continue;
        }
      }
      kept.push(line);
    }
    if (key) note[section][key] = kept.join('\n'); else note[section] = kept.join('\n');
  };
  for (const key of Object.keys(note.subjective || {})) move('subjective', key);
  if (note.objective) { move('objective', 'completed_investigations'); move('objective', 'vital_signs'); }
  if (!moved) log('[upgrade:section-router] no misplaced medication content found');
  return { note, moved };
}

// ── G · temporal-status validator ────────────────────────────────────────────
export function validateTemporalStatus(note, log = () => {}) {
  let fixed = 0;
  const stripStatus = (line) => line.replace(COMPLETED_STATUS_RX, '').replace(/\s{2,}/g, ' ').replace(/[\s,–-]+$/, '').trim();
  // Objective is for COMPLETED results only; a future/planned investigation with a
  // completed status is a fabricated result → relocate to Plan and drop the status.
  if (note.objective) {
    const primary = (note.assessment_and_plan || [])[0];
    const kept = [];
    for (const line of splitLines(note.objective.completed_investigations)) {
      if (FUTURE_RX.test(line) && COMPLETED_STATUS_RX.test(line)) {
        const cleaned = stripStatus(line) || line;
        if (primary) {
          const cur = splitLines(primary.investigations_planned);
          if (!cur.some((e) => norm(e) === norm(cleaned))) cur.push(cleaned);
          primary.investigations_planned = cur.join('\n');
        }
        fixed++;
        log(`[upgrade:temporal-validator] future investigation had a completed status → moved to Plan, status removed: "${line}" → "${cleaned}"`);
        continue;
      }
      kept.push(line);
    }
    note.objective.completed_investigations = kept.join('\n');
  }
  // Also demote a completed status on a clearly-planned investigations_planned line.
  for (const p of (note.assessment_and_plan || [])) {
    const out = splitLines(p.investigations_planned).map((line) => {
      if (FUTURE_RX.test(line) && COMPLETED_STATUS_RX.test(line)) {
        fixed++;
        const cleaned = stripStatus(line) || line;
        log(`[upgrade:temporal-validator] planned investigation carried a result status → removed: "${line}"`);
        return cleaned;
      }
      return line;
    });
    p.investigations_planned = out.join('\n');
  }
  if (!fixed) log('[upgrade:temporal-validator] no future-result fabrications found');
  return { note, fixed };
}

// ── D1 · suspicious medication-value flagger ─────────────────────────────────
export function flagSuspiciousValues(note, log = () => {}) {
  const flags = [];
  const scan = (text, field) => {
    for (const line of splitLines(text)) {
      const m = line.match(GARBLED_VALUE_RX);
      if (m && !UNIT_WORD.test(m[2])) {
        flags.push({ type: 'suspicious_medication_value', field, message: `Dose value "${m[1]} ${m[2]}" fuses a number with a non-clinical token ("${m[2]}") — verify (possible transcription artifact).`, severity: 'critical' });
        log(`[upgrade:value-flagger] flagged suspicious dose "${m[1]} ${m[2]}" in ${field}: "${line}"`);
      }
    }
  };
  for (const p of (note.assessment_and_plan || [])) scan(p.treatment_planned, `assessment_and_plan["${p.issue || '?'}"].treatment_planned`);
  if (note.objective) scan(note.objective.completed_investigations, 'objective.completed_investigations');
  if (!flags.length) log('[upgrade:value-flagger] no suspicious dose values found');
  return { flags };
}

// ── B · blank / phatic encounter detector ────────────────────────────────────
const PHATIC_RX = /\b(hello|hi|hey|good (?:morning|afternoon|evening)|how are you|how's it going|thanks?|thank you|goodbye|bye|see you|take care|no worries|okay|alright|yeah|yes|no|please|welcome|have a (?:good|nice)|nice to (?:meet|see))\b/gi;
const MED_HINT_RX = /\b(pain|ache|fever|cough|rash|swelling|nausea|vomit|dizz|bleed|pressure|diabet|infection|medication|medicine|tablet|dose|mg|blood|test|scan|referral|symptom|diagnos|prescrib|allergy|injury|breath|chest|headache|throat|stomach|clinic|exam|treatment)\b/i;

/** True when there is essentially nothing clinical to document. */
export function isBlankEncounter({ transcript = '', graph = null } = {}) {
  const entities = (graph && (graph.clinical_entities || graph.entities)) || null;
  if (Array.isArray(entities)) return entities.length === 0;   // extractor found no facts → blank
  // No graph available: fall back to the transcript. Strip phatics; if what's left
  // has no medical hint and is very short, treat as blank.
  const stripped = String(transcript).replace(PHATIC_RX, ' ').replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!stripped) return true;
  if (!MED_HINT_RX.test(stripped) && stripped.split(' ').length < 12) return true;
  return false;
}

// ── A(4) · named-reference grounding ─────────────────────────────────────────
// Proper-noun references — pharmacies, facilities, referral targets — MUST be spoken in
// the transcript. If the note names one that isn't there, it's fabricated → strip it
// (rewrite the line) and flag. Deterministic; never invents. mode 'strip' (default) | 'flag'.
const norm2 = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const digitsOf = (s) => String(s).replace(/\D/g, '');
const REF_PATTERNS = [
  { kind: 'pharmacy', rx: /\b(?:sent to|send to|to the pharmacy|pharmacy[:\-]?)\s+([A-Z][\w'&.\-]+(?:\s+[A-Z][\w'&.\-]+){0,3})/g },
  // ANY clinician mention — "Dr. Taraban", "Dr Chen", "referral to specialist Dr. X"
  { kind: 'clinician', rx: /\bDr\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z']+)?/g },
  { kind: 'facility', rx: /\b([A-Z][\w'&.\-]+(?:\s+[A-Z][\w'&.\-]+){0,3}\s+(?:Hospital|Clinic|Imaging|Laboratory|Pharmacy|Centre|Center|\bER\b))/g },
];
const PHONE_RX = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{2,4}(?:[-.\s]?\d{2,4})?\b/g;
export function groundNamedReferences(note, transcript = '', log = () => {}, opts = {}) {
  const mode = opts.mode || process.env.UPGRADE_REF_MODE || 'strip';
  const T = norm2(transcript);
  const TD = digitsOf(transcript);
  const flags = []; let stripped = 0;
  const grounded = (name) => {
    const n = norm2(name).replace(/^(?:dr|st)\s+/, '');
    if (!n) return true;
    if (T.includes(n)) return true;
    return n.split(' ').filter((w) => w.length >= 4).some((w) => T.includes(w));
  };
  const processField = (text) => splitLines(text).map((line) => {
    let nl = line;
    for (const { kind, rx } of REF_PATTERNS) {
      for (const m of [...line.matchAll(rx)]) {
        const name = String(m[1] || m[0]).trim();
        if (grounded(name)) continue;
        flags.push({ type: 'fabricated_reference', field: kind, message: `${kind} "${name}" is not mentioned in the transcript — ${mode === 'strip' ? 'removed' : 'flagged'} (do not fabricate names).`, severity: 'critical' });
        log(`[upgrade:name-grounding] ungrounded ${kind} "${name}" — ${mode === 'strip' ? 'stripped' : 'flagged'}: "${line}"`);
        if (mode === 'strip') { stripped++; nl = nl.replace(m[0], '').replace(/\s{2,}/g, ' ').replace(/\b(?:sent to|send to|referral to|refer to|see|with|at)\s*$/i, '').replace(/[\s,;:\-–]+$/, '').trim(); }
      }
    }
    // Phone numbers not in the transcript are fabricated contact info → remove.
    for (const m of [...nl.matchAll(PHONE_RX)]) {
      const d = digitsOf(m[0]);
      if (d.length >= 7 && !TD.includes(d)) {
        flags.push({ type: 'fabricated_contact', field: 'phone', message: `Phone number "${m[0]}" is not in the transcript — ${mode === 'strip' ? 'removed' : 'flagged'} (do not fabricate contact info).`, severity: 'critical' });
        log(`[upgrade:name-grounding] ungrounded phone "${m[0]}" — ${mode === 'strip' ? 'stripped' : 'flagged'}: "${line}"`);
        if (mode === 'strip') { stripped++; nl = nl.replace(m[0], '').replace(/\b(?:phone number|number|contact|call directly|call)\b[\s:]*$/i, '').replace(/\s{2,}/g, ' ').replace(/[\s,;:\-–]+$/, '').trim(); }
      }
    }
    return nl;
  }).filter(Boolean).join('\n');
  for (const k of Object.keys(note.subjective || {})) note.subjective[k] = processField(note.subjective[k]);
  if (note.objective) for (const k of Object.keys(note.objective)) if (typeof note.objective[k] === 'string') note.objective[k] = processField(note.objective[k]);
  for (const p of (note.assessment_and_plan || [])) for (const f of ['assessment', 'investigations_planned', 'treatment_planned', 'referrals']) if (typeof p[f] === 'string') p[f] = processField(p[f]);
  if (!flags.length) log('[upgrade:name-grounding] all named references grounded in transcript');
  return { flags, stripped };
}

// ── A(3) · pharmacy↔medication binding verifier ──────────────────────────────
// Patient9 class: a pharmacy gets attached to the wrong drug. We extract
// (medication → pharmacy) pairs from the transcript by proximity and flag any note
// assignment that contradicts them. Conservative: only fires on a clear conflict.
// Pharmacy gazetteer as a SOURCE string; build a fresh regex per use so a stateful
// global regex's lastIndex can never leak between .test() and .matchAll() (subtle bug).
const PHARMACY_SRC = 'rexall|shoppers(?:\\s+drug\\s+mart)?|walmart|costco|cvs|walgreens|prexol|mcgregor|guardian|pharmasave|london\\s+drugs|rite\\s+aid|safeway|loblaws?';
const pharmacyRe = () => new RegExp('\\b(' + PHARMACY_SRC + ')\\b', 'gi');
const hasPharmacy = (t) => new RegExp('\\b(' + PHARMACY_SRC + ')\\b', 'i').test(String(t || ''));
const pharmaName = (s) => String(s).toLowerCase().replace(/\s+drug\s+mart$/, '').trim();

function pairsFromText(text, meds) {
  const t = String(text || '');
  const pharm = [...t.matchAll(pharmacyRe())].map((m) => ({ name: pharmaName(m[0]), at: m.index }));
  const medHits = [];
  for (const med of meds) {
    const rx = new RegExp('\\b' + med.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    for (const m of t.matchAll(rx)) medHits.push({ med, at: m.index });
  }
  const pairs = [];
  for (const p of pharm) {
    let best = null, bestD = Infinity;
    for (const h of medHits) { const d = Math.abs(p.at - h.at); if (d < bestD) { bestD = d; best = h; } }
    if (best && bestD <= 160) pairs.push({ med: best.med.toLowerCase(), pharmacy: p.name });
  }
  return pairs;
}

export function verifyPharmacyBinding(note, { transcript = '', meds = [] } = {}, log = () => {}) {
  const flags = [];
  const medList = [...new Set((meds || []).map((m) => String(m).toLowerCase().trim()).filter((m) => m.length > 2))];
  if (!medList.length || !hasPharmacy(transcript)) { log('[upgrade:pharmacy-binding] no medication↔pharmacy pairs to verify'); return { flags }; }
  const truth = pairsFromText(transcript, medList);          // (med → pharmacy) as spoken
  if (!truth.length) { log('[upgrade:pharmacy-binding] no pharmacy pairs found in transcript'); return { flags }; }
  const noteText = (note.assessment_and_plan || []).map((p) => String(p.treatment_planned || '')).join('\n');
  const notePairs = pairsFromText(noteText, medList);        // (med → pharmacy) as written
  for (const np of notePairs) {
    const spoken = truth.filter((t) => t.med === np.med).map((t) => t.pharmacy);
    if (spoken.length && !spoken.includes(np.pharmacy)) {
      flags.push({ type: 'pharmacy_mismatch', field: 'assessment_and_plan.treatment_planned', message: `"${np.med}" is routed to "${np.pharmacy}" in the note, but the transcript pairs it with "${spoken.join('/')}" — verify pharmacy routing.`, severity: 'critical' });
      log(`[upgrade:pharmacy-binding] mismatch — "${np.med}" → note:"${np.pharmacy}" vs transcript:"${spoken.join('/')}"`);
    }
  }
  if (!flags.length) log('[upgrade:pharmacy-binding] pharmacy routing consistent with transcript');
  return { flags };
}

// ── F · non-patient (caregiver/proxy) context flag ───────────────────────────
// Transcripts here carry no speaker labels, so we cannot safely DROP a caregiver's
// facts. Instead we flag when proxy/caregiver language is present so the reviewer
// checks that no companion's own symptoms leaked into the patient's note.
const PROXY_RX = /\b(?:my (?:dad|mom|mother|father|husband|wife|son|daughter|partner)\b|(?:his|her|their) (?:pills|meds|medications?|prescriptions?)\b|on behalf of|power of attorney|i'?m here for (?:my|him|her|them)|calling for (?:my|him|her)|proxy)\b/i;
export function flagNonPatientContext(note, transcript = '', log = () => {}) {
  const flags = [];
  if (PROXY_RX.test(String(transcript))) {
    flags.push({ type: 'non_patient_context', field: 'subjective', message: 'Transcript contains caregiver/proxy language — verify that no companion’s own symptoms were attributed to the patient.', severity: 'warning' });
    log('[upgrade:non-patient-context] caregiver/proxy language detected — flagged for reviewer verification');
  }
  return { flags };
}

// ── C · administrative-refill fail-safe ──────────────────────────────────────
// If the classifier tags an encounter 'medication_refill_administrative' but the
// transcript actually contains a dose change or a specific pharmacy routing, that is
// real clinical content — promote to 'medication_refill' so downstream extraction
// runs at full fidelity instead of being compressed away.
const DOSE_CHANGE_RX = /\b(increas\w+|decreas\w+|titrat\w+|taper\w*|up-?titrate|start(?:ed|ing)?|switch\w*|go up to|reduce to|change (?:the )?dose)\b/i;
export function adminRefillFailsafe(encounterType, transcript = '', log = () => {}) {
  if (encounterType !== 'medication_refill_administrative') return encounterType;
  const t = String(transcript);
  const hasDoseChange = DOSE_CHANGE_RX.test(t) && DOSE_RX.test(t);
  const hasPharmacyRoute = hasPharmacy(t);
  if (hasDoseChange || hasPharmacyRoute) {
    log(`[upgrade:admin-refill-failsafe] promoted medication_refill_administrative → medication_refill (${hasDoseChange ? 'dose change' : ''}${hasDoseChange && hasPharmacyRoute ? ' + ' : ''}${hasPharmacyRoute ? 'pharmacy routing' : ''} present)`);
    return 'medication_refill';
  }
  return encounterType;
}

// ── G(2) · numeric-value grounding ───────────────────────────────────────────
// Fabricated lab values (e.g. "Vitamin B12: 1000 micrograms" when the transcript never
// says 1000) are dangerous. We flag any MEASUREMENT number in the note that doesn't
// appear in the transcript (digits, or common spelled-out forms). Flags, never invents.
const MEASURE_LINE = /\b(mg|mcg|µg|mmol|mmol\/l|g\/l|ng|iu|units?|%|mm\s?hg|bpm|kg|cm|micrograms?|milligrams?|celsius|°c|beats)\b/i;
const NUM_TOKEN = /\b\d{1,5}(?:\.\d+)?\b/g;
const W2N = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000 };
function groundedNumbers(transcript) {
  const set = new Set(); const t = String(transcript || '');
  for (const m of t.matchAll(NUM_TOKEN)) set.add(m[0].replace(/\.0+$/, ''));
  const words = t.toLowerCase().match(/[a-z]+/g) || [];
  for (let i = 0; i < words.length; i++) {
    const v = W2N[words[i]]; if (v === undefined) continue;
    set.add(String(v));
    const nxt = words[i + 1];
    if (nxt === 'thousand') set.add(String(v * 1000));
    if (nxt === 'hundred') set.add(String(v * 100));
  }
  return set;
}
export function flagUngroundedNumbers(note, transcript = '', log = () => {}) {
  const flags = [];
  const grounded = groundedNumbers(transcript);
  const scan = (text, field) => {
    for (const line of splitLines(text)) {
      if (!MEASURE_LINE.test(line)) continue;                 // only real measurements
      for (const m of String(line).matchAll(NUM_TOKEN)) {
        const n = m[0].replace(/\.0+$/, '');
        if (Number(n) < 3) continue;                          // ignore trivial small integers
        if (!grounded.has(n)) {
          flags.push({ type: 'ungrounded_number', field, message: `Numeric value "${m[0]}" in ${field} is not present in the transcript — possible fabrication; verify before sign-off.`, severity: 'critical' });
          log(`[upgrade:numeric-grounding] ungrounded value "${m[0]}" in ${field}: "${line}"`);
        }
      }
    }
  };
  if (note.objective) scan(note.objective.completed_investigations, 'objective.completed_investigations');
  if (note.objective) scan(note.objective.vital_signs, 'objective.vital_signs');
  for (const p of (note.assessment_and_plan || [])) scan(p.treatment_planned, `assessment_and_plan["${p.issue || '?'}"].treatment_planned`);
  if (!flags.length) log('[upgrade:numeric-grounding] all measurement values grounded in transcript');
  return { flags };
}

// ── G(3) · date grounding ────────────────────────────────────────────────────
// Absolute dates the model invents (e.g. "married on 1996-12-25" when no 1996 is in the
// transcript) are dangerous. Deterministically: extract every date in the note; if its
// year isn't anywhere in the transcript, STRIP the date from the line (rewrite) and flag.
// Also flag implausible years (future, or >130y ago) even when grounded — those are
// usually de-identification date-shift artifacts. Rule-based, à la HeidelTime/SUTime.
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const YEAR_G = /\b(?:19|20)\d{2}\b/g;
const dateRe = () => new RegExp(`\\b(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:19|20)\\d{2}|(?:${MONTHS})\\.?\\s+(?:19|20)\\d{2}|(?:19|20)\\d{2})\\b`, 'gi');
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const yearsIn = (s) => [...String(s || '').matchAll(YEAR_G)].map((m) => m[0]);

export function enforceDateGrounding(note, transcript = '', log = () => {}, opts = {}) {
  const mode = opts.mode || process.env.UPGRADE_DATE_MODE || 'strip';   // 'strip' | 'flag'
  const nowYear = new Date().getFullYear();
  const tYears = new Set(yearsIn(transcript));
  const tLower = String(transcript).toLowerCase();
  let checked = 0, ungrounded = 0; const flags = [];

  const processField = (text) => {
    const kept = [];
    for (const line of splitLines(text)) {
      let newLine = line;
      for (const m of [...line.matchAll(dateRe())]) {
        const tok = m[0]; checked++;
        const ys = yearsIn(tok);
        for (const y of ys) { const yn = Number(y); if (yn > nowYear || yn < nowYear - 130) flags.push({ type: 'implausible_date', field: 'note', message: `Date "${tok}" has an implausible year (${y}) — likely a transcription / de-identification artifact; verify.`, severity: 'warning' }); }
        const grounded = tLower.includes(tok.toLowerCase()) || (ys.length > 0 && ys.every((y) => tYears.has(y)));
        if (!grounded) {
          ungrounded++;
          flags.push({ type: 'ungrounded_date', field: 'note', message: `Date "${tok}" is not supported by the transcript — ${mode === 'strip' ? 'removed' : 'flagged'} (possible hallucination).`, severity: 'critical' });
          log(`[upgrade:date-grounding] ungrounded date "${tok}" (year not in transcript) — ${mode === 'strip' ? 'stripped from' : 'flagged in'}: "${line}"`);
          if (mode === 'strip') newLine = newLine.replace(new RegExp(`\\s*(?:\\b(?:on|in|since|dated|from|until|by)\\b\\s*)?${escapeRx(tok)}`, 'i'), '').replace(/\s{2,}/g, ' ').replace(/[\s,;:–-]+$/, '').replace(/\(\s*\)/g, '').trim();
        }
      }
      if (newLine) kept.push(newLine);
      else log(`[upgrade:date-grounding] dropped now-empty line after removing an ungrounded date: "${line}"`);
    }
    return kept.join('\n');
  };

  for (const k of Object.keys(note.subjective || {})) note.subjective[k] = processField(note.subjective[k]);
  for (const k of Object.keys(note.past_medical_history || {})) note.past_medical_history[k] = processField(note.past_medical_history[k]);
  if (note.objective) for (const k of Object.keys(note.objective)) if (typeof note.objective[k] === 'string') note.objective[k] = processField(note.objective[k]);
  for (const p of (note.assessment_and_plan || [])) {
    for (const f of ['assessment', 'investigations_planned', 'treatment_planned', 'referrals']) if (typeof p[f] === 'string') p[f] = processField(p[f]);
  }
  if (!ungrounded) log('[upgrade:date-grounding] all dates grounded in transcript');
  return { flags, checked, ungrounded };
}

// ── C(2) · multi-system fallback ─────────────────────────────────────────────
// A narrow single-disease label (anemia, gynecology, …) makes the SOAP generator drop
// other active problems. When ≥3 distinct organ systems are discussed, fall back to the
// comprehensive general_primary_care template so nothing is suppressed.
const SYSTEM_RX = {
  cardio: /\b(blood pressure|hypertension|cholesterol|lipid|statin|palpitation|chest pain)\b/i,
  endo: /\b(diabet|thyroid|vitamin d|a1c|hba1c|insulin)\b/i,
  gi: /\b(stomach|abdominal|bowel|constipat|diarrh|nausea|reflux|gastro|liver|ulcer)\b/i,
  gyn: /\b(pregnan|menstru|period|pelvic|ovarian|pcos|contracept|conceive|\blmp\b)\b/i,
  resp: /\b(cough|shortness of breath|asthma|copd|wheeze|congestion)\b/i,
  msk: /\b(joint|back pain|knee|shoulder|arthritis|sprain|fracture)\b/i,
  derm: /\b(rash|lesion|eczema|acne|dermatitis)\b/i,
  psych: /\b(anxiety|depress|adhd|\badd\b|mood|insomnia)\b/i,
  heme: /\b(anemia|anaemia|iron|ferritin|b12|lymphocyt|\bcbc\b)\b/i,
};
const NARROW_TYPES = new Set(['anemia', 'diabetes', 'hypertension', 'lipids', 'gynecology', 'dermatology', 'musculoskeletal', 'mental_health', 'weight_loss', 'acute_injury']);
export function multiSystemFallback(encounterType, transcript = '', log = () => {}) {
  if (!NARROW_TYPES.has(encounterType)) return encounterType;
  const t = String(transcript);
  const systems = Object.entries(SYSTEM_RX).filter(([, rx]) => rx.test(t)).map(([k]) => k);
  if (systems.length >= 3) {
    log(`[upgrade:multi-system] ${systems.length} organ systems discussed (${systems.join(', ')}) — overriding '${encounterType}' → general_primary_care so no problems are dropped`);
    return 'general_primary_care';
  }
  return encounterType;
}

// ── E · benchmarking-prompt detector (contract-drift guard) ──────────────────
// The qa-validator's runtime contract is the gate schema {status, action, …}. If a
// benchmarking evaluator rubric (Heidi-vs-Notera, n=2000) was mistakenly published to
// it, the two contracts conflict. Detect it so the agent can fall back to the gate.
export function looksLikeBenchmarkingPrompt(text) {
  const s = String(text || '');
  let hits = 0;
  if (/metric_\d+_/i.test(s)) hits++;
  if (/overall_winner/i.test(s)) hits++;
  if (/\bn\s*=\s*2000\b/i.test(s)) hits++;
  if (/blinded evaluator|benchmarking study/i.test(s)) hits++;
  if (/heidi_note|notera_note/i.test(s) && /structure_score|story_flow/i.test(s)) hits++;
  return hits >= 2;
}

// ── orchestration ────────────────────────────────────────────────────────────
/**
 * Run every note-level upgrade guardrail in order. Mutates + returns the note,
 * collects the log lines, and returns any flags to merge into metadata.flags.
 * @param {(line:string)=>void} log  sink for [upgrade:*] lines (default: console.log)
 */
export function applyUpgradeGuardrails(note, { log, transcript = '', entities = [] } = {}) {
  const lines = [];
  const sink = (l) => { lines.push(l); (log || console.log)(l); };
  if (!note || !note.subjective) return { note, flags: [], logs: lines };
  // medication names for the pharmacy-binding check: NER drugs + the note's own list
  const meds = [
    ...(Array.isArray(note?.metadata?.medications_mentioned) ? note.metadata.medications_mentioned : []),
    ...(entities || []).filter((e) => /DRUG|MEDICATION|CHEMICAL|MED7/i.test(String(e.label || ''))).map((e) => e.text),
  ];
  const rep = stripRepetition(note, sink);   // FIRST: kill degenerate repetition loops
  const a = routeMedicationToPlan(note, sink);
  const g = validateTemporalStatus(note, sink);
  const d = flagSuspiciousValues(note, sink);
  const ph = verifyPharmacyBinding(note, { transcript, meds }, sink);
  const np = flagNonPatientContext(note, transcript, sink);
  const nm = flagUngroundedNumbers(note, transcript, sink);
  const dt = enforceDateGrounding(note, transcript, sink);
  const nr = groundNamedReferences(note, transcript, sink);
  const flags = [...d.flags, ...ph.flags, ...np.flags, ...nm.flags, ...dt.flags, ...nr.flags];
  // Fact-grounding rating: share of dates + measurement numbers that trace to the transcript.
  const numChecked = (nm.flags.filter((f) => f.type === 'ungrounded_number').length);
  const totalChecked = dt.checked + numChecked;              // numbers only counted when ungrounded (flagged)
  const ungrounded = dt.ungrounded + numChecked;
  const rate = totalChecked ? +(1 - ungrounded / totalChecked).toFixed(3) : 1;
  note.metadata = note.metadata || {};
  note.metadata.grounding = { dates_checked: dt.checked, dates_ungrounded: dt.ungrounded, numbers_ungrounded: numChecked, references_stripped: nr.stripped, repetition_loops_collapsed: rep.fixed, rate };
  sink(`[upgrade] guardrails complete — ${rep.fixed} repetition loop(s), ${a.moved} med re-routed, ${g.fixed} temporal, ${d.flags.length} value, ${ph.flags.length} pharmacy, ${np.flags.length} non-patient, ${nm.flags.length} ungrounded-number, ${dt.ungrounded} ungrounded-date, ${nr.flags.length} fabricated-reference flag(s) · grounding rate ${(rate * 100).toFixed(0)}%`);
  return { note, flags, logs: lines };
}
