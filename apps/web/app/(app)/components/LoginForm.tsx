'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';

export default function LoginForm() {
  const { user, ready, signIn, signUp, signInWithGoogle } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (ready && user) router.replace('/app'); }, [ready, user, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      if (mode === 'in') await signIn(email, password);
      else await signUp(name, email, password);
      router.replace('/app');
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  async function google() {
    setError(''); setBusy(true);
    try { await signInWithGoogle(); router.replace('/app'); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="auth-card">
      <h1>{mode === 'in' ? 'Welcome back' : 'Create your account'}</h1>
      <p className="sub">{mode === 'in' ? 'Sign in to draft and review clinical notes.' : 'Start drafting schema-structured notes in seconds.'}</p>

      <form onSubmit={submit}>
        {mode === 'up' && (
          <>
            <label htmlFor="name">Full name</label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Dr. Alex Rivera" autoComplete="name" />
          </>
        )}
        <label htmlFor="email">Work email</label>
        <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@clinic.org" autoComplete="email" />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} />

        {error && <div className="flag critical" style={{ marginTop: 14 }}><span className="dot" />{error}</div>}

        <button className="btn lg" type="submit" disabled={busy} style={{ width: '100%', marginTop: 18 }}>
          {busy ? <><span className="spinner" /> {mode === 'in' ? 'Signing in…' : 'Creating…'}</> : (mode === 'in' ? 'Sign in' : 'Create account')}
        </button>
      </form>

      <div className="note-demo">Accounts are provisioned by your administrator. Contact them if you need access.</div>
    </div>
  );
}
