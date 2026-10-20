'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from './AuthProvider';
import { useInvite, inviteSummary } from './useInvite';

// A quiet banner for accounts invited to the Notera Style Interview. It opens Notera Studio (sign in there with the same account).
// Shown on the history page (the workspace shows its own copy inside the sidebar layout), hidden once the profile is confirmed, and dismissible for the rest of the browser session.
export default function InterviewInvite() {
  const { user } = useAuth();
  const pathname = usePathname();
  const inv = useInvite(!!user);
  const [hidden, setHidden] = useState(false);
  useEffect(() => { try { setHidden(sessionStorage.getItem('interviewBannerHidden') === '1'); } catch { /* storage unavailable */ } }, []);
  if (!user || !inv.eligible || hidden || pathname !== '/consults') return null;
  const s = inviteSummary(inv);
  if (s.done) return null;
  return (
    <div className="invite-banner" role="note">
      <span className="invite-text"><b>Style interview.</b> {s.line}</span>
      <a className="btn sm" href={inv.url} target="_blank" rel="noopener noreferrer">{s.cta}</a>
      <button className="invite-x" aria-label="Hide for now" onClick={() => { setHidden(true); try { sessionStorage.setItem('interviewBannerHidden', '1'); } catch { /* ignore */ } }}>×</button>
    </div>
  );
}
