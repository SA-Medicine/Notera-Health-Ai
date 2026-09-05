import type { Metadata } from 'next'
import Shell from '../Shell'

const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'https://aitoolsfordoctor.com'
// Change this to whichever inbox you want contact emails to reach.
const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL || 'support@aitoolsfordoctor.com'

export const metadata: Metadata = {
  title: 'Contact Notera — Talk to Us',
  description:
    'Get in touch with the Notera team. Questions about the AI medical scribe, a demo for your practice, pricing for a health system, or partnerships — we usually reply within one business day.',
  keywords: ['contact Notera', 'Notera demo', 'AI medical scribe support', 'AI scribe sales'],
  alternates: { canonical: '/contact' },
  openGraph: { title: 'Contact Notera', description: 'Questions, demos, or partnerships — get in touch with the Notera team.', url: `${SITE}/contact`, images: ['/og.png'] },
}

export default function ContactPage() {
  return (
    <Shell>
      <span className="mkt-eyebrow">Contact</span>
      <h1>Let&apos;s <span className="g">talk.</span></h1>
      <p className="lede">Questions about Notera, a demo for your practice, pricing for a health system, or a partnership — we&apos;d love to hear from you. We usually reply within one business day.</p>

      <h2>Email us directly</h2>
      <p><a className="mkt-contact-mail" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>

      <h2>Or send a message</h2>
      <form className="mkt-form" action={`mailto:${CONTACT_EMAIL}`} method="post" encType="text/plain">
        <label htmlFor="name">Name</label>
        <input id="name" name="Name" type="text" placeholder="Dr. Jane Smith" required />
        <label htmlFor="email">Work email</label>
        <input id="email" name="Email" type="email" placeholder="you@clinic.org" required />
        <label htmlFor="message">Message</label>
        <textarea id="message" name="Message" placeholder="Tell us a bit about your practice and what you're looking for…" required />
        <button className="mkt-btn mkt-btn-primary" type="submit">Send message ↗</button>
      </form>

      <h2>Looking for support?</h2>
      <p>Already using Notera and need help? Email <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: 'var(--brand2)' }}>{CONTACT_EMAIL}</a> and we&apos;ll get you sorted.</p>
    </Shell>
  )
}
