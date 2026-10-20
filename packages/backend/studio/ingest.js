// Ingest: notes the reviewer accounts create in the product appear in their Studio queue, with the Style Spec check done at once and the
// LLM review (judge + evidence map) done in the background. READ-ONLY on the product tables (clinical.*): Studio writes only to schema "studio".
// Also detects the doctor's own edits made in the product (draft -> final) and turns them into proposals.
'use strict';

import { query, one, audit } from './db.js';
import { conformance } from './conformance.js';
import { evaluateNote } from './evaluator.js';
import { mapEvidence } from './evidence.js';
import { diffRendered, inferPreferences } from './editLearning.js';
import { noteToMarkdown } from '../src/orchestrator/renderMarkdown.js';

export async function reviewerIds() { return (await query(`SELECT user_id FROM studio.reviewers WHERE active`)).map((r) => r.user_id); }

export async function seedReviewers() {
  const names = String(process.env.STUDIO_REVIEWER_NAMES || '').split(',').map((x) => x.trim()).filter(Boolean);
  const ids = String(process.env.STUDIO_REVIEWER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const n of names) {
    const u = await one(`SELECT id::text AS id, full_name FROM auth.users WHERE full_name ILIKE $1 AND is_active ORDER BY created_at LIMIT 1`, [n]).catch(() => null);
    if (u) await query(`INSERT INTO studio.reviewers (user_id, full_name, added_by) VALUES ($1, $2, 'env') ON CONFLICT (user_id) DO NOTHING`, [u.id, u.full_name]);
  }
  for (const id of ids) await query(`INSERT INTO studio.reviewers (user_id, full_name, added_by) VALUES ($1, $2, 'env') ON CONFLICT (user_id) DO NOTHING`, [id, '']);
}

/** Pull new drafts of reviewer accounts into the queue. Returns how many were added. */
export async function pollOnce() {
  const ids = await reviewerIds(); if (!ids.length) return 0;
  const rows = await query(`
    SELECT DISTINCT ON (d.consult_id) d.draft_id, d.consult_id, c.clinician_id, c.title, c.transcript->>'text' AS transcript, d.note, d.rendered_note, d.created_at
    FROM clinical.drafts d JOIN clinical.consults c ON c.consult_id = d.consult_id
    WHERE c.clinician_id = ANY($1::text[]) AND d.created_at > now() - interval '90 days' AND coalesce(d.rendered_note, '') <> ''
    ORDER BY d.consult_id, d.created_at DESC`, [ids]);
  let added = 0;
  for (const r of rows) {
    if (!r.transcript || r.transcript.length < 50) continue;
    const conf = conformance(r.rendered_note);
    const res = await query(`
      INSERT INTO studio.review_items (consult_id, draft_id, clinician_id, assigned_to, source, title, transcript, note, rendered, created_at, conformance)
      VALUES ($1, $2, $3, $3, 'app', $4, $5, $6::jsonb, $7, $8, $9::jsonb)
      ON CONFLICT (consult_id) DO UPDATE SET draft_id = EXCLUDED.draft_id, transcript = EXCLUDED.transcript, note = EXCLUDED.note, rendered = EXCLUDED.rendered,
        conformance = EXCLUDED.conformance, auto_eval = NULL, evidence = NULL, evaluated_at = NULL
      WHERE studio.review_items.status = 'new' AND studio.review_items.draft_id IS DISTINCT FROM EXCLUDED.draft_id
      RETURNING id`, [r.consult_id, r.draft_id, r.clinician_id, r.title || '', r.transcript, JSON.stringify(r.note || {}), r.rendered_note, r.created_at, JSON.stringify(conf)]);
    if (res.length) added++;
  }
  return added;
}

/** Items still without an automatic review: judge + evidence map (one at a time, so cost and load stay small). */
export async function processPending({ evaluate = evaluateNote, evidence = mapEvidence, max = 2 } = {}) {
  const items = await query(`SELECT id, transcript, rendered FROM studio.review_items WHERE evaluated_at IS NULL ORDER BY queued_at LIMIT $1`, [max]);
  for (const it of items) {
    let auto = null, ev = null;
    try { auto = await evaluate({ transcript: it.transcript, rendered: it.rendered }); } catch (e) { auto = { error: String(e.message).slice(0, 200) }; }
    try { ev = await evidence({ transcript: it.transcript, rendered: it.rendered }); } catch (e) { ev = { error: String(e.message).slice(0, 200) }; }
    await query(`UPDATE studio.review_items SET auto_eval = $2::jsonb, evidence = $3::jsonb, evaluated_at = now() WHERE id = $1`, [it.id, JSON.stringify(auto), JSON.stringify(ev)]);
  }
  return items.length;
}

/** The reviewer edited and approved a note inside the product: compare draft and final, store the diff, propose style rules. */
export async function captureFinals({ infer = inferPreferences } = {}) {
  const rows = await query(`
    SELECT i.id, i.rendered, f.note AS final_note, f.final_id
    FROM studio.review_items i JOIN clinical.finals f ON f.consult_id = i.consult_id
    WHERE i.app_edit IS NULL AND f.status = 'APPROVED' ORDER BY f.created_at DESC LIMIT 20`).catch(() => []);
  let n = 0;
  for (const r of rows) {
    let finalText = ''; try { finalText = noteToMarkdown(r.final_note); } catch { /* unrenderable final */ }
    if (!finalText) continue;
    const diff = diffRendered(r.rendered, finalText);
    await query(`UPDATE studio.review_items SET app_edit = $2::jsonb WHERE id = $1`, [r.id, JSON.stringify({ final_id: r.final_id, ...diff })]);
    if (diff.edit_rate > 0) {
      try {
        const props = await infer({ diff });
        for (const p of props) await query(`INSERT INTO studio.proposals (source, item_id, section, title, detail, change) VALUES ('app-edit', $1, $2, $3, $4, $5::jsonb)`, [r.id, p.section, p.title, p.because, JSON.stringify(p)]);
      } catch { /* proposals are best-effort */ }
    }
    n++;
  }
  if (n) await audit('system', 'app_edits_captured', { n });
  return n;
}
