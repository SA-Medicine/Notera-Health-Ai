'use client'

import { useEffect, useRef, useState } from 'react'
import './demo.css'

/* Animated product demo: record → live transcript → "writing note" → finished note, looping.
   Driven by one clock (t, ms) so every stage is derived, not scheduled — easy to reason about,
   pauses when off-screen, and renders a static finished frame for prefers-reduced-motion.
   All content is a SYNTHETIC sample consult (labelled as such in the UI). */

const LINES: { who: 'Doctor' | 'Patient'; text: string; at: number }[] = [
  { who: 'Doctor', text: 'What brings you in today?', at: 1900 },
  { who: 'Patient', text: 'Sharp chest pain on the left since last night, about a seven out of ten.', at: 3300 },
  { who: 'Patient', text: "It's worse when I lie down or take a deep breath.", at: 5200 },
  { who: 'Doctor', text: 'Any shortness of breath or palpitations?', at: 6700 },
  { who: 'Patient', text: "Yes, my heart's racing. My dad had a heart attack at 45.", at: 8000 },
  { who: 'Doctor', text: "I'd like an ECG and troponin today. Please head to the emergency department.", at: 9800 },
]
const START = 1000        // "Start recording" is pressed
const STOP = 11800        // "Stop" is pressed
const NOTE_AT = 15700     // finished note appears (about 3.9 s of "writing", matching production)
const END = 23500         // hold, then loop
const STEPS = ['Reading the conversation', 'Writing the SOAP note', 'Checking against the transcript']

const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }

export default function Demo() {
  const root = useRef<HTMLDivElement>(null)
  const [t, setT] = useState(0)
  const [reduce, setReduce] = useState(false)
  const visible = useRef(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduce(mq.matches)
    const io = new IntersectionObserver(([e]) => { visible.current = e.isIntersecting }, { threshold: 0.2 })
    if (root.current) io.observe(root.current)
    let last = performance.now(); let raf = 0
    const tick = (now: number) => {
      const dt = Math.min(120, now - last); last = now
      const ext = (window as unknown as { __dmT?: number }).__dmT          // external clock: used to render the demo video frame by frame
      if (typeof ext === 'number') setT(ext)
      else if (visible.current && !mq.matches) setT((p) => (p + dt >= END ? 0 : p + dt))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); io.disconnect() }
  }, [])

  const time = reduce ? NOTE_AT + 3000 : t
  const rec = time >= START && time < STOP
  const gen = time >= STOP && time < NOTE_AT
  const done = time >= NOTE_AT
  const shown = LINES.filter((l) => time >= l.at)
  const genStep = Math.min(2, Math.floor((time - STOP) / ((NOTE_AT - STOP) / 3)))
  const secs = rec ? time - START : STOP - START

  return (
    <div className="dm-wrap" ref={root} aria-label="Animated demo of Notera turning a consultation into a SOAP note" role="img">
      <div className="dm">
        <div className="dm-top">
          <div className="dm-brand"><i>●</i> Notera</div>
          <div className="dm-pat">Sample consult · chest pain</div>
          <div className="dm-chip">{done ? 'Note ready' : gen ? 'Writing note' : rec ? 'Recording' : 'Ready'}</div>
        </div>

        <div className="dm-main">
          <div className="dm-card">
            <div className="dm-h"><b>Transcript</b>{rec && <span className="dm-live"><i />Live</span>}<span className="dm-n">{shown.length ? `${shown.length} segments` : ''}</span></div>
            <div className="dm-body">
              {shown.length === 0 && <div className="dm-empty">Ready when you are</div>}
              {shown.map((l, i) => (
                <div key={i} className="dm-line"><span>{mmss((l.at - START))}</span><p><em>{l.who}</em> {l.text}</p></div>
              ))}
              {rec && <div className="dm-line dim"><span>now</span><p>Listening <span className="dm-dots"><i /><i /><i /></span></p></div>}
            </div>
          </div>

          <div className="dm-card">
            <div className="dm-h"><b>SOAP note</b>{done && <span className="dm-n">saved to history</span>}</div>
            <div className="dm-body">
              {!gen && !done && <div className="dm-empty">Your note appears here</div>}
              {gen && (
                <div className="dm-gen">
                  <div className="dm-orb" />
                  <ol>{STEPS.map((s, i) => <li key={s} className={i < genStep ? 'done' : i === genStep ? 'now' : ''}><span />{s}</li>)}</ol>
                </div>
              )}
              {done && (
                <div className="dm-note">
                  <h4 style={{ ['--i' as string]: 0 }}>Subjective</h4>
                  <ul style={{ ['--i' as string]: 1 }}>
                    <li>Chest pain since last night, left-sided, sharp, 7/10.</li>
                    <li>Worse lying down and with a deep breath.</li>
                    <li>Racing heart, shortness of breath.</li>
                  </ul>
                  <h4 style={{ ['--i' as string]: 2 }}>Past medical history</h4>
                  <ul style={{ ['--i' as string]: 3 }}><li>Father had a heart attack at 45.</li></ul>
                  <h4 style={{ ['--i' as string]: 4 }}>Assessment &amp; plan</h4>
                  <ul style={{ ['--i' as string]: 5 }}>
                    <li><b>1. Acute chest pain</b></li>
                    <li>Investigations: ECG, troponin.</li>
                    <li>Referral: Emergency Department today.</li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="dm-dock">
          {rec ? (
            <div className="dm-rec on"><span className="sq" />Stop<b>{mmss(secs)}</b><span className="dm-meter" style={{ ['--p' as string]: (time / 140) % 6 }}><i /><i /><i /><i /><i /></span></div>
          ) : gen ? (
            <div className="dm-btn primary"><span className="dm-spin" />Writing note…</div>
          ) : done ? (
            <><div className="dm-btn primary">+ New session</div><div className="dm-btn">Copy to EMR</div></>
          ) : (
            <div className="dm-rec"><span className="rd" />Start recording</div>
          )}
        </div>

        <div className={`dm-badge${done ? ' on' : ''}`}>Note ready in 3.9 s</div>
      </div>
      <p className="dm-cap">Synthetic sample consult. Real output from the Notera pipeline.</p>
    </div>
  )
}
