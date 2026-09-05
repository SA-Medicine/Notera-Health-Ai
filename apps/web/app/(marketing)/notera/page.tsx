import type { Metadata } from 'next'
import Shell, { Check, LOGIN } from '../Shell'

const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'https://aitoolsfordoctor.com'

export const metadata: Metadata = {
  title: 'Notera — AI Medical Scribe & SOAP Note Generator',
  description:
    'Notera is an AI medical scribe that turns any consultation into a clean, grounded SOAP note in seconds. Ambient AI documentation for physicians — HIPAA-ready, never trained on your data. Free for your first 50 notes.',
  keywords: ['AI medical scribe', 'SOAP note generator', 'AI clinical documentation', 'ambient scribe', 'automated charting', 'medical dictation alternative'],
  alternates: { canonical: '/notera' },
  openGraph: { title: 'Notera — AI Medical Scribe & SOAP Note Generator', description: 'Turn consultations into grounded SOAP notes in seconds. HIPAA-ready, physician-built.', url: `${SITE}/notera`, images: ['/og.png'] },
}

const jsonLd = {
  '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Notera — AI Medical Scribe',
  applicationCategory: 'HealthApplication', operatingSystem: 'Web',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'Free for the first 50 notes' },
  description: 'AI medical scribe that turns consultations into grounded, structured SOAP notes in seconds.',
  url: `${SITE}/notera`,
}

export default function NoteraPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Shell>
        <span className="mkt-eyebrow">AI Medical Scribe</span>
        <h1>The <span className="g">AI medical scribe</span> that writes your SOAP note as you talk.</h1>
        <p className="lede">Notera is an ambient AI scribe for clinicians. Have the visit exactly as you always do — Notera listens, then drafts a clean, structured SOAP note in seconds. No dictation, no templates, no charting after hours.</p>
        <div className="mkt-cta-row">
          <a className="mkt-btn mkt-btn-primary mkt-btn-lg" href={LOGIN}>Start free — no card ↗</a>
          <a className="mkt-btn mkt-btn-ghost mkt-btn-lg" href="/pricing">See pricing</a>
        </div>

        <h2>What Notera does</h2>
        <p>Notera is an <strong>AI medical scribe</strong> and <strong>SOAP note generator</strong> built for real consultations. It captures the conversation, extracts the clinical facts, and produces a documented note in the structure your specialty expects — Subjective, Objective, Assessment and Plan — ready for you to review and sign.</p>
        <ul>
          <li><Check />Turns speech into a structured SOAP note in seconds</li>
          <li><Check />Auto-detects the encounter type and matches your specialty</li>
          <li><Check />Copies cleanly into any EMR</li>
          <li><Check />Keeps a searchable history of every visit</li>
        </ul>

        <h2>How the AI scribe works</h2>
        <div className="mkt-grid">
          <div className="mkt-card"><h3>1 · Record</h3><p>Hit record and talk to your patient normally. Notera handles accents, interruptions, and real-world speech.</p></div>
          <div className="mkt-card"><h3>2 · Draft</h3><p>Seconds after you stop, a structured SOAP note is waiting — grounded to what was actually said.</p></div>
          <div className="mkt-card"><h3>3 · Sign</h3><p>Skim, edit a word if you want, and copy to your EMR. You review and sign — always.</p></div>
        </div>

        <h2>Why clinicians trust it</h2>
        <p>The hard part of an AI scribe isn&apos;t speed — it&apos;s accuracy. Notera is built to be <strong>grounded, not guessed</strong>: every line is traceable to the transcript, drug names are checked against a real drug database, and anything uncertain is flagged rather than invented. No hallucinated labs, no phantom medications.</p>
        <ul>
          <li><Check />Line-by-line grounding to the transcript</li>
          <li><Check />HIPAA-ready · encrypted in transit and at rest</li>
          <li><Check />Your visits are never used to train models</li>
        </ul>

        <h2>Specialties</h2>
        <p>Notera adapts the note to how your field documents — a cardiology plan reads like cardiology, a psychiatry note reads like psychiatry. It&apos;s used across family medicine, cardiology, psychiatry, paediatrics, and urgent care.</p>

        <h2>Frequently asked</h2>
        <div className="mkt-faq">
          <div className="mkt-qa"><h3>Is Notera HIPAA compliant?</h3><p>Notera is built to meet HIPAA requirements — encrypted in transit and at rest, per-user access, and audit logging. Your data is never used to train models.</p></div>
          <div className="mkt-qa"><h3>Does it work with my EMR?</h3><p>The finished note copies cleanly into any EMR today. Deeper write-back integrations are available on Enterprise.</p></div>
          <div className="mkt-qa"><h3>What does it cost?</h3><p>Free for your first 50 notes, then a simple per-clinician plan. See <a href="/pricing" style={{ color: 'var(--brand2)' }}>pricing</a>.</p></div>
        </div>

        <div className="mkt-band">
          <h2>Try Notera on your next visit</h2>
          <p>Free for your first 50 notes — no card, no commitment.</p>
          <a className="mkt-btn mkt-btn-lg" href={LOGIN}>Start free ↗</a>
        </div>
      </Shell>
    </>
  )
}
