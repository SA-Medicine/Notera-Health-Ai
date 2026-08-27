-- ─────────────────────────────────────────────────────────────────────────────
-- Notera — self-hosted authentication schema (email + password).
--   run once:  psql "$DATABASE_URL" -f db/schema.auth.sql
-- Extensions: citext (case-insensitive email), pgcrypto (gen_random_uuid).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS auth;

-- Clinician / admin accounts. Passwords are bcrypt hashes — never plaintext.
CREATE TABLE IF NOT EXISTS auth.users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext UNIQUE NOT NULL,
  password_hash  text   NOT NULL,
  full_name      text,
  role           text   NOT NULL DEFAULT 'clinician',   -- 'clinician' | 'admin'
  is_active      boolean NOT NULL DEFAULT true,
  failed_logins  int    NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Single-use password-reset tokens (we store only the SHA-256 hash of the token).
CREATE TABLE IF NOT EXISTS auth.password_resets (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- HIPAA audit trail: who did what, when, from where.
CREATE TABLE IF NOT EXISTS auth.audit_log (
  id       bigserial PRIMARY KEY,
  user_id  uuid,
  action   text NOT NULL,                 -- login, login_failed, logout, note_create, note_view, ...
  detail   jsonb,
  ip       inet,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_user_at ON auth.audit_log (user_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_at ON auth.audit_log (action, at DESC);
