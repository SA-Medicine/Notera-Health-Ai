// Admin "Review with AI" (owner, 2026-11-12). ON DEMAND ONLY: nothing here runs unless an admin presses the button for a note, so no model charge is made in the background.
//   GET  /api/console/review/:consultId   the stored review of the newest draft (no model call, free)
//   POST /api/console/review              { consultId, force? } runs ONE review (one model call) and stores it; an existing review of the same draft is returned
//                                         without a new call unless force is true. The page loops over the notes the admin selected, so each one is its own click-started call.
// The reviewer reads the transcript and the note and says what the note says, what it captured, what it missed, what it states that the recording does not support,
// what is wrong or unsafe, and how well it follows the Notera note format. It is a read-only tool built around the pipeline: it never edits a note or a prompt.
// Every run is written to the audit log (admin_ai_review). Sends transcript + note to the same Gemini project the pipeline already uses.
'use strict';

import { query, one } from '../db/pool.js';
import { createGeminiService } from '../services/LLMService.js';

export const REVIEW_SYS = `You are a careful clinical documentation reviewer. You are given the TRANSCRIPT of a clinic visit and the SOAP NOTE an AI scribe wrote from it. Review the note against the transcript. Do not write a new note. Do not compare with any other note.

The Notera note format: sections Subjective, Past Medical History, Objective, Assessment & Plan, in that order. Subjective holds what the patient reports, grouped by problem as short bullets (a bullet is at most two lines; related points are joined with semicolons; no exam findings or results in Subjective). Objective holds measured and examined findings, results and vitals. Assessment & Plan is numbered by problem, each problem with short plan lines (no repeated lines, several "Continue X" lines are joined into one). Nothing may be stated that the recording does not support; anything unclear must be marked as unclear, not guessed. Plain clinical English, no grammar errors, no chatter.

Check, in this order:
1. WHAT THE NOTE SAYS: 3 to 5 plain sentences on the visit as the note tells it.
2. CAPTURED: the important things from the transcript that the note records correctly (diagnoses, medicines and doses, tests ordered, referrals, follow-up, red flags).
3. MISSED: anything important in the transcript that the note leaves out (a medicine, a dose, an order, a referral, a decision, a declined option, a safety instruction, the follow-up time). Quote the transcript words.
4. NOT SUPPORTED: anything in the note that the transcript does not say or contradicts (invented diagnosis, wrong dose, wrong drug, wrong side, wrong number). Quote the note line and say what the transcript says.
5. PLAN QUALITY: lines under the wrong problem, duplicated or fragmentary lines, lines that are the doctor speaking to the patient, unclear or mis-heard words.
6. FORMAT: where the note departs from the Notera format above (exam findings in Subjective, repeated lines, over-long bullets, ungrouped runs, wrong section, grammar).
Be specific and brief. If a section has nothing to report, return an empty list for it. Never invent a problem to look thorough.

Return ONLY JSON:
{"verdict":"good"|"needs_work"|"unsafe","verdict_reason":"one sentence","what_it_says":"...","captured":["..."],"missed":[{"item":"...","transcript":"quote"}],"not_supported":[{"note":"quote from note","why":"..."}],"plan_quality":["..."],"format":["..."],"strengths":["..."],"summary":"2 sentences: how good is this note and what to fix first"}
"unsafe" only when a wrong or invented fact could harm the patient (wrong drug, dose, side, missed red flag); "needs_work" when something important is missed or wrong; "good" otherwise.`;

let ready = null;
const ensure = () => (ready ||= query(`CREATE TABLE IF NOT EXISTS clinical.admin_reviews (
  review_id bigserial PRIMARY KEY, consult_id text NOT NULL, draft_id text, review jsonb NOT NULL, model text, ms int, requested_by text, created_at timestamptz NOT NULL DEFAULT now())`)
  .then(() => query('CREATE INDEX IF NOT EXISTS admin_reviews_by_consult ON clinical.admin_reviews (consult_id, created_at DESC)')).catch((e) => { ready = null; throw e; }));

/** The model's text -> a clean review object (arrays are arrays, strings are strings), or null. */
export function parseReview(raw) {
  let j; try { j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => String(v ?? '').slice(0, 1500);
  return {
    verdict: ['good', 'needs_work', 'unsafe'].includes(j.verdict) ? j.verdict : 'needs_work', verdict_reason: str(j.verdict_reason), what_it_says: str(j.what_it_says),
    captured: arr(j.captured).slice(0, 30).map(str), strengths: arr(j.strengths).slice(0, 12).map(str),
    missed: arr(j.missed).slice(0, 30).map((m) => ({ item: str(m?.item ?? m), transcript: str(m?.transcript) })),
    not_supported: arr(j.not_supported).slice(0, 30).map((m) => ({ note: str(m?.note ?? m), why: str(m?.why) })),
    plan_quality: arr(j.plan_quality).slice(0, 20).map(str), format: arr(j.format).slice(0, 20).map(str), summary: str(j.summary),
  };
}

let inflight = 0;
export function mountNoteReview(R, { r, jsonBody, audit, ipOf }) {
  R.get('/review/:id', r(async (req, res) => {
    await ensure();
    const row = await one('SELECT review, model, ms, created_at, draft_id FROM clinical.admin_reviews WHERE consult_id = $1 ORDER BY created_at DESC LIMIT 1', [req.params.id]);
    res.json({ review: row?.review || null, model: row?.model || null, at: row?.created_at || null });
  }));

  R.post('/review', jsonBody, r(async (req, res) => {
    const id = String(req.body?.consultId || ''); const force = req.body?.force === true;
    if (!id) return res.status(400).json({ error: 'consultId is required' });
    await ensure();
    const c = await one(`SELECT c.consult_id, c.specialty, c.clinician_id, c.transcript->>'text' AS transcript FROM clinical.consults c WHERE c.consult_id = $1`, [id]);
    if (!c) return res.status(404).json({ error: 'not found' });
    const d = await one('SELECT draft_id, rendered_note FROM clinical.drafts WHERE consult_id = $1 ORDER BY created_at DESC LIMIT 1', [id]);
    if (!d?.rendered_note) return res.status(409).json({ error: 'this consult has no generated note yet' });
    if (!c.transcript) return res.status(409).json({ error: 'this consult has no transcript' });
    if (!force) {
      const old = await one('SELECT review, model, created_at FROM clinical.admin_reviews WHERE consult_id = $1 AND draft_id = $2 ORDER BY created_at DESC LIMIT 1', [id, d.draft_id]);
      if (old) return res.json({ review: old.review, model: old.model, at: old.created_at, cached: true });
    }
    if (inflight >= 3) return res.status(429).json({ error: 'three reviews are already running, try again in a moment' });
    inflight++; const t0 = Date.now();
    try {
      const model = process.env.REVIEW_MODEL || process.env.V2_STORY_MODEL || 'gemini-2.5-flash';
      const llm = await createGeminiService(null, { model }); llm._agent = 'admin-review';
      const user = `SPECIALTY: ${c.specialty || 'unknown'}\n\n=== TRANSCRIPT ===\n${String(c.transcript).slice(0, 60000)}\n\n=== SOAP NOTE ===\n${d.rendered_note}\n\nReturn ONLY the JSON.`;
      const raw = await llm.generateContent(REVIEW_SYS, user, null, { maxOutputTokens: 6000, temperature: 0, timeoutMs: 90000, retries: 1, hedgeMs: 0, responseMimeType: 'application/json' });
      const review = parseReview(raw); if (!review) return res.status(502).json({ error: 'the reviewer returned something unreadable, press Review again' });
      const ms = Date.now() - t0;
      await query('INSERT INTO clinical.admin_reviews (consult_id, draft_id, review, model, ms, requested_by) VALUES ($1,$2,$3::jsonb,$4,$5,$6)', [id, d.draft_id, JSON.stringify(review), model, ms, req.user.id]);
      await audit(req.user.id, 'admin_ai_review', { consultId: id, owner: c.clinician_id, model, ms }, ipOf(req));
      res.json({ review, model, ms, at: new Date().toISOString(), cached: false });
    } finally { inflight--; }
  }));
}
