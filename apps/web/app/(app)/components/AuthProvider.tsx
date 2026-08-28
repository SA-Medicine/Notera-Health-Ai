'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Auth context — REAL email/password auth against the Notera backend.
//   POST /backend/api/auth/login  → sets an HttpOnly session cookie (first-party
//        via the /backend/* proxy) and returns the user.
//   GET  /backend/api/auth/me     → restores the session on page load.
//   POST /backend/api/auth/logout → clears the cookie.
// There is NO public sign-up for a clinical system — accounts are created by an
// admin (POST /api/auth/users). signUp / Google are intentionally disabled.
// ─────────────────────────────────────────────────────────────────────────────
import { createContext, useContext, useEffect, useState, useCallback } from 'react';

export type User = { uid: string; email: string; name: string; role?: string } | null;

type AuthCtx = {
  user: User;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => void;
};

const Ctx = createContext<AuthCtx | null>(null);

// All auth calls go through the same-origin /backend proxy so cookies stay first-party.
const AUTH = '/backend/api/auth';
const nameFromEmail = (email: string) =>
  (email.split('@')[0] || 'Clinician').replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const toUser = (u: any): User =>
  u ? { uid: u.id || u.uid || u.email, email: u.email, name: u.fullName || u.name || nameFromEmail(u.email), role: u.role } : null;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User>(null);
  const [ready, setReady] = useState(false);

  // Restore the session from the cookie on first load.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${AUTH}/me`, { credentials: 'include', cache: 'no-store' });
        if (alive && r.ok) { const d = await r.json(); setUser(toUser(d.user)); }
      } catch { /* not logged in */ }
      finally { if (alive) setReady(true); }
    })();
    return () => { alive = false; };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await fetch(`${AUTH}/login`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || (r.status === 423 ? 'Account locked — try again later.' : 'Invalid email or password.'));
    setUser(toUser(d.user));
  }, []);

  const signUp = useCallback(async () => {
    throw new Error('Accounts are created by your administrator. Please contact them for access.');
  }, []);

  const signInWithGoogle = useCallback(async () => {
    throw new Error('Google sign-in is not enabled. Use your email and password.');
  }, []);

  const signOut = useCallback(() => {
    fetch(`${AUTH}/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
    setUser(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, ready, signIn, signUp, signInWithGoogle, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used within AuthProvider');
  return c;
}
