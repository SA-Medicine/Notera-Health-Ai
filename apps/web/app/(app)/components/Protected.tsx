'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';

// Client-side route guard. Redirects to /login when signed out. (When you add
// Firebase, keep this — it just reads useAuth().)
export default function Protected({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (ready && !user) router.replace('/login');
  }, [ready, user, router]);

  if (!ready) {
    return <div className="card" style={{ maxWidth: 360, margin: '60px auto', textAlign: 'center' }}><span className="spinner" style={{ borderColor: 'rgba(31,111,235,.3)', borderTopColor: 'var(--brand)' }} /> <span className="muted">Loading…</span></div>;
  }
  if (!user) return null;
  return <>{children}</>;
}
