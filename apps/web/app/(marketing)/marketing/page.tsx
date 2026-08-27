import type { Metadata } from 'next'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://aitoolsfordoctor.com'
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.aitoolsfordoctor.com'

export const metadata: Metadata = {
  title: 'AI Tools for Doctors — automate clinical notes & paperwork',
  description:
    'AI tools built for physicians. Turn any consultation into a signed, schema-structured SOAP note in seconds — HIPAA-ready, human-in-the-loop, physician-built. Start with Notera, our AI medical scribe.',
  alternates: { canonical: '/' },
}

// Rich structured data: the brand as a SoftwareApplication + an FAQ (both eligible for rich results).
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'SoftwareApplication',
      name: 'Notera — AI Medical Scribe',
      applicationCategory: 'HealthApplication',
      operatingSystem: 'Web',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'Free trial' },
      description: 'Turn consultations into signed, schema-structured SOAP notes in seconds.',
      url: `${SITE_URL}/notera`,
    },
    {
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'Is it HIPAA compliant?',
          acceptedAnswer: { '@type': 'Answer', text: 'Yes. Data is processed under a signed BAA on HIPAA-eligible infrastructure, encrypted in transit and at rest, with per-user access controls and audit logging.' } },
        { '@type': 'Question', name: 'How does the AI medical scribe work?',
          acceptedAnswer: { '@type': 'Answer', text: 'It listens to or ingests the consultation, extracts the clinical facts, and drafts a structured SOAP note that the clinician reviews and signs — human-in-the-loop, never auto-filed.' } },
        { '@type': 'Question', name: 'Which specialties are supported?',
          acceptedAnswer: { '@type': 'Answer', text: 'Primary care and most outpatient specialties. The note structure adapts to the encounter type automatically.' } },
      ],
    },
  ],
}

const tools = [
  { name: 'Notera', tag: 'AI Medical Scribe', live: true,
    desc: 'Record or paste a consultation; get a signed, structured SOAP note in seconds.',
    href: `${APP_URL}` },
  { name: 'Coding Assist', tag: 'ICD-10 / CPT', live: false,
    desc: 'Suggests accurate diagnosis and procedure codes from your note. Coming soon.', href: '#' },
  { name: 'Referral Writer', tag: 'Letters', live: false,
    desc: 'Drafts referral and specialist letters from the encounter. Coming soon.', href: '#' },
]

const features = [
  ['Signed in seconds', 'Consultation in, structured SOAP note out — you review and sign. No more after-hours charting.'],
  ['HIPAA-ready', 'Runs under a signed BAA on HIPAA-eligible cloud, encrypted end to end, with audit logging and per-user access.'],
  ['Human-in-the-loop', 'The AI drafts; the clinician decides. Nothing is filed without your sign-off.'],
  ['Grounded, not guessed', 'Every fact is traced to what was actually said, with a final hallucination-removal pass.'],
]

export default function MarketingHome() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      {/* Header */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <a href="/" className="text-lg font-bold tracking-tight">AI Tools for Doctors</a>
        <nav className="flex items-center gap-6 text-sm text-slate-600">
          <a href="#tools" className="hover:text-slate-900">Tools</a>
          <a href="#how" className="hover:text-slate-900">How it works</a>
          <a href={APP_URL} className="rounded-lg bg-[color:var(--brand)] px-4 py-2 font-medium text-white">Sign in</a>
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pb-10 pt-8 text-center">
        <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-[color:var(--brand)]">Clinical AI, built for physicians</p>
        <h1 className="mx-auto max-w-3xl text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
          Spend less time charting. More time with patients.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
          AI tools for doctors that turn every consultation into a signed, schema-structured SOAP note in
          seconds — HIPAA-ready, human-in-the-loop, and built by clinicians.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <a href={APP_URL} className="rounded-xl bg-[color:var(--brand)] px-6 py-3 font-semibold text-white shadow-sm">Start free</a>
          <a href="#how" className="rounded-xl border border-slate-300 px-6 py-3 font-semibold text-slate-700">See how it works</a>
        </div>
      </section>

      {/* Tools */}
      <section id="tools" className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="text-2xl font-bold tracking-tight">The toolkit</h2>
        <p className="mt-2 text-slate-600">One login, a growing suite of AI tools for your clinic.</p>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          {tools.map((t) => (
            <a key={t.name} href={t.href} className="block rounded-2xl border border-slate-200 p-6 transition hover:border-slate-300 hover:shadow-sm">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">{t.name}</h3>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${t.live ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{t.live ? 'Live' : 'Soon'}</span>
              </div>
              <p className="mt-1 text-xs font-medium uppercase tracking-wide text-[color:var(--brand)]">{t.tag}</p>
              <p className="mt-3 text-sm text-slate-600">{t.desc}</p>
            </a>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="border-y border-slate-100 bg-slate-50/60">
        <div className="mx-auto max-w-6xl px-6 py-14">
          <h2 className="text-2xl font-bold tracking-tight">Why physicians choose it</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {features.map(([h, b]) => (
              <div key={h}>
                <h3 className="font-semibold">{h}</h3>
                <p className="mt-2 text-sm text-slate-600">{b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="text-2xl font-bold tracking-tight">How it works</h2>
        <ol className="mt-8 grid gap-6 sm:grid-cols-3">
          {[
            ['1. Capture', 'Record the visit or paste the transcript.'],
            ['2. Draft', 'The AI extracts the facts and writes a structured SOAP note.'],
            ['3. Sign', 'You review, edit if needed, and sign. Done.'],
          ].map(([h, b]) => (
            <li key={h} className="rounded-2xl border border-slate-200 p-6">
              <h3 className="font-semibold">{h}</h3>
              <p className="mt-2 text-sm text-slate-600">{b}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="rounded-3xl bg-[color:var(--ink)] px-8 py-14 text-center text-white">
          <h2 className="text-3xl font-bold">Get your evenings back.</h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-300">Start documenting with AI today — no credit card to try it.</p>
          <a href={APP_URL} className="mt-8 inline-block rounded-xl bg-white px-6 py-3 font-semibold text-slate-900">Start free</a>
        </div>
      </section>

      <footer className="border-t border-slate-100">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 text-sm text-slate-500 sm:flex-row">
          <p>© {new Date().getFullYear()} AI Tools for Doctors</p>
          <nav className="flex gap-5">
            <a href="/notera" className="hover:text-slate-900">Notera</a>
            <a href="/pricing" className="hover:text-slate-900">Pricing</a>
            <a href="/contact" className="hover:text-slate-900">Contact</a>
          </nav>
        </div>
      </footer>
    </>
  )
}
