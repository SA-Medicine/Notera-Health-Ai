import type { Metadata } from 'next'
import Shell, { Check, LOGIN } from '../Shell'

const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'https://aitoolsfordoctor.com'

export const metadata: Metadata = {
  title: 'About Notera — Physician-Built AI Documentation',
  description:
    'Notera is a physician-built AI medical scribe on a mission to give clinicians their time back. Learn who we are, how we think about accuracy and privacy, and why grounded documentation matters.',
  keywords: ['about Notera', 'physician-built AI scribe', 'clinical AI company', 'AI documentation for doctors'],
  alternates: { canonical: '/about' },
  openGraph: { title: 'About Notera', description: 'Physician-built AI documentation that gives clinicians their time back.', url: `${SITE}/about`, images: ['/og.png'] },
}

export default function AboutPage() {
  return (
    <Shell>
      <span className="mkt-eyebrow">About</span>
      <h1>Built so clinicians can <span className="g">look up from the keyboard.</span></h1>
      <p className="lede">Notera exists for one reason: documentation quietly became a second job, and it&apos;s pulling clinicians away from patients and into their evenings. We build AI that takes the note off your plate — accurately, privately, and in your voice.</p>

      <h2>Our mission</h2>
      <p>Give clinicians their time back without ever compromising the chart. An AI scribe is only useful if you can trust it with a real medical record, so we obsess over one thing above all: <strong>getting the note right, every time</strong>.</p>

      <h2>What we believe</h2>
      <ul>
        <li><Check /><strong>Grounded, not guessed.</strong> Every line is traceable to what was actually said. We would rather leave something out than invent it.</li>
        <li><Check /><strong>The clinician signs.</strong> Notera drafts; a qualified clinician reviews and signs. It is a documentation aid, not a medical device.</li>
        <li><Check /><strong>Privacy is the product.</strong> Patient data is encrypted and never used to train models.</li>
        <li><Check /><strong>It should sound like you.</strong> A good note reads the way you would have written it — your structure, your specialty.</li>
      </ul>

      <h2>Who it&apos;s for</h2>
      <p>Notera is used by clinicians across family medicine, cardiology, psychiatry, paediatrics, and urgent care — anyone who would rather spend their attention on the patient than on a screen. It runs on the laptop you already have and sets up in about three minutes.</p>

      <h2>Get in touch</h2>
      <p>Questions, partnerships, or want a demo for your practice? We&apos;d love to hear from you — head to our <a href="/contact" style={{ color: 'var(--brand2)' }}>contact page</a>.</p>

      <div className="mkt-band">
        <h2>See it on your next visit</h2>
        <p>Free for your first 50 notes — no card, no commitment.</p>
        <a className="mkt-btn mkt-btn-lg" href={LOGIN}>Start free ↗</a>
      </div>
    </Shell>
  )
}
