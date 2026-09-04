import type { Metadata } from 'next'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://aitoolsfordoctor.com'

// Root layout is theme-neutral. Each route group owns its own look:
//   (marketing) → public SEO site (aitoolsfordoctor.com)
//   (app)       → the clinician product (app.aitoolsfordoctor.com)
//   (admin)     → the testing lab (dev only)
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Notera — AI Medical Scribe for Doctors',
    template: '%s | Notera',
  },
  description:
    'Notera is an AI medical scribe that turns consultations into grounded, structured SOAP notes in seconds. HIPAA-ready, never trained on your data, and in your voice. Free for your first 50 notes.',
  keywords: [
    'Notera', 'AI medical scribe', 'AI tools for doctors', 'clinical documentation AI',
    'SOAP note generator', 'AI for physicians', 'HIPAA compliant AI scribe',
    'ambient clinical documentation', 'automated charting', 'medical dictation alternative',
  ],
  applicationName: 'Notera',
  authors: [{ name: 'Notera' }],
  alternates: { canonical: '/' },
  // Favicon / apple-icon come from the Next file convention: app/icon.png, app/apple-icon.png, app/favicon.ico
  openGraph: {
    type: 'website',
    siteName: 'Notera',
    url: SITE_URL,
    title: 'Notera — AI Medical Scribe for Doctors',
    description: 'Turn consultations into grounded, structured SOAP notes in seconds. HIPAA-ready, physician-built.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Notera — AI medical scribe' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Notera — AI Medical Scribe',
    description: 'The AI scribe that writes the note as you talk. Grounded, private, in your voice.',
    images: ['/og.png'],
  },
  robots: {
    index: true, follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
}

export const viewport = {
  themeColor: '#6d5efc',
}

// Organization + WebSite structured data (helps Google understand the brand + enables sitelinks search).
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#org`,
      name: 'Notera',
      url: SITE_URL,
      logo: `${SITE_URL}/icon-512.png`,
      description: 'Notera is an AI medical scribe that helps physicians document faster and safer.',
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'Notera',
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
