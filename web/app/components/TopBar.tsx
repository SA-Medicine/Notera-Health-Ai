'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from './AuthProvider';

export default function TopBar() {
  const { user, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const onLanding = pathname === '/' || pathname === '/login';

  function doSignOut() {
    setMenu(false);
    signOut();
    router.replace('/');
  }

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href={user ? '/app' : '/'} className="brand">
          <span className="brand-mark">N</span>
          <span className="brand-name">Notera<span className="brand-dim">-Health-Ai</span></span>
        </Link>

        {user ? (
          <>
            <nav className="nav">
              <Link href="/">Home</Link>
              <Link href="/app">New consult</Link>
              <Link href="/consults">History</Link>
              <Link href="/login">Login</Link>
            </nav>
            <div className="userchip" style={{ marginLeft: 'auto', position: 'relative' }}>
              <span className="env-pill" style={{ marginLeft: 0 }}>draft only · you sign</span>
              <button className="avatar" onClick={() => setMenu((m) => !m)} title={user.email} style={{ border: 0, cursor: 'pointer' }}>
                {user.name.slice(0, 1).toUpperCase()}
              </button>
              {menu && (
                <div className="card" style={{ position: 'absolute', right: 0, top: 40, padding: 12, minWidth: 190, zIndex: 30 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{user.name}</div>
                  <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>{user.email}</div>
                  <button className="btn ghost sm" style={{ width: '100%' }} onClick={doSignOut}>Sign out</button>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <nav className="nav">
              <Link href="/">Home</Link>
              <a href="/#features">Features</a>
              <a href="/#how">How it works</a>
              <Link href="/login">Login</Link>
            </nav>
            <Link href="/login" className="btn sm" style={{ marginLeft: 'auto' }}>Sign in</Link>
          </>
        )}
      </div>
    </header>
  );
}
