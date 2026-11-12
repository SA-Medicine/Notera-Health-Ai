// Stuck consults (owner, 2026-11-12). A recovered or interrupted recording can leave a consult in 'processing' for ever (found: four, the oldest 15 days, one of them a "Recovered recording"
// whose upload never finished transcribing). Every 15 minutes any consult still 'processing' after 60 minutes is closed: 'ready' if it already has a written note, otherwise 'error',
// so the clinician's list and the admin list never show a spinner that will not finish. No note, transcript or audio is touched, only the status word. STUCK_SWEEP=0 switches it off.
'use strict';

import { query } from '../db/pool.js';

export const STUCK_AFTER_MIN = 60;

/** @returns {Promise<{id: string, status: string}[]>} the consults that were closed */
export async function sweepStuckConsults({ afterMin = STUCK_AFTER_MIN, run = query } = {}) {
  const rows = await run(
    `UPDATE clinical.consults c
        SET status = (CASE WHEN EXISTS (SELECT 1 FROM clinical.drafts d WHERE d.consult_id = c.consult_id AND COALESCE(d.rendered_note, '') <> '') THEN 'ready' ELSE 'error' END)::clinical.consult_status
      WHERE c.status = 'processing' AND c.created_at < now() - make_interval(mins => $1::int)
      RETURNING c.consult_id AS id, c.status::text AS status`, [afterMin]);
  return rows.map((r) => ({ id: r.id, status: r.status }));
}

let timer = null;
export function startStuckSweeper({ everyMin = 15, run = query } = {}) {
  if (timer || process.env.STUCK_SWEEP === '0') return;
  const tick = async () => {
    try { const done = await sweepStuckConsults({ run }); if (done.length) console.log(`[ops] closed ${done.length} stuck consult(s): ${done.map((d) => `${d.id}=${d.status}`).join(', ')}`); }
    catch (e) { console.warn('[ops] stuck-consult sweep skipped:', e.message); }
  };
  setTimeout(tick, 60_000).unref?.();
  timer = setInterval(tick, everyMin * 60_000); timer.unref?.();
}
