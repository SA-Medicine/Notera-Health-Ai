// ─────────────────────────────────────────────────────────────────────────────
// Admin session — stateless, HMAC-signed cookie (industry-standard "remember me").
//
// Why not an in-memory Set: `node --watch` restarts on every code edit (and crashes/
// deploys) wipe in-process state, which silently logs the admin out — and mid-run, a
// 150-patient scan would lose its session. A signed cookie needs no server-side store,
// so it survives restarts. The signing secret is persisted once to disk so tokens stay
// valid across restarts (override with ADMIN_SESSION_SECRET in prod).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const COOKIE = 'notera_admin';
const TTL_DAYS = Number(process.env.ADMIN_SESSION_TTL_DAYS || 30);
const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url').toString('utf8');

function resolveSecret(dataDir) {
  if (process.env.ADMIN_SESSION_SECRET) return process.env.ADMIN_SESSION_SECRET;
  const fp = path.join(dataDir, '.session_secret');
  try { const s = fs.readFileSync(fp, 'utf8').trim(); if (s) return s; } catch { /* create below */ }
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(fp, s, { mode: 0o600 }); } catch { /* fall back to in-memory */ }
  return s;
}

export function makeSession(dataDir) {
  const key = resolveSecret(dataDir);
  const sign = (data) => crypto.createHmac('sha256', key).update(data).digest('base64url');
  return {
    COOKIE,
    /** Issue a signed token valid for `ttlMs` (default TTL_DAYS). */
    issue(ttlMs = TTL_DAYS * 86400000) {
      const payload = b64(JSON.stringify({ exp: Date.now() + ttlMs, iat: Date.now(), v: 1 }));
      return `${payload}.${sign(payload)}`;
    },
    /** Verify signature + expiry. Returns the payload or null. Never throws. */
    verify(tok) {
      if (!tok || typeof tok !== 'string' || tok.indexOf('.') < 0) return null;
      const i = tok.lastIndexOf('.');
      const payload = tok.slice(0, i), sig = tok.slice(i + 1);
      const expected = sign(payload);
      if (sig.length !== expected.length) return null;
      try { if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; } catch { return null; }
      try { const p = JSON.parse(unb64(payload)); if (p && p.exp > Date.now()) return p; } catch { /* bad payload */ }
      return null;
    },
    /** Should the cookie be refreshed (sliding expiry)? True once past the halfway mark. */
    needsRefresh(payload) { return !!payload && typeof payload.exp === 'number' && (payload.exp - Date.now()) < (TTL_DAYS * 86400000) / 2; },
    cookie(tok, maxAgeSec = TTL_DAYS * 86400) { return `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`; },
    clearCookie() { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`; },
  };
}
