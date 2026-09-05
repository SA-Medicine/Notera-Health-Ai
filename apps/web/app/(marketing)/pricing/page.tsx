import type { Metadata } from 'next'
import Shell, { Check, LOGIN } from '../Shell'

const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'https://aitoolsfordoctor.com'

export const metadata: Metadata = {
  title: 'Pricing — Notera AI Medical Scribe',
  description:
    'Notera pricing: start free for your first 50 notes, then a simple per-clinician plan for unlimited AI SOAP notes. No card to begin, cancel any time. See how much an AI medical scribe costs.',
  keywords: ['AI scribe pricing', 'AI medical scribe cost', 'SOAP note generator pricing', 'Notera pricing'],
  alternates: { canonical: '/pricing' },
  openGraph: { title: 'Notera Pricing — AI Medical Scribe', description: 'Start free for your first 50 notes, then a simple per-clinician plan.', url: `${SITE}/pricing`, images: ['/og.png'] },
}

const tiers = [
  { name: 'Solo', price: '$0', unit: '/first 50 notes', desc: 'Everything you need to try it on real visits.', pop: false, cta: 'Start free', feats: ['Up to 50 notes free', 'SOAP notes + transcript', 'Copy to any EMR'] },
  { name: 'Practice', price: '$49', unit: '/clinician / mo', desc: 'For clinicians who see patients all day, every day.', pop: true, cta: 'Start free trial', feats: ['Unlimited notes', 'Specialty auto-tuning', 'Full searchable history', 'Priority support'] },
  { name: 'Enterprise', price: "Let's talk", unit: '', desc: 'For groups and health systems with their own rules.', pop: false, cta: 'Talk to us', feats: ['SSO & admin controls', 'EMR integrations', 'BAA & custom security review'] },
]

export default function PricingPage() {
  return (
    <Shell>
      <span className="mkt-eyebrow">Pricing</span>
      <h1>Simple pricing. <span className="g">Start free.</span></h1>
      <p className="lede">Try Notera on real visits before you pay a cent. Free for your first 50 notes, then a flat per-clinician plan. No card to begin, cancel any time.</p>

      <div className="mkt-price">
        {tiers.map((t) => (
          <div key={t.name} className={`mkt-tier${t.pop ? ' pop' : ''}`}>
            {t.pop && <span className="tag">Most popular</span>}
            <h3>{t.name}</h3>
            <div className="amt">{t.price}{t.unit && <small>{t.unit}</small>}</div>
            <p className="desc">{t.desc}</p>
            <ul>{t.feats.map((f) => <li key={f}><Check />{f}</li>)}</ul>
            <a className={`mkt-btn ${t.pop ? 'mkt-btn-primary' : 'mkt-btn-ghost'}`} href={t.name === 'Enterprise' ? '/contact' : LOGIN}>{t.cta}</a>
          </div>
        ))}
      </div>

      <h2>How much does an AI medical scribe cost?</h2>
      <p>Most clinicians spend around two hours a day on documentation. Notera&apos;s Practice plan is a flat <strong>$49 per clinician per month</strong> for unlimited notes — a fraction of the time it gives back. There are no per-note fees on paid plans and no setup cost.</p>

      <h2>Pricing FAQ</h2>
      <div className="mkt-faq">
        <div className="mkt-qa"><h3>Do I need a credit card to start?</h3><p>No. The first 50 notes are free with no card. Add a payment method only when you&apos;re ready to continue.</p></div>
        <div className="mkt-qa"><h3>Can I cancel any time?</h3><p>Yes — plans are month-to-month and you can cancel whenever you like.</p></div>
        <div className="mkt-qa"><h3>Is there a discount for annual billing?</h3><p>Yes, annual billing saves 20% versus monthly on the Practice plan.</p></div>
        <div className="mkt-qa"><h3>What about a whole practice or health system?</h3><p>Enterprise includes SSO, EMR integrations, and a signed BAA. <a href="/contact" style={{ color: 'var(--brand2)' }}>Talk to us</a>.</p></div>
      </div>

      <div className="mkt-band">
        <h2>Get your evenings back</h2>
        <p>Start free on your next 50 visits — no card, no commitment.</p>
        <a className="mkt-btn mkt-btn-lg" href={LOGIN}>Start free ↗</a>
      </div>
    </Shell>
  )
}
