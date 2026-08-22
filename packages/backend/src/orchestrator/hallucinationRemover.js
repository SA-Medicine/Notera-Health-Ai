// ─────────────────────────────────────────────────────────────────────────────
// hallucinationRemover — final pipeline agent (runs LAST, after the note is fully
// assembled). Reuses the Second-Opinion DeepSeek engine, but instead of scoring the
// note it AUDITS it against the transcript and returns ONLY the exact spans that are
// hallucinated (unsupported by the transcript). We then DELETE those spans from the
// note deterministically — sentence-level, remove-only, never rewriting or adding.
//
// Why spans-only (not a rewritten note): the model emits a tiny list instead of the
// whole note, so a fast NON-THINKING flash call returns in a few seconds (no 60s
// timeouts), and the actual edit is deterministic/grounded (the LLM can't sneak in
// new text). Every deletion is logged + stored in metadata so it is auditable.
//
// Prompt is UI-editable in the Prompts tab (id: hallucination-remover). Gated by
// HALLUCINATION_REMOVER (default on) and requires DEEPSEEK_API_KEY.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { loadPrompt } from '../../prompts/registry.js';

// robust JSON extraction from an LLM text response (strip fences, slice to the object)
function parseJson(raw) {
  const s = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(s); } catch { /* repair */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* noop */ } }
  return null;
}

// The advanced default prompt (used if the registry has no published version yet).
export const FALLBACK_PROMPT = `You are the HALLUCINATION REMOVER — the final, uncompromising fact-checker in a clinical documentation pipeline. You receive the raw consultation TRANSCRIPT (the ONLY source of truth) and the generated SOAP NOTE (as JSON).

YOUR JOB: find every hallucination in the note and report the EXACT text spans that must be deleted. You do NOT rewrite the note — you only list what to remove.

A HALLUCINATION is anything in the note that the transcript does not support, including:
- invented or altered NAMES (clinicians, pharmacies, facilities), PHONE NUMBERS, DATES, ages;
- invented or altered NUMERIC values — doses, frequencies, lab results/units, vital signs;
- MEDICATIONS, investigations, referrals, diagnoses, or plan actions never stated;
- EXAM FINDINGS or investigation RESULTS that were not actually reported;
- pertinent NEGATIVES the patient/clinician never gave (e.g. "denies chest pain" when never discussed);
- any embellishment, inference, or clinical detail added beyond what was said.

RULES (read carefully — over-deletion is worse than under-deletion):
1. Report ONLY spans you are CONFIDENT are fabricated. If a statement IS supported by the transcript — even loosely — DO NOT report it. Never list a span you believe is grounded.
2. When in doubt, LEAVE IT IN. Borderline, ambiguous, or "probably real" content is NOT reported. Only clear, confident fabrications.
3. "text" MUST be copied VERBATIM from the note (exact characters) so it can be located. Report the smallest self-contained span (a phrase or ONE sentence), never a whole section.
4. "reason" MUST be a SHORT phrase, ≤ 12 words. Do NOT write your deliberation, do NOT weigh both sides, do NOT conclude "supported"/"not a hallucination". If your reasoning would end in "so it is supported", then simply DO NOT include the item.
5. "confident" MUST be true. If you are not confident it is fabricated, omit the item entirely.
6. Do not invent, correct, or rewrite anything — you only identify clearly fabricated text to delete.

Return ONLY this JSON object — no markdown, no commentary, no trailing text:
{
  "removed": [
    { "text": "<exact fabricated span copied verbatim from the note>", "field": "<e.g. objective.examination>", "reason": "<short: why unsupported, ≤12 words>", "confident": true }
  ]
}
If nothing is clearly fabricated, return { "removed": [] }.`;

// A "reason" that reveals the model actually thinks the span IS grounded → never delete it.
// Catches the flash model's self-contradictions ("…so this is not a hallucination", etc.).
const KEEP_REASON = /not a hallucination|is supported|supported by the transcript|will not report|not report it|so not a hallucination|so this is not|actually supported|is grounded|leave (it )?in/i;

// ── deterministic, grounded deletion of the reported spans ────────────────────
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const splitSentences = (line) => String(line).split(/(?<=[a-z0-9]{3}[.!?])\s+(?=[A-Z(])/).map((s) => s.trim()).filter(Boolean);

// every editable string field of the note, as get/set closures
function fieldRefs(note) {
  const refs = [];
  const addObj = (o) => { if (!o) return; for (const k of Object.keys(o)) if (typeof o[k] === 'string') refs.push({ obj: o, key: k }); };
  addObj(note.subjective); addObj(note.past_medical_history); addObj(note.objective);
  for (const p of (note.assessment_and_plan || [])) addObj(p);
  return refs;
}

// remove any sentence in `val` that carries the hallucinated span (normalized match)
function stripSpan(val, spanNorm) {
  if (!spanNorm || spanNorm.length < 4) return { text: val, removed: 0 };
  const out = []; let removed = 0;
  for (const line of String(val || '').split('\n')) {
    for (const s of splitSentences(line)) {
      const sn = norm(s);
      // the sentence contains the span, OR the span contains the (short) sentence
      const hit = sn.includes(spanNorm) || (sn.length >= 8 && spanNorm.includes(sn));
      if (hit) { removed++; continue; }
      out.push(s);
    }
  }
  return { text: out.join('\n'), removed };
}

function applyRemovals(note, removals, log) {
  const refs = fieldRefs(note);
  let total = 0, skipped = 0;
  const applied = [];
  for (const rm of removals) {
    const spanNorm = norm(rm && rm.text);
    if (!spanNorm) continue;
    // SAFETY GUARD: never delete a span the model itself flagged as grounded/uncertain,
    // or that it did not mark confident. This stops the observed over-deletion where the
    // reason says "…so this is not a hallucination" yet the item was still listed.
    if (rm.confident === false || KEEP_REASON.test(String(rm.reason || ''))) {
      skipped++;
      log(`[hallucination-remover]   ↩ kept (model deemed grounded/unsure): "${String(rm.text || '').slice(0, 90)}"`);
      continue;
    }
    let done = 0;
    for (const ref of refs) {
      const { text, removed } = stripSpan(ref.obj[ref.key], spanNorm);
      if (removed) { ref.obj[ref.key] = text; done += removed; }
    }
    total += done;
    if (done) applied.push(rm);
    else log(`[hallucination-remover]   (could not locate) "${String(rm.text || '').slice(0, 90)}"`);
  }
  return { total, applied, skipped };
}

/**
 * Remove hallucinations from `note` in place, grounded in `transcript`.
 * Returns { ok, removed:[...], deleted:n }. Never throws.
 */
export async function removeHallucinations(note, { transcript = '', promptContext = '', llm = null, log = () => {} } = {}) {
  // Emit the standard agent tag FIRST so Prompts→Logs captures this agent's block.
  log('[PromptAgent] hallucination-remover — final grounded hallucination-removal pass');
  if (!note || !transcript.trim()) { log('[hallucination-remover] skipped — no transcript'); return { ok: false, removed: [] }; }
  if (!llm) { log('[hallucination-remover] skipped — no LLM service'); return { ok: false, removed: [] }; }
  const system = loadPrompt('hallucination-remover', FALLBACK_PROMPT);
  const inputNote = {
    subjective: note.subjective, past_medical_history: note.past_medical_history,
    objective: note.objective, assessment_and_plan: note.assessment_and_plan,
  };
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '\n…[truncated]…' : s; };
  const user = `=== TRANSCRIPT (sole source of truth) ===\n${clip(transcript, 14000)}\n\n=== SOAP NOTE (JSON — report only CLEARLY fabricated spans to delete) ===\n${clip(JSON.stringify(inputNote), 12000)}\n\n${promptContext ? `=== GENERATION PROMPT (context only) ===\n${clip(promptContext, 2500)}\n\n` : ''}List ONLY spans you are CONFIDENT are fabricated. Return ONLY the JSON object.`;
  const maxTokens = Number(process.env.HALLUCINATION_MAX_TOKENS || 2048);
  // Runs on the MAIN-PIPELINE LLM (Gemini). Small output (a list, not the whole note) → fast.
  // Retry once on a parse failure (the model occasionally wraps the JSON in stray text).
  const call = async (sys) => { try { return parseJson(await llm.generateContent(sys, user, null, { maxOutputTokens: maxTokens })); } catch (e) { log('[hallucination-remover] LLM error — ' + e.message); return null; } };
  let data = await call(system);
  if (!data) { log('[hallucination-remover] retrying once (parse/LLM)'); data = await call(system + '\n\nIMPORTANT: return ONLY the raw JSON object, nothing else.'); }
  if (!data) { log('[hallucination-remover] skipped — no valid JSON from the LLM'); return { ok: false, removed: [] }; }
  const removals = Array.isArray(data.removed) ? data.removed.filter((x) => x && x.text) : [];
  const { total, applied, skipped } = applyRemovals(note, removals, log);
  note.metadata = note.metadata || {};
  note.metadata.hallucinations_removed = applied;
  if (applied.length) {
    log(`[hallucination-remover] deleted ${applied.length} hallucination(s) (${total} edit(s)${skipped ? `, ${skipped} kept as grounded` : ''}) · model=${llm.model || 'gemini'}`);
    for (const h of applied.slice(0, 40)) log(`[hallucination-remover]   ✂ ${h.field ? '[' + h.field + '] ' : ''}"${String(h.text || '').slice(0, 140)}"${h.reason ? ' — ' + h.reason : ''}`);
  } else log(`[hallucination-remover] no hallucinations deleted${skipped ? ` (${skipped} candidate(s) kept as grounded)` : ' — note is fully grounded'}`);
  return { ok: true, removed: applied, deleted: total };
}

export { applyRemovals as _applyRemovals, stripSpan as _stripSpan };
