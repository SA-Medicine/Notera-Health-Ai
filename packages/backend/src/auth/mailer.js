// ─────────────────────────────────────────────────────────────────────────────
// Notera — transactional email (password resets, invites). SMTP you control.
// NOTE: only send NON-PHI here (reset links, account notices). Never patient data.
// Requires:  npm i nodemailer   (in @notera/backend)
// If SMTP is not configured, sendMail() logs and no-ops (so dev doesn't crash).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

let _t = null;
async function transport() {
  if (_t) return _t;
  if (!process.env.SMTP_HOST) return null;
  const nodemailer = (await import('nodemailer')).default;
  _t = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return _t;
}

export async function sendMail(to, subject, text) {
  const t = await transport();
  if (!t) { console.warn(`[mailer] SMTP not configured — would send "${subject}" to ${to}`); return { ok: false, skipped: true }; }
  await t.sendMail({ from: process.env.SMTP_FROM || 'no-reply@notera.health', to, subject, text });
  return { ok: true };
}
