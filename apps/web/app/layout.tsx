import type { Metadata } from 'next'

// Root layout is theme-neutral. Each route group owns its own look:
//   (app)   → the clinician product (its own white globals.css + AuthProvider)
//   (admin) → the testing lab (shadcn dark design system)
export const metadata: Metadata = {
  title: 'Notera — clinical documentation engine',
  description: 'Record, draft, review and sign schema-structured SOAP notes. Gemini-powered, human-in-the-loop. Plus the internal testing lab.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  )
}
