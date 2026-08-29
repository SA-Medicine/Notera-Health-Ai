'use client';

import Protected from '../components/Protected';

// Logged-in workspace = the full Notera clinical scribe, served from
// /public/notera and embedded full-screen behind the login guard.
export default function WorkspacePage() {
  return (
    <Protected>
      <iframe
        src="/notera/webapp/index.html"
        title="Notera clinical scribe"
        style={{ position: 'fixed', top: 57, left: 0, width: '100vw', height: 'calc(100vh - 57px)', border: 0 }}
        allow="microphone; clipboard-read; clipboard-write"
      />
    </Protected>
  );
}
