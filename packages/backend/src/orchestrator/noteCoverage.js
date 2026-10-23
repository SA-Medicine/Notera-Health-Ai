// Coverage check (Style Spec v2.1.2, owner unlocked 2026-10-23: "there should be nothing missing").
// After the plan-completeness stage, one more reading of the transcript against the FINISHED note: which clinically relevant things that were said
// are not in the note anywhere? Each one is added, under the topic / section / problem where it belongs, but only when
//   * it carries an exact quote that is really in the transcript (checked by code, otherwise dropped),
//   * the note does not already say it (checked by code),
//   * it is a short plain clinical phrase, at most MAX_ITEMS in all.
// It never rewords a line that exists, never creates a diagnosis, never removes anything. The grounding agent runs after it and checks the added lines
// like every other line. Plan items go through the plan-completeness code (same checks). Off switch: NOTE_COVERAGE=0.
'use strict';

import { quoted, overlap } from './planSweep.js';
import { applyComplete, listing } from './planComplete.js';
import { noteToMarkdown } from './renderMarkdown.js';

export const MAX_ITEMS = 12;
const SUBJ = ['reason_for_visit', 'hpi_details', 'aggravating_relieving_factors', 'symptom_progression', 'previous_episodes', 'functional_impact', 'associated_symptoms'];
const SECTIONS = ['subjective', 'history', 'objective', 'plan'];

export const COVERAGE_SYS = `You check a finished clinic note against the transcript and find what is MISSING from it.
You receive the TRANSCRIPT, the NOTE (Subjective with its topic headings, Past Medical History, Objective) and the numbered PLAN PROBLEMS.
List every clinically relevant thing that the patient or the clinician said in this visit that the note does not say anywhere:
 - "subjective": a symptom, its duration, severity, timing, what makes it better or worse, what the patient already tried (with doses and how often), associated symptoms, important negatives, how it affects daily life, what the patient asked for. "topic" = the exact heading it belongs under (a heading already in the Subjective), or a short new heading if none fits.
 - "history": past conditions, operations, earlier tests and their results, allergies, vaccines received, family or social history that matters, the patient's medicines.
 - "objective": an examination the clinician did and what they found ("field":"examination"), or a result or measurement that was given ("field":"results").
 - "plan": a medicine started, changed, stopped or told to continue, advice, a follow-up, a test ordered, a referral, a prescription or requisition. "n" = the number of the problem it belongs to; "field" = treatment | advice | follow_up | investigations | referrals.
Rules:
 - Every item needs "evidence": 6-25 words copied exactly from the transcript. No quote, no item.
 - Only things about THIS patient. Not greetings, small talk, scheduling chat, thanks, or words about other people.
 - Use the speaker's own numbers, names and doses exactly. Short plain clinical phrase, one fact per item, no interpretation, no diagnosis.
 - Do not repeat anything the note already says, even in other words. If nothing is missing, return an empty list.
Return ONLY JSON: {"items":[{"section":"subjective|history|objective|plan","topic":"","n":0,"field":"","text":"","evidence":""}]}. At most ${MAX_ITEMS} items.`;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const clean = (x) => String(x || '').replace(/^[-•*]\s*/, '').trim();
const isHead = (x) => /^[A-Za-z][A-Za-z &/,'-]{1,50}:$/.test(clean(x));
const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

export function parseCoverage(raw) {
  try { const j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); return Array.isArray(j?.items) ? j.items : []; } catch { return []; }
}

/** Put a line under a topic heading of the story-style Subjective; a topic that is not there becomes a new heading at the end. */
export function addSubjective(note, topic, text) {
  const s = (note.subjective ||= {}); const line = text.replace(/^./, (c) => c.toUpperCase());
  if (note.metadata?.subjective_style !== 'topics') { s.hpi_details = [String(s.hpi_details || '').trim(), line].filter(Boolean).join('\n'); return; }
  const want = norm(String(topic || '').replace(/:$/, ''));
  if (want) for (const f of SUBJ) {
    const lines = String(s[f] || '').split('\n').map((x) => x.trim()).filter(Boolean); const at = lines.findIndex((l) => isHead(l) && norm(clean(l).replace(/:$/, '')) === want);
    if (at < 0) continue;
    let end = at + 1; while (end < lines.length && !isHead(lines[end])) end++;
    lines.splice(end, 0, '- ' + line); s[f] = lines.join('\n'); return;
  }
  const head = String(topic || '').replace(/:$/, '').trim(); const heading = /^[A-Za-z][A-Za-z &/,'-]{1,49}$/.test(head) ? head + ':' : 'Other:';
  const last = [...SUBJ].reverse().find((f) => String(s[f] || '').trim()) || 'hpi_details';
  s[last] = [String(s[last] || '').trim(), heading, '- ' + line].filter(Boolean).join('\n');
}

/** Which proposed items survive, pure. Returns { subj, hist, obj, plan, dropped }. */
export function acceptCoverage(items, note, transcript) {
  const tx = norm(transcript); const have = strings(note).join(' '); const out = { subj: [], hist: [], obj: [], plan: [], dropped: [] }; let kept = 0;
  for (const it of items || []) {
    const section = String(it?.section || ''); const text = String(it?.text || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');
    if (!SECTIONS.includes(section)) { out.dropped.push({ text, why: 'unknown section' }); continue; }
    if (text.length < 4 || text.length > 200) { out.dropped.push({ text, why: 'empty or too long' }); continue; }
    if (kept >= MAX_ITEMS) { out.dropped.push({ text, why: 'over the limit' }); continue; }
    if (!quoted(it.evidence, tx)) { out.dropped.push({ text, why: 'quote not found in the transcript' }); continue; }
    if (section !== 'plan' && overlap(text, have) >= 0.7) { out.dropped.push({ text, why: 'already in the note' }); continue; }
    if (section === 'subjective') out.subj.push({ topic: String(it.topic || ''), text });
    else if (section === 'history') out.hist.push({ text });
    else if (section === 'objective') out.obj.push({ text, field: it.field === 'results' ? 'completed_investigations' : 'examination' });
    else out.plan.push({ n: Number(it.n), field: it.field, text, evidence: it.evidence });
    kept++;
  }
  return out;
}

export async function askCoverage(llm, note, transcript, { timeoutMs = 45000 } = {}) {
  const t0 = Date.now();
  try {
    const body = noteToMarkdown(note).split('### Assessment & Plan')[0].trim();
    const raw = await llm.generateContent(COVERAGE_SYS, `TRANSCRIPT:\n"""\n${transcript}\n"""\n\nNOTE:\n${body}\n\nPLAN PROBLEMS:\n${listing(note.assessment_and_plan || [])}\n\nReturn ONLY the JSON.`, null,
      { maxOutputTokens: 4000, temperature: 0, timeoutMs, retries: 2, hedgeMs: 0, thinkingBudget: 512, responseMimeType: 'application/json' });
    return { raw, ms: Date.now() - t0 };
  } catch (e) { return { raw: null, error: String(e.message || e), ms: Date.now() - t0 }; }
}

export function applyCoverage(note, answer, transcript, log = () => {}) {
  if (!answer || answer.raw == null) { if (answer?.error) log('[v2:coverage] skipped — ' + answer.error); return { added: 0, dropped: [], ms: answer?.ms || 0, error: answer?.error }; }
  const a = acceptCoverage(parseCoverage(answer.raw), note, transcript);
  for (const x of a.subj) addSubjective(note, x.topic, x.text);
  if (a.hist.length) { const p = (note.past_medical_history ||= {}); p.medical_surgical = [String(p.medical_surgical || '').trim(), ...a.hist.map((x) => x.text.replace(/^./, (c) => c.toUpperCase()))].filter(Boolean).join('\n'); }
  for (const x of a.obj) { const o = (note.objective ||= {}); o[x.field] = [String(o[x.field] || '').trim(), x.text.replace(/^./, (c) => c.toUpperCase())].filter(Boolean).join('\n'); }
  let plan = { added: [] }; if (a.plan.length) plan = applyComplete(note, { raw: JSON.stringify({ items: a.plan }), ms: 0 }, transcript, () => {});
  const added = a.subj.length + a.hist.length + a.obj.length + plan.added.length;
  log(`[v2:coverage] ${added} missing item(s) added${added ? `: ${[...a.subj.map((x) => x.text), ...a.hist.map((x) => x.text), ...a.obj.map((x) => x.text), ...plan.added.map((x) => x.part)].join(' | ').slice(0, 400)}` : ''}${a.dropped.length ? ` · ${a.dropped.length} dropped (${a.dropped.map((d) => d.why).join(', ')})` : ''}`);
  return { added, subjective: a.subj.length, history: a.hist.length, objective: a.obj.length, plan: plan.added.length, dropped: a.dropped, ms: answer.ms };
}

export async function coverNote(llm, note, transcript, log = () => {}, opts = {}) {
  return applyCoverage(note, await askCoverage(llm, note, transcript, opts), transcript, log);
}
