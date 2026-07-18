'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Auth context — MOCK for now (persists to localStorage), Firebase-ready.
//
// You said you'll add Firebase after. To switch: install `firebase`, create
// web/app/lib/firebaseClient.ts, and replace the three mock functions below with
// Firebase Auth calls (signInWithEmailAndPassword / createUserWithEmailAndPassword
// / signInWithPopup(GoogleAuthProvider) / signOut) and subscribe to
// onAuthStateChanged. The rest of the app (useAuth, <Protected/>, TopBar) needs
// no changes — it only depends on { user, signIn, signUp, signInWithGoogle, signOut }.
// ─────────────────────────────────────────────────────────────────────────────
import { createContext, useContext, useEffect, useState, useCallback } from 'react';

export type User = { uid: string; email: string; name: string } | null;

type AuthCtx = {
  user: User;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => void;
};

const Ctx = createContext<AuthCtx | null>(null);
const KEY = 'notera_user';

function nameFromEmail(email: string) {
  const h = email.split('@')[0].replace(/[._-]+/g, ' ');
  return h.replace(/\b\w/g, (c) => c.toUpperCase()) || 'Clinician';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setUser(JSON.parse(raw));
    } catch { /* ignore */ }
    setReady(true);
  }, []);

  const persist = useCallback((u: User) => {
    setUser(u);
    try { u ? localStorage.setItem(KEY, JSON.stringify(u)) : localStorage.removeItem(KEY); } catch { /* ignore */ }
  }, []);

  // ── MOCK implementations (swap for Firebase later) ──────────────────────────
  const signIn = useCallback(async (email: string, _password: string) => {
    await new Promise((r) => setTimeout(r, 450)); // simulate latency
    persist({ uid: 'demo-' + btoa(email).slice(0, 8), email, name: nameFromEmail(email) });
  }, [persist]);

  const signUp = useCallback(async (name: string, email: string, _password: string) => {
    await new Promise((r) => setTimeout(r, 550));
    persist({ uid: 'demo-' + btoa(email).slice(0, 8), email, name: name || nameFromEmail(email) });
  }, [persist]);

  const signInWithGoogle = useCallback(async () => {
    await new Promise((r) => setTimeout(r, 500));
    persist({ uid: 'google-demo', email: 'clinician@gmail.com', name: 'Demo Clinician' });
  }, [persist]);

  const signOut = useCallback(() => persist(null), [persist]);

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
