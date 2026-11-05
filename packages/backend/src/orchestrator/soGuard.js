// Subjective / Objective guard (2026-11-05, from the owner: "Subjective is what the patient told us; what the doctor examined, measured or concluded belongs in Objective, and the reverse").
// A post-pass on the finished note (rendered markdown). Deterministic, no model call, nothing reworded, nothing dropped: a line is only MOVED to the section it belongs to,
// and the note must hold exactly the same lines afterwards (checked in code; if not, nothing moves).
//
// THE RULES
//  Subjective = what the patient (or a family member) said or did: symptoms and their story, what they took or did not take, habits, worries, what they tried, readings they took at
//               home, their own account of past illness. Objective = what the clinician saw, examined, measured or reviewed in this visit: vitals taken in the clinic, examination
//               findings, results of tests/imaging that were looked at.
//  O -> S  an Objective line that is the patient's own account (reports, denies, did not take, tried, at home, "(patient reported)", since ..., worse/better) and carries no
//          examination / clinic measurement / test-result marker.
//  S -> O  a Subjective line that is an examination finding, a clinic vital, or a test result with no patient-account marker and no history marker (previously, diagnosed in 2018, family).
//  review  a Subjective line that is the DOCTOR's own action (Asked / Advised / Discussed / "Blood pressure check."): listed, never moved (the structured plan has no safe slot).
//  Mixed lines (both kinds of marker) and lines with neither stay where they are. When in doubt nothing moves.
//  Home readings (home BP / glucose / weight) are the patient's, wherever they were written. A section is never emptied.
//  SO_GUARD env: unset = off; "shadow" = proposals stored in note.metadata.soGuard, note unchanged; "1" = the moves are applied.
'use strict';

const PATIENT = [
  /\(patient[- ]reported\)|\bper (the )?patient\b|\bself[- ]reported\b/i,
  /\b(patient|she|he|pt|they)\s+(reports?|reported|states?|stated|says|said|complains?|complained|denies|denied|feels?|felt|noticed|believes|thinks)\b/i,
  /^\s*(reports?|reported|states?|complains? of|denies|denied|feels?|felt|notices?|noticed)\b/i,
  /\b(did not|didn't|does not|doesn't|has not|hasn't|have not|haven't|had not|not been|stopped|missed|forgot|skipped|ran out of|never)\b[^.]{0,40}\b(take|taking|taken|took|use|using|used|check|checking|checked|follow|following|followed|exercise|exercising|eat|eating)\b/i,
  /\b(at home|home (bp|blood pressure|glucose|sugars?|readings?|monitoring|weights?)|self[- ]?monitor\w*)\b/i,
  /\bsince (returning|coming|moving|starting|stopping|last|then|january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  /\b(tried|trying|drinks?|smokes?|smoking|chews?|snores?|exercis\w+|acknowledges?|admits?|mentions?|confirms?)\b/i,
  /^\s*(had|has had|have had|having)\b/i,
  /\b(reported|reports|states|stated|complain\w*|concerns?|worr\w+|cravings?|difficulty|struggl\w+|thought to be|bothering|history)\b/i,
  /\b(wants?|would like|worried|worries|concerned|afraid|fears?|asked|requests?|requested)\b/i,
];
const CLINICIAN = [
  /\b(on|at|during) (exam|examination|palpation|auscultation|inspection)\b/i,
  /\b(auscultat\w*|palpat\w*|percussion|tender to|tender on|non-?tender|erythema|crepitus|range of motion|reflexes?|abnormal gait|antalgic|(no|grade \d|systolic|diastolic) murmurs?|(expiratory|inspiratory|audible|bilateral|diffuse|scattered) (wheez\w*|crackles|rales)|(wheez\w*|crackles|rales) (heard|noted|present|bilaterally)|bowel sounds|abdomen (is )?(soft|distended|non-?distended)|lungs? (are )?clear|clear to auscultation|heart sounds?|jvp|pedal edema|edema noted|mass palpable|rash noted|swelling noted)\b/i,
  /\b(well[- ]appearing|in no (acute )?distress|alert and oriented|oriented to|non-?toxic|appears? (well|comfortable|anxious|tired|unwell))\b/i,
  /\b(bp|blood pressure)\b\s*(is|was|:|of|today|in clinic)?\s*\d{2,3}\s*\/\s*\d{2,3}/i,
  /\b(pulse|heart rate|hr|resp(iratory)? rate|rr|temp(erature)?|spo2|o2 sat\w*|oxygen sat\w*)\b\s*(is|was|:|of|today)?\s*\d/i,
  /^\W*(current |clinic |today'?s? )?(weight|wt|height|bmi)\b\s*(is|was|:|of|today)?\s*\d{1,3}(\.\d)?\s*(lbs?|pounds|kg|cm|inches|in)?\b(?!\s*(loss|gain))[^,;]{0,25}$/i,   // only a short measurement line, not a story that mentions a weight
  /\b(labs?|blood ?work|results?|ultrasound|x-?ray|mri|ct scan|ecg|ekg|a1c|hba1c|creatinine|egfr|ferritin|hemoglobin|haemoglobin|cholesterol|ldl|tsh|psa)\b[^.]{0,30}\b(show\w*|normal|elevated|low|high|within|\d)/i,
  /\b\w+ levels? (is|are|was|were|:)? ?(\d|normal|high|low|elevated|within|stable|abnormal)/i,
  /\b(triglycerides?|glucose|sodium|potassium|calcium|vitamin [a-d]\d?|b12|folate|platelets?|wbc|rbc|urea|bilirubin|alt|ast|crp|esr|inr|troponin|lipids?|hdl|uric acid|albumin|magnesium|phosph\w+)\b[^.]{0,25}\d/i,
  /\b\d+(\.\d+)?\s*\((high|low|elevated|normal|abnormal)/i,
  /\b(no|without) (acute |new |displaced )?(fractures?|effusion|infiltrates?|abnormalit\w+|free fluid)\b/i,
  /\b(urinalysis|swab|culture|biopsy|pathology|dexa|echo(cardiogram)?|cystoscopy|colonoscopy)\b[^.]{0,25}\b(show\w*|reveal\w*|positive|negative|normal|abnormal|consistent with|demonstrat\w*)\b/i,
];
const HISTORY = /\b(history of|completed|performed|was done|done during|previously|formerly|in (19|20)\d\d|\bsince (19|20)\d\d|years? ago|months? ago|family history|mother|father|sister|brother|grand\w+|underwent|surgery|surgical|diagnosed (with|in)|was diagnosed|never formally)\b/i;
// a story of how it started or got worse is the patient's, even when it names a sign the doctor would also look for ("worsened with erythema by Sunday")
const NARRATIVE = /\b(worsen\w*|progressed|as the day|couple of days|few days|yesterday|last (night|week)|post-?injury|got worse|started|began|woke)\b/i;
const DOCTOR_ACTION = /^\s*(review|recheck|repeat|continue|monitor|refer|order|consider|schedule|asked|inquire|inquiry|discussion|awaiting|pending|advised|discussed|explained|recommended|told|offered|suggested|counsel\w*|reviewed with|plan:?|will (start|order|refer|check)|(blood pressure|bp)( check| today| taken)?\.?)\b/i;
const PLAN_IN_O = /^\s*(reassess|rule out|arrange|consider|follow[- ]?up|return (if|to)|recheck|repeat|refer(ral)? to|order|start|stop|discuss)\b/i;   // a plan item that landed in Objective
const HOME = /\b(at home|home scale|on (the |her |his |their )?home|home (bp|blood pressure|glucose|sugars?|readings?|monitoring|weights?))\b|\(patient[- ]reported\)/i;

/** 'patient' | 'clinician' | 'action' | 'neutral' for one note line. */
export function sideOf(line) {
  const l = String(line || '').trim(); if (!l) return 'neutral';
  if (HOME.test(l)) return 'patient';
  if (DOCTOR_ACTION.test(l) && l.length < 80) return 'action';
  if (/\b\d+\s*(mg|mcg|ml|units?|tablets?)\b/i.test(l) && /\b(dose|reduced|increased|decreased|started|stopped|taking|take|takes|daily|twice|per day)\b/i.test(l)) return 'neutral';   // a medicine statement, not a result
  if (/\b(planned|none (specifically )?measured|not (measured|recorded|taken)|no (vitals|measurements)|awaiting|pending|inquire|to be (done|booked|scheduled)|scheduled|booked|will be|needs? to|plan to|waiting for)\b/i.test(l)) return 'neutral';
  const p = PATIENT.some((r) => r.test(l)), c = CLINICIAN.some((r) => r.test(l));
  if (p && c) return 'neutral'; if (p) return 'patient'; if (c) return NARRATIVE.test(l) ? 'neutral' : 'clinician'; return 'neutral';
}

const isBullet = (ln) => /^\s*[-•*]\s+\S/.test(ln);
const bulletText = (ln) => ln.replace(/^\s*[-•*]\s+/, '').trim();
const isHeadLine = (ln) => /^\s*\*\*[^*]+\*\*:?\s*$/.test(ln) || /^\s*[A-Za-z][A-Za-z &/,'-]{1,50}:\s*$/.test(ln);
const STOP = new Set('that this with from have been were they them their there which would about after before while when what also into than then some more most very just only over under'.split(' '));
const words = (s) => new Set((String(s).toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w)));

/** Sections of the rendered markdown: name -> { start (line after ###), end, bullets: [idx...] }. */
export function sections(lines) {
  const out = {}; let cur = null;
  lines.forEach((ln, i) => {
    const h = ln.match(/^###\s+(.*)$/); if (h) { if (cur) cur.end = i; const name = /^subjective/i.test(h[1]) ? 'S' : /^objective/i.test(h[1]) ? 'O' : /^assessment/i.test(h[1]) ? 'A' : /^past medical/i.test(h[1]) ? 'P' : h[1]; cur = { start: i + 1, end: lines.length, bullets: [] }; out[name] = cur; return; }
    if (cur && isBullet(ln)) cur.bullets.push(i);
  });
  return out;
}

/** The moves this guard proposes for a finished note (markdown). Pure. */
export function findMoves(md) {
  const lines = String(md || '').split('\n'); const sec = sections(lines); const moves = [], review = [];
  // a number that is not a duration is a measurement: it does not move on a soft patient word such as "improved"
  const measured = (t) => /\d/.test(t.replace(/\d+(\.\d+)?\s*(-|to)?\s*\d*\s*(day|week|month|year|hour|time)s?/gi, ''));
  if (sec.O) for (const i of sec.O.bullets) {
    const t = bulletText(lines[i]);
    if (sideOf(t) === 'patient' && (HOME.test(t) || !measured(t))) moves.push({ dir: 'O->S', idx: i, line: t, why: HOME.test(t) ? 'the patient\'s own reading or report' : 'the patient\'s own account' });
    else if (PLAN_IN_O.test(t) && t.length < 100) review.push({ dir: 'review', idx: i, line: t, why: 'a plan item in Objective, not a finding' });   // listed, never moved (the structured plan has no safe slot)
  }
  if (sec.S) for (const i of sec.S.bullets) {
    const t = bulletText(lines[i]); const s = sideOf(t);
    if (s === 'clinician' && t.length <= 150 && !HISTORY.test(t) && !NARRATIVE.test(t)) moves.push({ dir: 'S->O', idx: i, line: t, why: 'an examination finding, clinic measurement or test result' });
    else if (s === 'action') review.push({ dir: 'review', idx: i, line: t, why: 'the doctor\'s own action, not what the patient said' });
  }
  // a section is never emptied
  const out = []; for (const [key, sc] of [['O->S', sec.O], ['S->O', sec.S]]) { const mine = moves.filter((m) => m.dir === key); if (sc && mine.length && mine.length >= sc.bullets.length) mine.pop(); out.push(...mine); }
  return { moves: out.sort((a, b) => a.idx - b.idx), review };
}

function blocks(lines, sc) {   // topic blocks inside a section: heading line + the bullets under it
  const bl = []; let cur = { head: -1, text: '', bullets: [] }; bl.push(cur);
  for (let i = sc.start; i < sc.end; i++) { const ln = lines[i]; if (isBullet(ln)) cur.bullets.push(i); else if (isHeadLine(ln)) { cur = { head: i, text: ln.replace(/[*:]/g, '').trim(), bullets: [] }; bl.push(cur); } }
  return bl.filter((b) => b.head >= 0 || b.bullets.length);
}
const lastOf = (b) => (b.bullets.length ? b.bullets[b.bullets.length - 1] : b.head);

/** Apply the moves: each line leaves its section and is inserted under the best-matching topic of the other one (same word overlap, else at the end). Same lines in, same lines out. */
export function applyMoves(md, moves) {
  if (!moves?.length) return md;
  const lines = String(md).split('\n'); const sec = sections(lines); const gone = new Set(moves.map((m) => m.idx)); const after = new Map();
  const put = (anchor, txt) => { if (!after.has(anchor)) after.set(anchor, []); after.get(anchor).push(txt); };
  for (const m of moves) {
    const target = m.dir === 'O->S' ? sec.S : sec.O; if (!target) { gone.delete(m.idx); continue; }
    const bl = blocks(lines, target).map((b) => ({ ...b, bullets: b.bullets.filter((i) => !gone.has(i)) })); if (!bl.length) { gone.delete(m.idx); continue; }
    const mw = words(m.line); let best = null, bestN = 0;
    for (const b of bl) { const hw = words(b.text), bw = words(b.bullets.map((i) => lines[i]).join(' ')); let n = 0; for (const w of mw) { if (hw.has(w)) n += 2; else if (bw.has(w)) n++; } if (n > bestN) { bestN = n; best = b; } }   // a topic's heading counts double
    if (m.dir === 'S->O' && !best) { const vit = /\b(bp|blood pressure|pulse|heart rate|temp\w*|spo2|sat\w*|weight|height|bmi|resp\w*)\b/i.test(m.line); best = bl.find((b) => (vit ? /vital/i : /exam/i).test(b.text)) || null; }
    best ||= bl[bl.length - 1];
    const anchor = lastOf(best); if (anchor < 0 || gone.has(anchor)) { gone.delete(m.idx); continue; }
    put(anchor, '- ' + m.line);
  }
  const out = []; lines.forEach((ln, i) => { if (!gone.has(i)) out.push(ln); if (after.has(i)) out.push(...after.get(i)); });
  const norm = (arr) => arr.filter(isBullet).map(bulletText).sort().join('\n');
  return norm(out) === norm(lines) ? out.join('\n') : md;   // fail closed: if a single line were lost or invented, the note is left exactly as it was
}

/** @returns {{moves: object[], review: object[], md: string}} (md is the note with the moves applied; the caller decides whether to use it) */
export function soGuard(md) {
  const { moves, review } = findMoves(md); return { moves, review, md: applyMoves(md, moves) };
}
