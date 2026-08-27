import type { Metadata } from 'next'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://aitoolsfordoctor.com'

// Root layout is theme-neutral. Each route group owns its own look:
//   (marketing) → public SEO site (aitoolsfordoctor.com)
//   (app)       → the clinician product (app.aitoolsfordoctor.com)
//   (admin)     → the testing lab (dev only)
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'AI Tools for Doctors — clinical AI that saves you time',
    template: '%s | AI Tools for Doctors',
  },
  description:
    'Purpose-built AI tools for physicians: turn consultations into signed, schema-structured SOAP notes in seconds. HIPAA-ready, human-in-the-loop, built by clinicians.',
  keywords: [
    'AI tools for doctors', 'AI medical scribe', 'clinical documentation AI',
    'SOAP note generator', 'AI for physicians', 'HIPAA compliant AI scribe',
    'medical documentation software', 'ambient clinical documentation',
  ],
  applicationName: 'AI Tools for Doctors',
  authors: [{ name: 'AI Tools for Doctors' }],
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'AI Tools for Doctors',
    url: SITE_URL,
    title: 'AI Tools for Doctors — clinical AI that saves you time',
    description: 'Turn consultations into signed SOAP notes in seconds. HIPAA-ready, physician-built AI tools.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'AI Tools for Doctors' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AI Tools for Doctors',
    description: 'Clinical AI that saves physicians time — starting with automated SOAP notes.',
    images: ['/og.png'],
  },
  robots: {
    index: true, follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
}

// Organization + WebSite structured data (helps Google understand the brand + enables sitelinks search).
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#org`,
      name: 'AI Tools for Doctors',
      url: SITE_URL,
      description: 'AI tools that help physicians document faster and safer.',
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'AI Tools for Doctors',
      publisher: { '@id': `${SITE_URL}/#org` },
    },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* suppressHydrationWarning: browser extensions (Grammarly, etc.) inject
          data-gr-* attributes onto <body> before React hydrates. */}
      <body suppressHydrationWarning>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        {children}
      </body>
    </html>
  )
}
