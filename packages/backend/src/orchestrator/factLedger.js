// Fact ledger (Style Spec v2.3, owner 2026-10-24: "make sure everything is placed"; "missing the critical facts is a great issue for me").
// The fact graph (factGraph.js) lists every fact of the visit with an exact quote. The ledger checks each required fact against the FINISHED note and
// makes sure none is left out:
//   1. FOUND   a note line (or a plan problem block) carries the fact's words and numbers (code, no model);
//   2. PLACED  a fact not found is given to one model call together with the note and the numbered problems: it says where each belongs (section, topic
//              or problem, field, short phrase) or points at the exact note line that already holds it (code checks that the line exists);
//   3. FORCED  anything still not in the note is written in by rule, in the section its type belongs to, with the fact's own words.
// A fact is grounded by construction (its quote is in the transcript, checked by factGraph.js), and the grounding agent still runs after this stage.
// The report says, for every fact, found / placed / forced / skipped and where. Off switch: FACT_LEDGER=0.
'use strict';

import { overlap } from './planSweep.js';
import { noteToMarkdown } from './renderMarkdown.js';
import { addSubjective, applyCoverage } from './noteCoverage.js';
import { listing } from './planComplete.js';

const STOP = new Set('the and for with that this have has had was were are you your his her she him they them their from about into onto over under then than also just very really okay yeah well like some any all can could would should will not but out get got going been being did does doing one two three patient says said told states reported reports mentions mentioned noted discussed discusses need needs wants want'.split(' '));
const NEG = /\b(no|not|denies|denied|without|negative|never|none|nil|absent)\b/i;
const SKIP_TYPES = new Set(['temporal_reference', 'clinician_reasoning']);
const ACTION_WORDS = /\b(advis\w*|should|need\w*|avoid\w*|use|apply|take|return|stop|start|continue|rest|ice|elevat\w*|exercis\w*|limit|drink|eat|call|go to|see|keep|do not|don't|try|increase|decrease|monitor|check|follow|book|arrange|schedule\w*|fax\w*|prescri\w*|refer\w*|order\w*)\b/i;
const GIVEN_RX = /\b(vaccin\w*|injection|shot|immuni[sz]ation|administered|booster)\b/i;
const SUBJ_TYPES = new Set(['symptom', 'injury_mechanism', 'contextual_activity', 'resolved_symptom', 'previous_episode', 'lifestyle_modification', 'medication_tolerance', 'care_barrier', 'clinical_context', 'patient_preference', 'shared_decision_making', 'treatment_duration']);
const HIST_TYPES = new Set(['pmh', 'family_history', 'social_history', 'procedure_history']);
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '').slice(0, 6);
// the same thing said two ways counts as the same: follow-up / return in / rtc, x-ray / xray, blood pressure / bp, 150/80 / 150 over 80
const canon = (s) => String(s || '').toLowerCase().replace(/follow[\s-]?up|\brtc\b|return(?:ing)? (?:to (?:the )?clinic )?(?:in|visit)|come back in|see (?:you|me) (?:again )?in|re-?check(?:ed)?|review in/g, ' followup ').replace(/x[\s-]?rays?/g, ' xray ').replace(/blood pressure|\bbp\b/g, ' bloodpressure ').replace(/(\d)\s*\/\s*(\d)/g, '$1 $2').replace(/(\d)\s+over\s+(\d)/g, '$1 $2');
const words = (s) => canon(s).replace(/[^a-z0-9.\s]/g, ' ').split(/\s+/).filter(Boolean);
const numsOf = (s) => (String(s || '').match(/\d+(?:\.\d+)?/g) || []).map((n) => String(Number(n)));
const cap = (t) => String(t).trim().replace(/^./, (c) => c.toUpperCase());

/** The words and numbers that must be in the note for the fact to count as there. */
export function keysOf(f) {
  const src = [f.text, f.medication, f.dose, f.frequency, f.value && f.value !== 'not_stated' ? f.value : '', f.unit && f.unit !== 'not_stated' ? f.unit : ''].join(' ');
  const stems = [...new Set(words(src).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d/.test(w)).map(stem))]; const nums = [...new Set(numsOf(src))];
  return { stems, nums };
}

/** Which facts the note must hold. */
export function requiredFacts(facts) {
  const seen = new Set();
  return (facts || []).filter((f) => {
    if (!f.render_required || !f.grounded || f.confidence < 0.5 || SKIP_TYPES.has(f.type) || !f.text) return false;
    if (f.type === 'medication' && (f.medication_status === 'mention' || (f.negative && f.medication_status !== 'planned'))) return false;
    if (f.importance === 'background') return false;
    // the clinician explaining something ("flu season is early", "pneumonia shot is for the lungs") is not a fact the note must hold; an instruction needs an action
    if (f.type === 'clinical_context' && f.importance !== 'critical') return false;
    if (f.type === 'treatment_instruction' && !ACTION_WORDS.test(f.text)) return false;
    const k = words(f.text).join(' '); if (seen.has(k)) return false; seen.add(k); return true;
  });
}

/** The places a fact can be found: every line of the note, and every plan problem as one block. */
export function unitsOf(note) {
  const md = noteToMarkdown(note); const units = []; let section = ''; let block = null; let topic = '';
  for (const raw of md.split('\n')) {
    const l = raw.trim(); if (!l) continue;
    const h = l.match(/^###\s+(.+)$/); if (h) { section = h[1]; block = null; topic = ''; continue; }
    const tp = l.match(/^\*\*(.+?)\*\*\s*$/); if (tp) topic = tp[1].replace(/:$/, '');
    const p = section.startsWith('Assessment') && l.match(/^\d+\.\s+\*\*(.+?)\*\*/);
    if (p) { block = { section, text: p[1], title: p[1] }; units.push(block); continue; }
    if (block && /^\s*-\s/.test(raw)) { block.text += ' ' + l; }
    units.push({ section, text: (topic && !section.startsWith('Assessment') ? topic + ' ' : '') + l.replace(/^[-*]\s*/, '').replace(/\*\*/g, ''), block: block && /^\s*-\s/.test(raw) ? block.title : '' });
  }
  return units.map((u) => ({ ...u, w: new Set(words(u.text).map(stem)), nums: new Set(numsOf(u.text)), neg: NEG.test(u.text) }));
}

export function matchFact(f, units) {
  const { stems, nums } = keysOf(f); if (!stems.length && !nums.length) return null;
  const need = stems.length <= 2 ? stems.length : Math.ceil(stems.length * 0.6); let best = null;
  for (const u of units) {
    const hit = stems.filter((s) => u.w.has(s)).length; if (hit < need) continue;
    if (nums.length && !nums.every((n) => u.nums.has(n))) continue;
    if (f.negative && !u.neg) continue;
    const score = hit / Math.max(1, stems.length); if (!best || score > best.score) best = { section: u.section, text: u.text, score };
  }
  return best;
}

export function ledger(note, facts) {
  const units = unitsOf(note); const rows = []; const missing = [];
  for (const f of facts) { const m = matchFact(f, units); if (m) rows.push({ id: f.id, status: 'found', where: m.section, line: m.text.slice(0, 140) }); else { rows.push({ id: f.id, status: 'missing' }); missing.push(f); } }
  return { rows, missing };
}

// ── rule placement (step 3): the fact's own words, in the section its type belongs to ────────────────────────────────────────────
const addLine = (obj, field, text) => { const t = String(obj[field] || '').trim(); obj[field] = t ? `${t}\n${text}` : text; };
const addPlan = (p, field, text) => { const t = String(p[field] || '').trim(); p[field] = t ? `${t.replace(/[;\s]+$/, '')}${field === 'treatment_planned' ? '; ' : '\n'}${text}` : text; };
const newProblem = (note, issue) => { const ap = (note.assessment_and_plan ||= []); const p = { issue: cap(issue), diagnosis: '', assessment: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: '', referrals: '' }; ap.push(p); return p; };

export function bestProblem(note, f, graph) {
  const ap = note.assessment_and_plan || []; if (!ap.length) return null;
  const linked = (graph?.edges || []).filter((e) => e.from === f.id || e.to === f.id).map((e) => (e.from === f.id ? e.to : e.from));
  const texts = [f.text + ' ' + f.body_part, ...linked.map((id) => (graph.facts.find((x) => x.id === id) || {}).text || '')];
  let best = -1, score = 0.15;
  ap.forEach((p, i) => { const t = `${p.issue} ${p.diagnosis || ''}`; const s = Math.max(...texts.map((x) => overlap(x, t))); if (s > score) { score = s; best = i; } });
  return best >= 0 ? ap[best] : ap[0];
}

const ACTION_LEAD = /^(start|stop|continue|increase|decrease|reduce|switch|change|refill|renew|resume|discontinue|titrate|prescribe|begin|add|hold|taper)/i;
/** A plan item for a medicine that starts with the action ("Increase Atacand ...", "Stop naproxen"), the drug named with its dose and frequency. */
export function medLine(f, med) {
  const t = String(f.text || '').replace(/\.$/, '').trim();
  if (ACTION_LEAD.test(t)) return cap(t);
  const verb = /increas|higher dose|up the dose/i.test(t) ? 'Increase' : /decreas|reduc|lower/i.test(t) ? 'Decrease' : /\bstop|discontinu|\bhold\b/i.test(t) ? 'Stop' : /continu|refill|renew|resume/i.test(t) ? 'Continue' : 'Start';
  const base = med && f.medication ? med : cap(t); const extra = numsOf(t).filter((n) => !numsOf(base).includes(n)).length ? ` (${t})` : '';
  return `${verb} ${base}${extra}`;
}

/** Write one fact into the note by rule. Returns where it went. */
export function placeFact(note, f, graph) {
  const line = cap(f.text.replace(/\.$/, ''));
  const med = f.medication ? cap([f.medication, f.dose, f.frequency].filter(Boolean).join(' ')) : line;
  if (GIVEN_RX.test(f.text) && !HIST_TYPES.has(f.type) && f.type !== 'family_history' && !/\b(due|next year|last year|ago|history of|had a)\b/i.test(f.text)) {   // a vaccine or injection given in the visit is a plan item under its own problem, never an exam finding or a vital sign
    const ap = (note.assessment_and_plan ||= []); const kind = /\bb12\b/i.test(f.text) ? 'b12' : /vaccin|immuni|\bflu\b|influenza|tetanus|mmr|tdap|covid|shingrix|booster/i.test(f.text) ? 'vaccine' : 'injection';
    const rx = { b12: /b12/i, vaccine: /vaccin|immuni/i, injection: /injection/i }[kind]; let p = ap.find((x) => rx.test(String(x?.issue || '')) && (kind !== 'injection' || !/b12|vaccin/i.test(String(x.issue))));
    if (!p) p = newProblem(note, { b12: 'Vitamin B12 injection', vaccine: 'Immunisation', injection: 'Injection' }[kind]);
    addPlan(p, 'treatment_planned', /administ|given|received/i.test(line) ? line : `${line} administered`); return `Plan / ${p.issue} / Given today`;
  }
  if (f.type === 'physical_exam' || f.type === 'normal_finding') {
    const o = (note.objective ||= {});
    if (f.numeric_type === 'vitals' || /\b(blood pressure|bp|pulse|heart rate|temperature|spo2|weight|bmi)\b/i.test(f.text)) { addLine(o, 'vital_signs', line); return 'Objective / Vital Signs'; }
    addLine(o, 'examination', f.region ? `${cap(f.region)}: ${f.text.replace(/\.$/, '')}` : line); return 'Objective / Examination';
  }
  if (f.type === 'lab_result' || (f.type === 'investigation' && (f.value || /normal|abnormal|result|showed|shows|negative|positive/i.test(f.text)))) { addLine(note.objective ||= {}, 'completed_investigations', line); return 'Objective / Investigations'; }
  if (HIST_TYPES.has(f.type)) { const p = (note.past_medical_history ||= {}); addLine(p, f.type === 'family_history' ? 'family' : f.type === 'social_history' ? 'social' : 'medical_surgical', line); return 'Past Medical History'; }
  if (f.type === 'medication' || f.type === 'medication_order') {
    if (f.medication_status === 'planned' || f.type === 'medication_order') { const p = bestProblem(note, f, graph) || newProblem(note, f.body_part || 'Medication'); addPlan(p, 'treatment_planned', medLine(f, med)); return `Plan / ${p.issue} / Treatment`; }
    const o = (note.past_medical_history ||= {}); const cur = String(o.other || ''); const m = cur.match(/(^|\n)Medications:\s*(.*)/i);
    if (m) o.other = cur.replace(m[0], `${m[1]}Medications: ${m[2]}${m[2] ? ', ' : ''}${med}`); else addLine(o, 'other', `Medications: ${med}`); return 'Past Medical History / Medications';
  }
  if (f.type === 'investigation') { const p = bestProblem(note, f, graph) || newProblem(note, f.body_part || 'Investigations'); addPlan(p, 'investigations_planned', line); return `Plan / ${p.issue} / Investigations`; }
  if (f.type === 'referral') { const p = bestProblem(note, f, graph) || newProblem(note, f.body_part || 'Referral'); addPlan(p, 'referrals', line); return `Plan / ${p.issue} / Referrals`; }
  if (f.type === 'follow_up') { const p = bestProblem(note, f, graph) || newProblem(note, f.body_part || 'Follow-up'); addPlan(p, 'treatment_planned', /^(follow|rtc|return|recheck|see)/i.test(line) ? line : `Follow-up ${f.text.replace(/\.$/, '')}`); return `Plan / ${p.issue} / Follow-up`; }
  if (f.type === 'treatment' || f.type === 'treatment_instruction' || f.type === 'administrative_action') {
    const p = f.type === 'administrative_action' ? ((note.assessment_and_plan || []).find((x) => /administrative/i.test(x.issue)) || newProblem(note, 'Administrative')) : bestProblem(note, f, graph) || newProblem(note, f.body_part || 'Treatment');
    addPlan(p, 'treatment_planned', f.type === 'treatment_instruction' && !/^(advis|return|avoid|use|apply)/i.test(line) ? `Advised ${f.text.replace(/\.$/, '')}` : line); return `Plan / ${p.issue} / Treatment`;
  }
  if (f.type === 'clinical_impression') { const p = bestProblem(note, f, graph); if (p) { addPlan(p, 'assessment', line); return `Plan / ${p.issue} / Assessment`; } }
  if (f.type === 'diagnosis') {
    if ((f.certainty === 'confirmed' || f.actor === 'physician') && !(note.assessment_and_plan || []).some((p) => overlap(p.issue || '', f.text) >= 0.6)) { newProblem(note, f.text); return 'Plan / new problem'; }
    addLine(note.past_medical_history ||= {}, 'medical_surgical', line); return 'Past Medical History';
  }
  // symptoms, negatives, context, everything else: the Subjective, under the body part it belongs to
  const topic = f.body_part ? cap(f.body_part) : (f.negative ? 'Pertinent Negatives' : 'Additional History');
  addSubjective(note, topic, f.negative && !NEG.test(line) ? `No ${f.text}` : line); return `Subjective / ${topic}`;
}

// ── step 2: one model call for what the code could not find ─────────────────────────────────────────────────────────────────────
export const LEDGER_SYS = `You complete a clinic note from a fact list.
You receive the NOTE (Subjective with topic headings, Past Medical History, Objective), the numbered PLAN PROBLEMS and a list of FACTS that a code check did NOT find in the note. Each fact has an id, a type and the exact words from the visit.
For EVERY fact return one entry:
 - if the note already says it in other words: {"fact":"F012","found_in":"<the exact note line that holds it, copied>"};
 - otherwise say where it belongs: {"fact":"F012","section":"subjective|history|objective|plan","topic":"<exact existing Subjective heading, or a short new heading>","n":<plan problem number, or 0 with "topic" = a plain problem name when no listed problem covers it>,"field":"treatment|advice|follow_up|investigations|referrals|assessment|examination|results","text":"<short plain clinical phrase, the fact's own words, numbers and drug names exactly>"}.
Plan: every medicine started, changed, stopped or continued is its own "treatment" item that starts with the action and names the drug with dose and frequency. A vaccine or procedure given in the visit is "treatment" ("Influenza vaccine administered"). Vitals and exam findings are "objective" ("examination" with the body part, "results" for a test result). Do not invent anything the fact does not say. Never skip a fact without found_in.
Return ONLY JSON: {"entries":[...]}`;

const factLine = (f) => `[${f.id}] ${f.type}${f.medication_status ? '/' + f.medication_status : ''}${f.negative ? '/negative' : ''}${f.body_part ? ' (' + f.body_part + ')' : ''}: ${f.text}${f.value ? ' = ' + f.value + ' ' + (f.unit || '') : ''} | said: "${f.quote.slice(0, 160)}"`;

export async function askPlacement(llm, note, missing, { timeoutMs = 45000 } = {}) {
  const t0 = Date.now();
  try {
    const body = noteToMarkdown(note).split('### Assessment & Plan')[0].trim();
    const raw = await llm.generateContent(LEDGER_SYS, `NOTE:\n${body}\n\nPLAN PROBLEMS:\n${listing(note.assessment_and_plan || [])}\n\nFACTS NOT FOUND:\n${missing.slice(0, 45).map(factLine).join('\n')}\n\nReturn ONLY the JSON.`, null,
      { maxOutputTokens: 5000, temperature: 0, timeoutMs, retries: 2, hedgeMs: 0, thinkingBudget: 512, responseMimeType: 'application/json' });
    return { raw, ms: Date.now() - t0 };
  } catch (e) { return { raw: null, error: String(e.message || e), ms: Date.now() - t0 }; }
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Apply the model's entries: claims of "already there" are checked against the note text; placements go through the coverage checks (exact quote, not already in the note). */
export function applyPlacement(note, answer, missing, transcript, log = () => {}) {
  const out = { placed: new Set(), judgedPresent: new Set(), dropped: [] }; if (!answer || answer.raw == null) return out;
  let entries = []; try { entries = JSON.parse(String(answer.raw).replace(/^```json|```$/g, '').trim()).entries || []; } catch { return out; }
  const md = norm(noteToMarkdown(note)); const byId = new Map(missing.map((f) => [f.id, f])); const items = []; const itemFact = [];
  for (const e of entries) {
    const f = byId.get(e?.fact); if (!f) continue;
    if (e.found_in) { if (md.includes(norm(e.found_in)) && norm(e.found_in).length >= 8) out.judgedPresent.add(f.id); else out.dropped.push({ id: f.id, why: 'claimed line not in the note' }); continue; }
    items.push({ section: e.section, topic: e.topic || '', n: e.n, field: e.field, text: e.text || f.text, evidence: f.quote }); itemFact.push(f.id);
  }
  if (items.length) { const before = norm(noteToMarkdown(note)); applyCoverage(note, { raw: JSON.stringify({ items }), ms: 0 }, transcript, log); if (norm(noteToMarkdown(note)) !== before) for (const id of itemFact) out.placed.add(id); }
  return out;
}

/** The whole stage. Mutates the note. Returns { rows, summary }. */
export async function reconcileFacts(llm, note, graph, transcript, log = () => {}) {
  const t0 = Date.now(); const req = requiredFacts(graph.facts); if (!req.length) return { rows: [], summary: { facts: graph.facts.length, required: 0 }, ms: 0 };
  let L = ledger(note, req); const first = L.missing.length; let placed = new Set(), judged = new Set(), dropped = [];
  if (L.missing.length && llm) {
    const ans = await askPlacement(llm, note, L.missing);
    const r = applyPlacement(note, ans, L.missing, transcript, log); placed = r.placed; judged = r.judgedPresent; dropped = r.dropped;
    if (ans.error) log(`[v2:ledger] placement call skipped — ${ans.error}`);
  }
  L = ledger(note, req); const forced = [];
  for (const f of L.missing) { if (judged.has(f.id) || f.importance === 'minor') continue; /* minor facts are placed only when the model chose to; critical and major ones always */ try { const where = placeFact(note, f, graph); forced.push({ id: f.id, where }); } catch (e) { dropped.push({ id: f.id, why: String(e.message).slice(0, 80) }); } }
  const rows = ledger(note, req).rows.map((r) => (r.status === 'found' ? (placed.has(r.id) ? { ...r, status: 'placed' } : r) : judged.has(r.id) ? { ...r, status: 'found', where: 'in other words' } : r));
  for (const x of forced) { const row = rows.find((r) => r.id === x.id); if (row && row.status !== 'found' && row.status !== 'placed') { row.status = 'forced'; row.where = x.where; } else if (row) { row.status = 'forced'; row.where = x.where; } }
  const count = (s) => rows.filter((r) => r.status === s).length;
  const summary = { facts: graph.facts.length, required: req.length, found: count('found'), placed: count('placed'), forced: count('forced'), stillMissing: rows.filter((r) => r.status === 'missing').length, missingBefore: first };
  log(`[v2:ledger] ${summary.required} required fact(s): ${req.length - first} already in the note, ${summary.placed} placed by the model, ${summary.forced} written in by rule${dropped.length ? ` · ${dropped.length} model entries not used` : ''}`);
  return { rows, summary, dropped, ms: Date.now() - t0 };
}
