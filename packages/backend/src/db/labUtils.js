// Pure helpers for the Testing Lab — no database import, so they can be unit-tested
// and reused without loading `pg`.
import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');

/** Sanitize a display name / subtitle into a stable fixture slug. */
export function slugify(s, fallback = 'patient') {
  const base = String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || fallback;
}
