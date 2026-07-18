'use client';

import Protected from '../components/Protected';

// Logged-in workspace = the full DAS clinical scribe (identical to the extension
// webapp), served from /public/das and embedded full-screen behind the login guard.
export default function WorkspacePage() {
  return (
    <Protected>
      <iframe
        src="/das/webapp/index.html"
        title="Notera clinical scribe"
        style={{ position: 'fixed', top: 57, left: 0, width: '100vw', height: 'calc(100vh - 57px)', border: 0 }}
        allow="microphone; clipboard-read; clipboard-write"
      />
    </Protected>
  );
}
