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

      <button className="oauth" onClick={google} disabled={busy} type="button">
        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.4 5.4 2.5 13.3l7.9 6.1C12.2 13.2 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 2.9-2.2 5.4-4.7 7l7.3 5.7c4.3-3.9 6.9-9.8 6.9-17.2z"/><path fill="#FBBC05" d="M10.4 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.5 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.3-5.7c-2 1.4-4.7 2.3-7.9 2.3-6.4 0-11.8-3.7-13.6-9.1l-7.9 6.1C6.4 42.6 14.6 48 24 48z"/></svg>
        Continue with Google
      </button>

      <div className="divider">or</div>

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

      <div className="auth-alt">
        {mode === 'in' ? (
          <>New to Notera? <button className="link-btn" onClick={() => setMode('up')}>Create an account</button></>
        ) : (
          <>Already have an account? <button className="link-btn" onClick={() => setMode('in')}>Sign in</button></>
        )}
      </div>

      <div className="note-demo">Demo mode — any email + password signs you in. Firebase Auth drops in later with no UI changes.</div>
    </div>
  );
}
