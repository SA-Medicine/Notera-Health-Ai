// Product-side window into the Style Interview (Notera Studio). READ-ONLY: it tells the signed-in clinician whether she has been invited to the
// interview and how far she is, so the main Notera app can show a banner and a menu link that open Studio. It never writes anything and it
// never affects note generation. If the Studio tables do not exist (or the database hiccups) the answer is simply "not invited".
'use strict';

import { query } from '../db/pool.js';

const STUDIO_URL = () => process.env.STUDIO_PUBLIC_URL || 'https://studio.aitoolsfordoctor.com';

export async function inviteStatus(userId) {
  try {
    const who = await query(`SELECT 1 AS x FROM studio.interviewees WHERE user_id = $1 AND active`, [userId]);
    if (!who.length) return { eligible: false };
    const parts = await query(`SELECT part, status FROM studio.interviews WHERE user_id = $1 ORDER BY part`, [userId]);
    const by = Object.fromEntries(parts.map((p) => [p.part, p.status]));
    const prof = await query(`SELECT status FROM studio.style_profiles WHERE user_id = $1 ORDER BY version DESC LIMIT 1`, [userId]);
    return { eligible: true, url: `${STUDIO_URL()}/#/interview`, parts: [1, 2, 3].map((n) => ({ part: n, status: by[n] || 'new' })), profile: prof[0]?.status || null };
  } catch { return { eligible: false }; }
}

export function mountStudioInvite(app, requireAuthMw) {
  app.get('/api/studio/invite', requireAuthMw, async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await inviteStatus(String(req.user.id))); });
}
