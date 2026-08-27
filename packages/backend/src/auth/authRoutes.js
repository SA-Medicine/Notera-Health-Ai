// ─────────────────────────────────────────────────────────────────────────────
// Notera — authentication routes + middleware (self-hosted email/password).
//   POST /api/auth/login          { email, password }        → sets session cookie
//   POST /api/auth/logout                                    → clears cookie
//   GET  /api/auth/me                                        → current user
//   POST /api/auth/users          (admin) { email,password,fullName,role }
//   POST /api/auth/request-reset  { email }                  → emails a reset link
//   POST /api/auth/reset          { token, password }        → sets new password
//
//   requireAuth(dataDir)  → 401 unless a valid session cookie is present
//   requireRole(role)     → 403 unless req.user.role matches (admin always allowed)
//
// Reuses the existing HMAC session (admin/session.js) — cookie is HttpOnly, signed,
// and (in production) Secure. Mount with mountAuth(app, DATA_DIR).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import express from 'express';
import crypto from 'node:crypto';
import { makeSession } from '../admin/session.js';
import { createUser, verifyLogin, setPassword, findByEmail, audit } from './users.js';
import { query, one } from '../db/pool.js';
import { sendMail } from './mailer.js';

const PROD = process.env.NODE_ENV === 'production';
const APP_URL = process.env.APP_URL || 'https://app.notera.health';

function cookieFrom(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}
// In production force Secure + SameSite=None-safe cookie (works first-party through the Vercel proxy).
const withSecure = (c) => (PROD ? c + '; Secure' : c);

export function requireAuth(dataDir) {
  const S = makeSession(dataDir);
  return (req, res, next) => {
    const p = S.verify(cookieFrom(req, S.COOKIE));
    if (!p || !p.uid) return res.status(401).json({ error: 'unauthenticated' });
    req.user = { id: p.uid, email: p.email, role: p.role || 'clinician' };
    next();
  };
}

export function requireRole(role) {
  return (req, res, next) =>
    (req.user && (req.user.role === role || req.user.role === 'admin'))
      ? next() : res.status(403).json({ error: 'forbidden' });
}

export function mountAuth(app, dataDir) {
  const S = makeSession(dataDir);
  const json = express.json({ limit: '256kb' });

  app.post('/api/auth/login', json, async (req, res) => {
    try {
      const { email, password } = req.body || {};
      let user;
      try { user = await verifyLogin(email, password); }
      catch (e) { if (e.code === 'locked') return res.status(423).json({ error: e.message }); throw e; }
      if (!user) { await audit(null, 'login_failed', { email }, req.ip); return res.status(401).json({ error: 'invalid credentials' }); }
      await audit(user.id, 'login', null, req.ip);
      res.setHeader('Set-Cookie', withSecure(S.cookie(S.issue(user))));
      res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role, fullName: user.fullName } });
    } catch (e) { res.status(500).json({ error: 'login failed' }); }
  });

  app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', withSecure(S.clearCookie()));
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const p = S.verify(cookieFrom(req, S.COOKIE));
    if (!p || !p.uid) return res.status(401).json({ error: 'unauthenticated' });
    // slide the cookie if it's past halfway
    if (S.needsRefresh(p)) res.setHeader('Set-Cookie', withSecure(S.cookie(S.issue({ id: p.uid, email: p.email, role: p.role }))));
    res.json({ user: { id: p.uid, email: p.email, role: p.role || 'clinician' } });
  });

  // Admin-only account creation (there is no public sign-up for a clinical system).
  app.post('/api/auth/users', requireAuth(dataDir), requireRole('admin'), json, async (req, res) => {
    try {
      const u = await createUser(req.body || {});
      await audit(req.user.id, 'user_create', { email: u.email, role: u.role }, req.ip);
      res.json(u);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Request a reset — always returns 200 (never reveal whether the email exists).
  app.post('/api/auth/request-reset', json, async (req, res) => {
    try {
      const email = String(req.body?.email || '').toLowerCase();
      const u = await findByEmail(email);
      if (u) {
        const token = crypto.randomBytes(32).toString('base64url');
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        await query(`INSERT INTO auth.password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [hash, u.id]);
        await sendMail(email, 'Reset your Notera password',
          `A password reset was requested for your Notera account.\n\nReset link (valid 1 hour):\n${APP_URL}/reset?token=${token}\n\nIf you did not request this, ignore this email.`);
        await audit(u.id, 'reset_requested', null, req.ip);
      }
    } catch (e) { console.error('[reset] ', e.message); }
    res.json({ ok: true });
  });

  // Complete a reset with a single-use token.
  app.post('/api/auth/reset', json, async (req, res) => {
    try {
      const { token, password } = req.body || {};
      if (!token) return res.status(400).json({ error: 'missing token' });
      const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
      const row = await one(`SELECT * FROM auth.password_resets WHERE token_hash=$1 AND used=false AND expires_at > now()`, [hash]);
      if (!row) return res.status(400).json({ error: 'invalid or expired token' });
      await setPassword(row.user_id, password);
      await query(`UPDATE auth.password_resets SET used=true WHERE token_hash=$1`, [hash]);
      await audit(row.user_id, 'password_reset', null, req.ip);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}
