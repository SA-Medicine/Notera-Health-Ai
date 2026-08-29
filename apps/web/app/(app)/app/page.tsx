'use client';

import Protected from '../components/Protected';
import Scribe from './Scribe';

// Logged-in workspace = the Notera clinical scribe (React/Tailwind), behind the login guard.
export default function WorkspacePage() {
  return (
    <Protected>
      <Scribe />
    </Protected>
  );
}
