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
    // Same dark-sidebar silhouette as the app, so a reload never flashes the site chrome or a half-screen card.
    return (
      <div className="app-splash" role="status" aria-label="Loading Notera">
        <aside><div className="sp-brand"><i /><b /></div><span className="sp-bar w1" /><span className="sp-bar w2" /><span className="sp-bar w3" /></aside>
        <main><div className="sp-top"><span className="sp-bar w4" /><span className="sp-pill" /></div><div className="sp-card"><span className="sp-bar w5" /><span className="sp-bar w6" /><span className="sp-bar w7" /></div></main>
        <div className="sp-center"><span className="sp-ring" /></div>
      </div>
    );
  }
  if (!user) return null;
  return <>{children}</>;
}
