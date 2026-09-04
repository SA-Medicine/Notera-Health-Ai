import type { Metadata } from 'next'
import Landing from './Landing'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://aitoolsfordoctor.com'
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.aitoolsfordoctor.com'

export const metadata: Metadata = {
  title: 'Notera — the AI medical scribe that writes the note as you talk',
  description:
    'Notera listens to the visit and writes a clean, grounded SOAP note in seconds — HIPAA-ready, never trained on your data, and in your voice. Free for your first 50 notes.',
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
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'Free for the first 50 notes' },
      description: 'Turn consultations into grounded, structured SOAP notes in seconds.',
      url: SITE_URL,
    },
    {
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'Is my patient data used to train the AI?',
          acceptedAnswer: { '@type': 'Answer', text: 'No. Your visits are never used to train models. Data is encrypted at rest and in transit, with per-user access and audit logging.' } },
        { '@type': 'Question', name: 'What if it writes something the patient did not say?',
          acceptedAnswer: { '@type': 'Answer', text: 'Every line is grounded to the transcript, drug names are checked against a real drug database, and anything uncertain is flagged for the clinician rather than written in.' } },
        { '@type': 'Question', name: 'Does it work with my EMR?',
          acceptedAnswer: { '@type': 'Answer', text: 'The finished note copies cleanly into any EMR today. Deeper write-back integrations are available on Enterprise.' } },
      ],
    },
  ],
}

export default function MarketingHome() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Landing appUrl={APP_URL} />
    </>
  )
}
