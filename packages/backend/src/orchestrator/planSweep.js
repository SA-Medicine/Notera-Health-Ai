// "One problem per issue" (format principle F1, from the gold-note analysis of 2026-10-22).
// Style Spec v1 already says: one numbered problem per distinct issue. The writer sometimes leaves a small issue out (a result the
// doctor commented on, a chronic condition reviewed or refilled, a screening, a vaccine, a request). This stage reads the transcript
// once more, compares it with the problems already in the plan, and adds ONLY issues the clinician addressed that no problem covers.
//   * every addition must carry a verbatim quote from the transcript (checked by code, otherwise dropped);
//   * nothing existing is changed, merged, moved or removed; at most 4 additions; no diagnosis is ever created;
//   * its prompt lives in this file and is not part of the locked prompt registry. Off switch: PLAN_SWEEP=0.
'use strict';

export const MAX_ADDITIONS = 2;

export const SWEEP_SYS = `You check whether the Assessment & Plan of a clinic note leaves out an issue the clinician actually addressed. Be thorough: small issues are exactly what gets missed.
You receive the TRANSCRIPT and the PROBLEMS ALREADY IN THE PLAN (title and lines).
STEP 1 - go through the transcript from start to end and list every topic the CLINICIAN dealt with: a result or finding they commented on (even "that is fine" or "a little high"), a long-term condition they reviewed or whose medicine they refilled, a screening (mammogram, Pap, colon, PSA), a vaccine given or due, a request they handled (prescription, referral, therapy, brace, form, note), and any advice or plan they gave. For each topic say which existing problem covers it ("covered_by": the problem title) or "none".
STEP 2 - for every topic with covered_by "none", write an addition. A topic is covered only if an existing problem's title or plan lines actually record it.
An addition is an ISSUE the clinician DID something about (ordered, prescribed, refilled, advised, vaccinated, screened, referred, wrote a form). It is NOT: a lab or test name ("Hemoglobin", "Blood test results", "Complete Blood Count"), a drug name ("Zoloft"), a "review", "history", "allergies", "diet", or an exam finding. If the only thing said is that a result was normal, it is not an addition. Prefer fewer, surer additions: a normal day has 0-1.
Only things done or decided in THIS visit count: an event the clinician mentions from a previous visit ("we gave you the tetanus shot at the last visit", "last time") is history, not an addition.
Rules for additions: you must be able to quote the transcript words that show it (copy them exactly, 6-25 words, from the clinician or the patient's confirmed request); do NOT add follow-up or return visits as their own problem, a symptom an existing problem already explains, anything not in the transcript, or a diagnosis the clinician did not name. Several small results in one panel may share one addition only if the clinician treated them as one issue.
Each addition uses plain short lines, each fact once, only what the transcript supports:
 "title": the plain name of the issue (a condition, a result, a screening, a vaccine, a request), never "rule out", "suspected" or a list of causes; forms and permits go under the title "Administrative";
 "assessment": what the clinician concluded, only if stated, else ""; "investigations_planned": tests ordered or planned, "" if none; "treatment_planned": treatment, advice, refills, vaccines given, "" if none; "referrals": referrals, "" if none; "evidence": the exact quote.
Return ONLY JSON: {"topics":[{"topic":"","covered_by":""}],"additions":[{"title":"","assessment":"","investigations_planned":"","treatment_planned":"","referrals":"","evidence":""}]}. At most ${MAX_ADDITIONS} additions; if every topic is covered, "additions" is [].`;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const stem = (w) => w.replace(/ae/g, 'e').replace(/oe/g, 'e').replace(/(osis|itis|emia|ia|ing|ion|ed|es|s|y)$/, '').slice(0, 7);
const toks = (s) => new Set(norm(s).split(' ').filter((w) => w.length >= 3 && !['the', 'and', 'with', 'for', 'vitamin', 'mild', 'mildly', 'low', 'high'].includes(w)).map(stem));
export function overlap(a, b) { const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); }

/** The quote must really be in the transcript: exact, or at least 80 % of its three-word runs occur there (a model may drop a filler word). */
export function quoted(evidence, txNorm) {
  const w = norm(evidence).split(' ').filter(Boolean); if (w.length < 4) return false;
  if (txNorm.includes(w.join(' '))) return true;
  const grams = []; for (let i = 0; i + 3 <= w.length; i++) grams.push(w.slice(i, i + 3).join(' '));
  return grams.filter((g) => txNorm.includes(g)).length / grams.length >= 0.8;
}

export function parseSweep(raw) {
  try { const j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); return Array.isArray(j?.additions) ? j.additions : []; } catch { return []; }
}

const NOT_AN_ISSUE = /\b(results?|review|panel|levels?|tests?|count|function|medications?|allerg\w*|history|diet|exam|examination|findings?|status|labs?|bloodwork|summary|egfr|ldl|hdl|hemoglobin|haemoglobin|cbc|bmp|cmp)\b/i;
const isDrugOfNote = (title, note) => { const meds = norm((note?.past_medical_history || {}).medications || ''); const t = norm(title); return !!t && t.split(' ').length <= 2 && meds.includes(t); };
const FIELDS = ['assessment', 'investigations_planned', 'treatment_planned', 'referrals'];
const planText = (p) => [p.issue, p.diagnosis, p.assessment, p.investigations_planned, p.treatment_planned, p.referrals].filter(Boolean).join(' ');

/** Which proposed additions survive the checks. Pure: returns the problems to append and the reasons for the rest. */
export function acceptAdditions(additions, existing, transcript, note = null) {
  const tx = norm(transcript); const keep = []; const dropped = [];
  for (const a of additions || []) {
    const title = String(a?.title || '').replace(/\*\*/g, '').trim();
    if (!title) { dropped.push({ title: '(empty)', why: 'no title' }); continue; }
    if (keep.length >= MAX_ADDITIONS) { dropped.push({ title, why: 'over the limit' }); continue; }
    if (/^(follow.?up|return visit|rtc|next visit)\b/i.test(title)) { dropped.push({ title, why: 'follow-up is not a problem' }); continue; }
    if (/\b(rule out|suspected|query|vs\.?|versus|\?)/i.test(title)) { dropped.push({ title, why: 'title is a differential' }); continue; }
    if (!quoted(a.evidence, tx)) { dropped.push({ title, why: 'quote not found in the transcript' }); continue; }
    if (NOT_AN_ISSUE.test(title) || isDrugOfNote(title, note)) { dropped.push({ title, why: 'a test, drug or review is not an issue' }); continue; }
    if (/\b(last (visit|time|week|month)|previous(ly)?|ago|earlier|already (had|done|given))\b/i.test(String(a.evidence || '') + ' ' + String(a.treatment_planned || ''))) { dropped.push({ title, why: 'an earlier visit, not this one' }); continue; }
    const covered = [...existing, ...keep].some((p) => overlap(p.issue || p.title || '', title) >= 0.6 || (overlap(planText(p), title) >= 0.5 && toks(title).size >= 2));
    if (covered) { dropped.push({ title, why: 'already covered' }); continue; }
    const item = { issue: title, diagnosis: '', assessment: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: '', referrals: '', _sweep: true };
    for (const f of FIELDS) item[f] = String(a[f] || '').replace(/\*\*/g, '').trim();
    if (!['investigations_planned', 'treatment_planned', 'referrals'].some((f) => item[f])) { dropped.push({ title, why: 'no action taken' }); continue; }
    keep.push(item);
  }
  return { keep, dropped };
}

const listingOf = (existing) => existing.map((p, i) => `${i + 1}. ${p.issue || ''}\n${[p.diagnosis && `Diagnosis: ${p.diagnosis}`, p.assessment, p.investigations_planned && `Investigations: ${p.investigations_planned}`, p.treatment_planned && `Treatment: ${p.treatment_planned}`, p.referrals && `Referrals: ${p.referrals}`].filter(Boolean).join('\n')}`).join('\n\n') || '(no problems yet)';

/**
 * Step 1 of the stage: the model call. It only READS the note (the problem list) and can therefore start while the editor and the story agent are
 * still working on the same note (speed). Returns the raw answer; never throws into the pipeline.
 */
export async function askSweep(llm, note, transcript, { timeoutMs = 40000 } = {}) {
  const t0 = Date.now();
  try {
    const raw = await llm.generateContent(SWEEP_SYS, `TRANSCRIPT:\n"""\n${transcript}\n"""\n\nPROBLEMS ALREADY IN THE PLAN:\n${listingOf(note.assessment_and_plan || [])}\n\nReturn ONLY the JSON.`, null,
      { maxOutputTokens: 4000, temperature: 0, timeoutMs, retries: 2, hedgeMs: 0, thinkingBudget: 1024, responseMimeType: 'application/json' });
    return { raw, ms: Date.now() - t0 };
  } catch (e) { return { raw: null, error: String(e.message || e), ms: Date.now() - t0 }; }
}

/** Step 2: the checks and the merge, against the FINAL note (so an issue the editor already covered is dropped as "already covered"). */
export function applySweep(note, answer, transcript, log = () => {}) {
  const existing = note.assessment_and_plan || [];
  if (!answer || answer.raw == null) { if (answer?.error) log('[v2:sweep] skipped — ' + answer.error); return { added: [], dropped: [], proposed: 0, topics: [], ms: answer?.ms || 0, error: answer?.error }; }
  const proposed = parseSweep(answer.raw); const { keep, dropped } = acceptAdditions(proposed, existing, transcript, note);
  for (const k of keep) { delete k._sweep; existing.push(k); }
  note.assessment_and_plan = existing;
  if (proposed.length) log(`[v2:sweep] ${keep.length} problem(s) added${keep.length ? ': ' + keep.map((k) => k.issue).join(' | ') : ''}${dropped.length ? ` · ${dropped.length} dropped (${dropped.map((d) => d.why).join(', ')})` : ''}`);
  let topics = []; try { topics = JSON.parse(String(answer.raw).replace(/^```json|```$/g, '').trim()).topics || []; } catch { /* trace only */ }
  return { added: keep.map((k) => k.issue), dropped, proposed: proposed.length, topics, ms: answer.ms };
}

/** Both steps in a row (used by tests and by anything that does not need the overlap). */
export async function sweepPlan(llm, note, transcript, log = () => {}, opts = {}) {
  return applySweep(note, await askSweep(llm, note, transcript, opts), transcript, log);
}
