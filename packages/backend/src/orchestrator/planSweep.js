// "One problem per issue" (format principle F1, from the gold-note analysis of 2026-10-22).
// Style Spec v1 already says: one numbered problem per distinct issue. The writer sometimes leaves a small issue out (a result the
// doctor commented on, a chronic condition reviewed or refilled, a screening, a vaccine, a request). This stage reads the transcript
// once more, compares it with the problems already in the plan, and adds ONLY issues the clinician addressed that no problem covers.
//   * every addition must carry a verbatim quote from the transcript (checked by code, otherwise dropped);
//   * nothing existing is changed, merged, moved or removed; at most 4 additions; no diagnosis is ever created;
//   * its prompt lives in this file and is not part of the locked prompt registry. Off switch: PLAN_SWEEP=0.
'use strict';

export const MAX_ADDITIONS = 4;

export const SWEEP_SYS = `You check whether the Assessment & Plan of a clinic note leaves out an issue the clinician actually addressed. Be thorough: small issues are exactly what gets missed.
You receive the TRANSCRIPT and the PROBLEMS ALREADY IN THE PLAN (title and lines).
STEP 1 - go through the transcript from start to end and list every topic the CLINICIAN dealt with: a result or finding they commented on (even "that is fine" or "a little high"), a long-term condition they reviewed or whose medicine they refilled, a screening (mammogram, Pap, colon, PSA), a vaccine given or due, a request they handled (prescription, referral, therapy, brace, form, note), and any advice or plan they gave. For each topic say which existing problem covers it ("covered_by": the problem title) or "none".
STEP 2 - for every topic with covered_by "none", write an addition. A topic is covered only if an existing problem's title or plan lines actually record it.
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

const FIELDS = ['assessment', 'investigations_planned', 'treatment_planned', 'referrals'];
const planText = (p) => [p.issue, p.diagnosis, p.assessment, p.investigations_planned, p.treatment_planned, p.referrals].filter(Boolean).join(' ');

/** Which proposed additions survive the checks. Pure: returns the problems to append and the reasons for the rest. */
export function acceptAdditions(additions, existing, transcript) {
  const tx = norm(transcript); const keep = []; const dropped = [];
  for (const a of additions || []) {
    const title = String(a?.title || '').replace(/\*\*/g, '').trim();
    if (!title) { dropped.push({ title: '(empty)', why: 'no title' }); continue; }
    if (keep.length >= MAX_ADDITIONS) { dropped.push({ title, why: 'over the limit' }); continue; }
    if (/^(follow.?up|return visit|rtc|next visit)\b/i.test(title)) { dropped.push({ title, why: 'follow-up is not a problem' }); continue; }
    if (/\b(rule out|suspected|query|vs\.?|versus|\?)/i.test(title)) { dropped.push({ title, why: 'title is a differential' }); continue; }
    if (!quoted(a.evidence, tx)) { dropped.push({ title, why: 'quote not found in the transcript' }); continue; }
    const covered = [...existing, ...keep].some((p) => overlap(p.issue || p.title || '', title) >= 0.6 || (overlap(planText(p), title) >= 0.5 && toks(title).size >= 2));
    if (covered) { dropped.push({ title, why: 'already covered' }); continue; }
    const item = { issue: title, diagnosis: '', assessment: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: '', referrals: '', _sweep: true };
    for (const f of FIELDS) item[f] = String(a[f] || '').replace(/\*\*/g, '').trim();
    if (!FIELDS.some((f) => item[f])) { dropped.push({ title, why: 'nothing to record' }); continue; }
    keep.push(item);
  }
  return { keep, dropped };
}

/** Runs the stage. `llm` must offer generateContent(system, user, schema, opts). Appends to note.assessment_and_plan; never throws into the pipeline. */
export async function sweepPlan(llm, note, transcript, log = () => {}, { timeoutMs = 40000 } = {}) {
  const t0 = Date.now(); const existing = note.assessment_and_plan || [];
  const listing = existing.map((p, i) => `${i + 1}. ${p.issue || ''}\n${[p.diagnosis && `Diagnosis: ${p.diagnosis}`, p.assessment, p.investigations_planned && `Investigations: ${p.investigations_planned}`, p.treatment_planned && `Treatment: ${p.treatment_planned}`, p.referrals && `Referrals: ${p.referrals}`].filter(Boolean).join('\n')}`).join('\n\n') || '(no problems yet)';
  const raw = await llm.generateContent(SWEEP_SYS, `TRANSCRIPT:\n"""\n${transcript}\n"""\n\nPROBLEMS ALREADY IN THE PLAN:\n${listing}\n\nReturn ONLY the JSON.`, null,
    { maxOutputTokens: 4000, temperature: 0, timeoutMs, retries: 1, hedgeMs: 0, thinkingBudget: 1024, responseMimeType: 'application/json' });
  const proposed = parseSweep(raw); const { keep, dropped } = acceptAdditions(proposed, existing, transcript);
  for (const k of keep) { delete k._sweep; existing.push(k); }
  note.assessment_and_plan = existing;
  if (proposed.length) log(`[v2:sweep] ${keep.length} problem(s) added${keep.length ? ': ' + keep.map((k) => k.issue).join(' | ') : ''}${dropped.length ? ` · ${dropped.length} dropped (${dropped.map((d) => d.why).join(', ')})` : ''}`);
  let topics = []; try { topics = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()).topics || []; } catch { /* trace only */ }
  return { added: keep.map((k) => k.issue), dropped, proposed: proposed.length, topics, ms: Date.now() - t0 };
}
