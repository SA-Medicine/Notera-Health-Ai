// ─────────────────────────────────────────────────────────────────────────────
// Free-tier quota.
//   • Every existing account keeps FULL access: the new column defaults to plan='full',
//     so the migration changes nothing for users who were provisioned before sign-up opened.
//   • New self-service sign-ups are plan='free' and get FREE_NOTE_LIMIT note generations
//     (default 5). After that the note endpoints answer 402 and the app shows pricing.
//   • A "request" = one note generation. A note that FAILS is refunded.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { query, one } from '../db/pool.js';

export const FREE_NOTE_LIMIT = Number(process.env.FREE_NOTE_LIMIT || 5);

let _ready = null;
/** Additive, idempotent migration — safe to run on every start. */
export function ensureAccountSchema() {
  if (!_ready) {
    _ready = query(`
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'full';
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS free_notes_used int NOT NULL DEFAULT 0;
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS terms_version text;
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS improve_consent boolean NOT NULL DEFAULT false;
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS improve_consent_at timestamptz;
    `).then(() => console.log('[auth] account plan columns ready'))
      .catch((e) => { _ready = null; console.warn('[auth] account schema init failed:', e.message); throw e; });
  }
  return _ready;
}

const shape = (row) => {
  const plan = row?.plan || 'full';
  const used = Number(row?.free_notes_used || 0);
  const limited = plan === 'free';
  return { plan, used, limit: limited ? FREE_NOTE_LIMIT : null, remaining: limited ? Math.max(0, FREE_NOTE_LIMIT - used) : null };
};

/** { plan, used, limit, remaining } — limit/remaining are null for unlimited plans. */
export async function getAccount(userId) {
  await ensureAccountSchema();
  const row = await one(`SELECT plan, free_notes_used FROM auth.users WHERE id=$1`, [userId]);
  return shape(row);
}

/**
 * Atomically use one note. Returns the new account state, or null when a free user is out
 * of notes. Non-free plans are never counted and never blocked.
 */
export async function reserveNote(userId) {
  await ensureAccountSchema();
  const row = await one(
    `UPDATE auth.users
        SET free_notes_used = free_notes_used + CASE WHEN plan = 'free' THEN 1 ELSE 0 END
      WHERE id = $1 AND (plan <> 'free' OR free_notes_used < $2)
      RETURNING plan, free_notes_used`, [userId, FREE_NOTE_LIMIT]);
  return row ? shape(row) : null;
}

/** Give a note back (the generation failed). */
export async function refundNote(userId) {
  try { await query(`UPDATE auth.users SET free_notes_used = GREATEST(free_notes_used - 1, 0) WHERE id=$1 AND plan='free'`, [userId]); }
  catch (e) { console.warn('[quota] refund failed:', e.message); }
}

const limitBody = (acc) => ({
  error: 'free_limit_reached',
  message: `You've used your ${FREE_NOTE_LIMIT} free notes. Choose a plan to keep going.`,
  limit: acc?.limit ?? FREE_NOTE_LIMIT, used: acc?.used ?? FREE_NOTE_LIMIT, upgradeUrl: '/pricing',
});

/** Express middleware for the note routes: reserves a note or answers 402. */
export async function noteQuotaGate(req, res, next) {
  if (!req.user?.id) return next();                  // service-token / dev callers are not metered
  try {
    const acc = await reserveNote(req.user.id);
    if (!acc) return res.status(402).json(limitBody({ used: FREE_NOTE_LIMIT, limit: FREE_NOTE_LIMIT }));
    req.quota = { reserved: acc.plan === 'free', userId: req.user.id };
    next();
  } catch (e) {
    console.error('[quota] check failed — allowing request:', e.message);   // never lock out paying users on a DB hiccup
    next();
  }
}

// Free accounts also get a daily transcription allowance (20-second chunks), so an unused note
// quota can't be turned into unlimited speech-to-text. In-memory: resets on restart, which is fine.
export const FREE_ASR_CHUNKS_PER_DAY = Number(process.env.FREE_ASR_CHUNKS_PER_DAY || 450);   // ~2.5 h of audio
const _asrDay = new Map();   // userId -> { day, n }
const today = () => new Date().toISOString().slice(0, 10);

/** Express middleware for ASR: out-of-quota free users can't keep spending transcription cost. */
export async function asrQuotaGate(req, res, next) {
  if (!req.user?.id) return next();
  try {
    const acc = await getAccount(req.user.id);
    if (acc.plan === 'free') {
      if (acc.remaining <= 0) return res.status(402).json(limitBody(acc));
      const rec = _asrDay.get(req.user.id);
      const cur = rec && rec.day === today() ? rec : { day: today(), n: 0 };
      cur.n += 1; _asrDay.set(req.user.id, cur);
      if (cur.n > FREE_ASR_CHUNKS_PER_DAY) return res.status(429).json({ error: 'daily_audio_limit', message: 'Daily transcription limit reached for the free plan. Try again tomorrow or choose a plan.', upgradeUrl: '/pricing' });
      if (_asrDay.size > 5000) for (const [k, v] of _asrDay) if (v.day !== today()) _asrDay.delete(k);
    }
  } catch (e) { console.error('[quota] asr check failed — allowing:', e.message); }
  next();
}

export const refundIfReserved = (req) => (req.quota?.reserved ? refundNote(req.quota.userId) : null);

// ── consent ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Two separate things, never bundled: (1) acceptance of the Terms and Privacy Policy, required to use Notera, recorded with the version accepted;
// (2) the optional choice to let Notera use this clinician's recordings, transcripts and notes to evaluate and improve Notera itself. Default off.
export const TERMS_VERSION = '2026-10-23';

export async function getConsent(userId) {
  await ensureAccountSchema();
  const r = await one(`SELECT terms_version, terms_accepted_at, improve_consent, improve_consent_at FROM auth.users WHERE id=$1`, [userId]);
  return { current: TERMS_VERSION, termsVersion: r?.terms_version || null, termsAcceptedAt: r?.terms_accepted_at || null, improve: !!r?.improve_consent, improveAt: r?.improve_consent_at || null };
}

/** { terms: '<version>' } records acceptance of that exact version only; { improve: true|false } records the optional choice (and when). */
export async function setConsent(userId, { terms, improve } = {}) {
  await ensureAccountSchema();
  if (terms !== undefined && terms !== TERMS_VERSION) throw Object.assign(new Error('These are not the current terms. Reload the page and read them again.'), { status: 409 });
  if (terms !== undefined) await query(`UPDATE auth.users SET terms_version=$2, terms_accepted_at=now() WHERE id=$1`, [userId, terms]);
  if (typeof improve === 'boolean') await query(`UPDATE auth.users SET improve_consent=$2, improve_consent_at=now() WHERE id=$1`, [userId, improve]);
  return getConsent(userId);
}
