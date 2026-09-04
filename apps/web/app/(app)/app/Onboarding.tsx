'use client'

import { useCallback, useEffect, useState } from 'react'

/* First-login onboarding: a Terms & Conditions accept step, then a few plain-language
   coach-marks over the key buttons so a non-technical clinician can get going immediately.
   Shown once — a flag is stored in localStorage after completion. Safe in the real app
   (this is not an in-conversation preview). */

const STEPS: { sel: string; title: string; body: string; place?: 'below' | 'above' }[] = [
  { sel: '[data-tour="start"]', title: '1 · Record the visit', body: 'Press Start and just talk to your patient as normal. Notera writes the transcript live while you speak.' },
  { sel: '[data-tour="create"]', title: '2 · Create the note', body: 'When the visit ends, click Create SOAP. Your structured note is ready in a few seconds — review it, tweak a word if needed, and copy it to your EMR.' },
  { sel: '[data-tour="paste"]', title: '3 · No recording? Paste instead', body: 'Already have the consult text? Open Paste transcript and drop it in — Notera turns it into a note the same way.' },
  { sel: '[data-tour="new"]', title: '4 · Next patient', body: 'Finished a note? Click New session to start fresh for the next patient.' },
]

export default function Onboarding() {
  const [active, setActive] = useState(false)
  const [phase, setPhase] = useState<'terms' | 'tour'>('terms')
  const [i, setI] = useState(0)
  const [agreed, setAgreed] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)

  useEffect(() => {
    try { if (!localStorage.getItem('notera_onboarded_v1')) setActive(true) } catch { /* private mode */ }
  }, [])

  const measure = useCallback(() => {
    if (phase !== 'tour') { setRect(null); return }
    const el = document.querySelector(STEPS[i].sel)
    setRect(el ? el.getBoundingClientRect() : null)
  }, [phase, i])

  useEffect(() => {
    measure()
    const h = () => measure()
    window.addEventListener('resize', h)
    window.addEventListener('scroll', h, true)
    return () => { window.removeEventListener('resize', h); window.removeEventListener('scroll', h, true) }
  }, [measure])

  if (!active) return null

  const finish = () => { try { localStorage.setItem('notera_onboarded_v1', '1') } catch { /* */ } setActive(false) }

  // ── Terms & Conditions ──────────────────────────────────────────────────
  if (phase === 'terms') {
    return (
      <div className="nto-overlay" role="dialog" aria-modal="true" aria-labelledby="nto-terms-title">
        <div className="nto-modal">
          <div className="nto-modal-mark">N</div>
          <h2 id="nto-terms-title" className="nto-modal-title">Welcome to Notera</h2>
          <p className="nto-modal-sub">A quick note before you start — please read and accept.</p>
          <div className="nto-terms">
            <p><strong>Notera is a documentation aid, not a medical device.</strong> It drafts a clinical note from your consultation; a qualified clinician must review, edit and sign every note before it is used.</p>
            <p>You are responsible for the accuracy of the final note. Do not rely on Notera for clinical decisions. Ensure you have appropriate patient consent to record where required.</p>
            <p>Your data is encrypted and never used to train models. By continuing you agree to the Terms of Service and Privacy Policy.</p>
          </div>
          <label className="nto-check">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>I have read and agree to the Terms of Service and Privacy Policy.</span>
          </label>
          <div className="nto-modal-actions">
            <button className="nto-btn nto-btn-primary" disabled={!agreed} onClick={() => setPhase('tour')}>Agree &amp; continue</button>
          </div>
        </div>
      </div>
    )
  }

  // ── Coach-marks ─────────────────────────────────────────────────────────
  const pad = 8
  const spot = rect ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 } : null
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const TT_W = 320
  let ttStyle: React.CSSProperties = { left: vw / 2 - TT_W / 2, top: vh / 2 - 80 }
  if (rect) {
    const below = rect.bottom + 190 < vh
    const left = Math.min(Math.max(rect.left, 14), vw - TT_W - 14)
    ttStyle = below ? { top: rect.bottom + 14, left } : { top: rect.top - 14, left, transform: 'translateY(-100%)' }
  }
  const last = i === STEPS.length - 1

  return (
    <div className="nto-tour" role="dialog" aria-modal="true">
      {/* spotlight: dark everywhere except a hole around the target */}
      {spot ? (
        <div className="nto-spot" style={spot} />
      ) : (
        <div className="nto-scrim" />
      )}
      <div className="nto-tip" style={ttStyle}>
        <div className="nto-tip-step">Step {i + 1} of {STEPS.length}</div>
        <h3 className="nto-tip-title">{STEPS[i].title}</h3>
        <p className="nto-tip-body">{STEPS[i].body}</p>
        <div className="nto-tip-actions">
          <button className="nto-skip" onClick={finish}>Skip</button>
          <div className="nto-tip-nav">
            {i > 0 && <button className="nto-btn nto-btn-ghost" onClick={() => setI(i - 1)}>Back</button>}
            <button className="nto-btn nto-btn-primary" onClick={() => (last ? finish() : setI(i + 1))}>{last ? 'Got it' : 'Next'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
