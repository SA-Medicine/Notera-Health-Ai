'use client'

import { useEffect, useState } from 'react'
import { SITE_URL, TERMS_VERSION } from '../../lib/legal'

const API = '/backend/api/auth/consent'
type Consent = { current: string; termsVersion: string | null; improve: boolean; improveAt: string | null }

/** The optional "Help improve Notera" choice, with the plain-language reason. Off unless the clinician turns it on; every change is saved and audited. */
export function ImproveChoice({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="pc-opt">
      <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>Help improve Notera</strong> <em>(optional, off by default)</em>
        <small>Let Notera staff and our training clinician use my recordings, transcripts, notes and corrections to measure accuracy and improve Notera itself. Not sold, not shared to train other companies&apos; models. Turn this on only if my patients&apos; consent and local rules allow it. I can change this at any time.</small>
      </span>
    </label>
  )
}

export default function PrivacyChoice({ onClose }: { onClose: () => void }) {
  const [c, setC] = useState<Consent | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch(API, { credentials: 'include' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load your choices.')))).then(setC).catch((e) => setErr(e.message))
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [onClose])

  async function save(improve: boolean) {
    setBusy(true); setErr('')
    try {
      const r = await fetch(API, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ improve }) })
      if (!r.ok) throw new Error('Could not save. Please try again.')
      setC(await r.json())
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="nto-overlay" role="dialog" aria-modal="true" aria-labelledby="pc-title" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="nto-modal">
        <h2 id="pc-title" className="nto-modal-title">Privacy &amp; data</h2>
        <p className="nto-modal-sub">Your recordings and notes are used to run Notera for you. Anything beyond that is your choice.</p>
        {c ? <ImproveChoice value={c.improve} disabled={busy} onChange={save} /> : <p className="muted">{err || 'Loading…'}</p>}
        {err && c ? <p role="alert" style={{ color: 'var(--bad, #b3261e)', fontSize: 13 }}>{err}</p> : null}
        <p className="pc-links">
          {c?.termsVersion ? <>You accepted the terms of {c.termsVersion}{c.termsVersion !== TERMS_VERSION ? ' (newer terms are available)' : ''}. </> : null}
          <a href={`${SITE_URL}/terms`} target="_blank" rel="noopener noreferrer">Terms of Service</a> · <a href={`${SITE_URL}/privacy`} target="_blank" rel="noopener noreferrer">Privacy Policy</a>
        </p>
        <div className="nto-modal-actions"><button className="nto-btn nto-btn-primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}
