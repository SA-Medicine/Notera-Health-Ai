// ─────────────────────────────────────────────────────────────────────────────
// Notera — user store for self-hosted email/password auth.
//   • bcrypt password hashing (never store plaintext)
//   • account lockout after repeated failures
//   • audit logging for HIPAA
// Requires:  npm i bcrypt   (in @notera/backend)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import bcrypt from 'bcrypt';
import { query, one } from '../db/pool.js';

const ROUNDS = 12;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const MIN_PASSWORD = 12;

const emailOk = (e) => /^\S+@\S+\.\S+$/.test(String(e || ''));

/** Create a user. Admin-only in the API. Returns { id, email, role }. */
export async function createUser({ email, password, fullName, role = 'clinician' }) {
  if (!emailOk(email)) throw new Error('invalid email');
  if (String(password || '').length < MIN_PASSWORD) throw new Error(`password must be ≥ ${MIN_PASSWORD} characters`);
  if (!['clinician', 'admin'].includes(role)) throw new Error('invalid role');
  const hash = await bcrypt.hash(password, ROUNDS);
  const rows = await query(
    `INSERT INTO auth.users (email, password_hash, full_name, role)
     VALUES ($1,$2,$3,$4) RETURNING id, email, role`,
    [String(email).toLowerCase(), hash, fullName || null, role]);
  return rows[0];
}

/**
 * Verify credentials. Returns { id, email, role, fullName } or null.
 * Throws { code: 'locked' } if the account is temporarily locked.
 */
export async function verifyLogin(email, password) {
  const u = await one(`SELECT * FROM auth.users WHERE email=$1 AND is_active=true`, [String(email || '').toLowerCase()]);
  if (!u) {
    // Constant-time-ish: still run a bcrypt compare so timing doesn't reveal "no such user".
    await bcrypt.compare(String(password || ''), '$2b$12$0000000000000000000000000000000000000000000000000000');
    return null;
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) { const e = new Error('account locked — try again later'); e.code = 'locked'; throw e; }
  const ok = await bcrypt.compare(String(password || ''), u.password_hash);
  if (!ok) {
    const fails = u.failed_logins + 1;
    if (fails >= MAX_FAILS) {
      await query(`UPDATE auth.users SET failed_logins=$1, locked_until = now() + ($2 || ' minutes')::interval WHERE id=$3`,
        [fails, String(LOCK_MINUTES), u.id]);
    } else {
      await query(`UPDATE auth.users SET failed_logins=$1 WHERE id=$2`, [fails, u.id]);
    }
    return null;
  }
  await query(`UPDATE auth.users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [u.id]);
  return { id: u.id, email: u.email, role: u.role, fullName: u.full_name };
}

/** Set a new password for a user (used by the reset flow). */
export async function setPassword(userId, newPassword) {
  if (String(newPassword || '').length < MIN_PASSWORD) throw new Error(`password must be ≥ ${MIN_PASSWORD} characters`);
  const hash = await bcrypt.hash(newPassword, ROUNDS);
  await query(`UPDATE auth.users SET password_hash=$1, failed_logins=0, locked_until=NULL WHERE id=$2`, [hash, userId]);
}

export async function findByEmail(email) {
  return one(`SELECT id, email, role, full_name FROM auth.users WHERE email=$1`, [String(email || '').toLowerCase()]);
}

/** Append an audit row. Never throws (audit failure must not break the request). */
export async function audit(userId, action, detail, ip) {
  try {
    await query(`INSERT INTO auth.audit_log (user_id, action, detail, ip) VALUES ($1,$2,$3,$4)`,
      [userId || null, action, detail ? JSON.stringify(detail) : null, ip || null]);
  } catch (e) { console.error('[audit] failed:', e.message); }
}
