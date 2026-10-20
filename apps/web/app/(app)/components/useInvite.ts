'use client';

import { useEffect, useState } from 'react';

export type Invite = { eligible: boolean; url?: string; parts?: { part: number; status: string }[]; profile?: string | null };

// One shared request per page load: the banner and the menu both read the same answer.
let pending: Promise<Invite> | null = null;
function load(): Promise<Invite> {
  if (!pending) {
    pending = fetch('/backend/api/studio/invite', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { eligible: false }))
      .catch(() => ({ eligible: false }));
  }
  return pending;
}

/** The Style Interview invitation for the signed-in account (invited accounts only; everyone else gets eligible:false). */
export function useInvite(signedIn: boolean): Invite {
  const [inv, setInv] = useState<Invite>({ eligible: false });
  useEffect(() => {
    if (!signedIn) { pending = null; setInv({ eligible: false }); return; }
    let alive = true;
    load().then((d) => { if (alive) setInv(d); });
    return () => { alive = false; };
  }, [signedIn]);
  return inv;
}

export function inviteSummary(inv: Invite): { line: string; cta: string; done: boolean } {
  const parts = inv.parts || [];
  const submitted = parts.filter((p) => p.status === 'submitted').length;
  const started = parts.some((p) => p.status !== 'new');
  if (submitted === 3 && inv.profile === 'confirmed') return { line: 'Thank you — your style interview and profile are complete.', cta: 'View my style profile', done: true };
  if (submitted === 3) return { line: 'Your style profile is ready — please read it and confirm it.', cta: 'Review my profile', done: false };
  if (!started) return { line: 'Help us write notes exactly the way you want them: take the Notera Style Interview (3 parts, saved as you go).', cta: 'Start the interview', done: false };
  return { line: `Your style interview: ${submitted} of 3 parts submitted. Pick up where you left off.`, cta: 'Continue the interview', done: false };
}
