// ─────────────────────────────────────────────────────────────────────────────
// tightenNote — LLM "gold-style tightener" (optional agent).
//
// Re-reads the raw transcript + the current draft note and rewrites it to match the
// gold house style: (a) COMPLETE — pulls in clinical facts the pipeline dropped, esp.
// PLAN actions (new/changed meds with dose, destination pharmacy, referrals, exact
// return-to-clinic timing) and ALL investigation results incl. normals; (b) CONCISE —
// trims conversational filler and cross-section repetition; (c) GROUNDED — never invents
// a fact not in the transcript. Returns the SAME schema note so the deterministic
// guardrails + condenser + renderer still run afterward.
//
// Opt-in via NOTE_TIGHTENER=1. Robust: any error / bad JSON → returns the input note.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { noteToMarkdown } from './renderMarkdown.js';

// Local blank note in the v2 Heidi schema shape (kept in sync with schema/index.js) —
// inlined so this agent is self-contained and unit-testable without workspace resolution.
function emptyNote({ specialty = 'general_primary_care', noteType = 'consultation' } = {}) {
  return {
    schema_version: '2.0.0', note_type: noteType, specialty,
    subjective: { reason_for_visit: '', hpi_details: '', aggravating_relieving_factors: '', symptom_progression: '', previous_episodes: '', functional_impact: '', associated_symptoms: '' },
    past_medical_history: { medical_surgical: '', social: '', family: '', exposure: '', immunisation: '', other: '' },
    objective: { vital_signs: '', examination: '', completed_investigations: '' },
    assessment_and_plan: [],
    metadata: { confidence: {}, medications_mentioned: [], flags: [] },
  };
}

const SYS = `You are a meticulous clinical documentation editor. You receive the raw consultation TRANSCRIPT (the sole source of truth) and a DRAFT SOAP note. Produce a corrected, concise, gold-standard note as JSON.

RULES (in priority order):
1. GROUNDING — include ONLY facts explicitly present in the transcript. Never invent or infer a name, number, date, dose, pharmacy, or clinical detail. If the draft contains anything not supported by the transcript, DELETE it.
2. COMPLETENESS — capture EVERY clinically relevant fact from the transcript. In particular the PLAN: every new or changed medication WITH its dose/frequency, the destination pharmacy, any referral, and the exact return-to-clinic timing. Also record ALL investigation results, including normal ones (e.g. "B12 normal", "cholesterol normal").
3. CONCISENESS — short clinical points, not prose. Omit small talk and non-actionable filler. Do not repeat the same fact across sections at the same level of detail.
4. STRUCTURE — Subjective and Objective may stay detailed; Assessment & Plan is concise: one numbered problem each, with a diagnosis and terse plan points.
5. NO REPETITION — state each event, timeline, trigger, medication and symptom ONCE, including PARAPHRASED restatements. If the same trigger/medication/symptom/progression is described in different words across multiple Subjective bullets or sub-headings (e.g. "triggered by stress and lack of sleep" then later "triggers include stress and poor sleep"), keep only the first mention and delete the rest. Never duplicate the same fact across Subjective and Assessment.
6. PRESERVE SPECIFICS — keep exact details verbatim: a specific month/date (e.g. "February" — never generalize to "within the last year"), exact medication names and patient wording ("pumps", "pantoprazole"). Never downgrade a specific to a vague phrase.
7. NO EMBELLISHMENT — do not add parenthetical asides (e.g. "(squeezing fingers)"), and do not invent extra "denies X" items the transcript never mentioned.
8. MERGE THE SUBJECTIVE STORY — "reason_for_visit" is the ONE-LINE chief complaint only; the full narrative goes in "hpi_details" as one flowing chronological story. Do NOT restate the chief complaint verbatim inside hpi_details. There is a single presenting-complaint/history story, not two.
9. ASSOCIATED SYMPTOMS, NO DUPLICATES — "associated_symptoms" contains ONLY symptoms or negatives not already stated in the hpi story. Never repeat a symptom that the story already describes — BUT always keep pertinent negatives (e.g. "No fever", "denies chest pain", "no weight loss") even if the topic is mentioned above.
10. OBJECTIVE IS TERSE — keep it small: vital signs, then only clinically relevant exam and lab findings as short points in "examination"/"completed_investigations". Do NOT create a separate "Key Findings" or "Exam Findings" subsection, and do not pad the objective with narrative.
11. LAB RESULTS ARE COMPLETE — every entry in "completed_investigations" must carry its result value/units and flag, plus the result date when the transcript states one (e.g. "Haemoglobin 88 g/L (low) — 2026-06-01", "HbA1c 6.4%", "B12 normal"). Never write a test name with no result. Only include a date that is actually in the transcript.
12. NO MEDICATIONS IN OBJECTIVE — medication names/doses never appear in "examination" or "completed_investigations"; they belong in the Assessment & Plan. (A drug LEVEL that was measured, e.g. "Digoxin level 0.9", is a lab result and may stay.)
13. NAME EACH PROBLEM — every Assessment & Plan entry's "issue" is the PROBLEM or DIAGNOSIS NAME (e.g. "Diverticulitis", "Left knee quadriceps tendon injury"), never a bare number or placeholder. Keep genuinely distinct problems as SEPARATE entries — do not merge two different problems (e.g. left knee vs right knee) into one.
14. PRESERVE NAMED SPECIFICS FROM THE TRANSCRIPT — when the transcript states them, keep the referral specialist's NAME and PHONE NUMBER in "referrals", and use the SPECIFIC lab test name with its value (e.g. "LDL 4.22", not "another value at 4.22"). Never invent a name, number or test — only include what the transcript actually says.
15. TEMPORAL STATUS OF ACTIONS — distinguish COMPLETED from PLANNED. If the transcript says an action was ALREADY done (e.g. "already renewed", "prescription was faxed", "requisition given"), record it as completed/historical context — do NOT write it as a future plan to be done.
16. CONSENT — if the patient DECLINED or refused an intervention (medication, test, referral, procedure), record it explicitly as declined (e.g. "Patient declined Jardiance"). NEVER list a declined intervention as an active plan or order.
17. PRESERVE EVERY PROBLEM AND SECONDARY ACTION — do NOT merge distinct problems into umbrella categories. Each active concern is its own Assessment & Plan entry, and every secondary action (counseling, routine screening, pre-visit blood work, referrals, and the EXACT follow-up interval) is kept — never dropped when consolidating.
18. MEDICATION FIDELITY — use the medication name EXACTLY as stated in the transcript. Never substitute a phonetically or clinically similar drug (e.g. Zofran is NOT Zolpidem; Silodosin is NOT Alfuzosin). Preserve exact dose, frequency, and refill count.
19. LAB ANALYTE BINDING — bind each numeric lab value to its CORRECT analyte/panel (e.g. a TSH value stays with TSH, not the lipid panel). Do not attach a number to the wrong test.
20. TELEHEALTH / NO-EXAM OBJECTIVE — for phone or virtual encounters where no physical exam was done, state "No physical exam performed (telehealth)". Capture exact numeric vitals (e.g. "BP 105/54") whenever the transcript gives them.
21. CAPTURE PATIENT REQUESTS & INQUIRIES — explicit patient questions or requests about procedures/tests (e.g. "asked about a needle aspiration", "requested a referral", "wants to discuss X") are clinically relevant; record them as part of the relevant problem's assessment/plan. Do not drop them just because no order resulted.

Return ONLY this JSON object (no markdown, no commentary). Every string field is newline-separated short points:
{
  "subjective": { "reason_for_visit": "", "hpi_details": "", "aggravating_relieving_factors": "", "symptom_progression": "", "previous_episodes": "", "functional_impact": "", "associated_symptoms": "" },
  "past_medical_history": { "medical_surgical": "", "social": "", "family": "", "exposure": "", "immunisation": "", "other": "" },
  "objective": { "vital_signs": "", "examination": "", "completed_investigations": "" },
  "assessment_and_plan": [ { "issue": "", "diagnosis": "", "assessment": "", "investigations_planned": "", "treatment_planned": "", "referrals": "" } ]
}`;

// compact robust parse: strip fences → JSON.parse → close a truncated object
function safeParse(raw) {
  const s = String(raw || '').replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(s); } catch { /* repair */ }
  const start = s.indexOf('{'); if (start < 0) return null;
  const body = s.slice(start); let inStr = false, esc = false; const stack = [];
  for (let k = 0; k < body.length; k++) { const c = body[k]; if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; } if (c === '"') inStr = true; else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']'); else if (c === '}' || c === ']') stack.pop(); }
  let out = body; if (inStr) out += '"'; out = out.replace(/,\s*$/, '').replace(/,\s*"[^"]*"\s*:?\s*$/, ''); while (stack.length) out += stack.pop(); out = out.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(out); } catch { return null; }
}

const str = (v) => (typeof v === 'string' ? v.trim() : (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : ''));

// Merge the model's JSON into a valid schema note, preserving metadata/specialty.
function buildNote(currentNote, parsed) {
  const n = emptyNote({ specialty: currentNote.specialty, noteType: currentNote.note_type });
  n.metadata = currentNote.metadata || n.metadata;
  const sub = parsed.subjective || {};
  for (const k of Object.keys(n.subjective)) n.subjective[k] = str(sub[k]);
  const pmh = parsed.past_medical_history || {};
  for (const k of Object.keys(n.past_medical_history)) n.past_medical_history[k] = str(pmh[k]);
  const obj = parsed.objective || {};
  for (const k of Object.keys(n.objective)) n.objective[k] = str(obj[k]);
  const ap = Array.isArray(parsed.assessment_and_plan) ? parsed.assessment_and_plan : [];
  n.assessment_and_plan = ap.filter((p) => p && (str(p.issue) || str(p.diagnosis) || str(p.assessment) || str(p.treatment_planned))).map((p) => ({
    issue: str(p.issue), diagnosis: str(p.diagnosis), assessment: str(p.assessment),
    differential_diagnoses: Array.isArray(p.differential_diagnoses) ? p.differential_diagnoses.filter((x) => typeof x === 'string') : [],
    investigations_planned: str(p.investigations_planned), treatment_planned: str(p.treatment_planned), referrals: str(p.referrals),
  }));
  return n;
}

/** Non-empty-ish check so we never replace a good note with a hollow one. */
function looksPopulated(n) {
  const anySub = Object.values(n.subjective || {}).some((v) => String(v).trim());
  return anySub || (n.assessment_and_plan || []).length > 0;
}

export async function tightenNote(currentNote, { llm, transcript = '', log = () => {}, maxOutputTokens, missingFacts = [], medications = [] } = {}) {
  if (!llm || !transcript.trim() || !currentNote) return currentNote;
  try {
    const draft = noteToMarkdown(currentNote);
    // MEDICATION MUST-INCLUDE — the extractor's grounded drug list. Every one that the transcript
    // supports must appear in the note with its exact name/dose (never generalized to "a medication"
    // or dropped). GROUNDING (rule 1) still governs — an item not in the transcript is ignored.
    const meds = (medications || []).filter((m) => typeof m === 'string' && m.trim()).slice(0, 30);
    const medBlock = meds.length
      ? `\n\nMEDICATIONS DETECTED IN THIS ENCOUNTER — every one below is from the transcript. Ensure EACH appears in the note by its EXACT name and dose (in Assessment & Plan or the medication list); never generalize a named drug to "a medication"/"current medication", and never drop one:\n- ${meds.join('\n- ')}`
      : '';
    // The QA validator already identified extracted facts the slot-filler dropped. Give the
    // tightener that checklist — but GROUNDING (rule 1) still governs, so it only re-includes
    // items it can verify in the transcript; anything unsupported is ignored, never fabricated.
    const mf = (missingFacts || []).filter((f) => typeof f === 'string' && f.trim()).slice(0, 20);
    const mfBlock = mf.length
      ? `\n\nMISSING FACTS CHECKLIST — the QA validator flagged these as dropped from the draft. Add each one that is SUPPORTED by the transcript to its correct section (verbatim specifics: drug names, doses, lot numbers, imaging findings, referral names, follow-up intervals). If a checklist item is NOT in the transcript, ignore it — never fabricate:\n- ${mf.join('\n- ')}`
      : '';
    const user = `TRANSCRIPT (sole source of truth):\n"""\n${transcript}\n"""\n\nDRAFT NOTE (fix omissions, remove unsupported/filler content, keep only transcript-grounded facts):\n${draft}${mfBlock}${medBlock}\n\nReturn ONLY the corrected JSON.`;
    if (mf.length) log(`[upgrade:tightener] re-including ${mf.length} QA-flagged dropped fact(s)`);
    if (meds.length) log(`[upgrade:tightener] enforcing ${meds.length} grounded medication(s) present`);
    llm._agent = 'tightener';
    const raw = await llm.generateContent(SYS, user, null, { maxOutputTokens: maxOutputTokens || 16384, thinkingBudget: 0 });
    const parsed = safeParse(raw);
    if (!parsed || typeof parsed !== 'object') { log('[upgrade:tightener] no valid JSON returned — keeping draft'); return currentNote; }
    const out = buildNote(currentNote, parsed);
    if (!looksPopulated(out)) { log('[upgrade:tightener] result was empty — keeping draft'); return currentNote; }
    out.specialty = currentNote.specialty; out.metadata = currentNote.metadata;
    log('[upgrade:tightener] rewrote note gold-style (grounded, complete, concise)');
    return out;
  } catch (e) { log('[upgrade:tightener] skipped: ' + e.message); return currentNote; }
}

export { buildNote as _buildNote, safeParse as _safeParse };
