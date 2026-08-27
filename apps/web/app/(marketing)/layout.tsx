import './globals.css'

// Public marketing shell — NO AuthProvider (this is the indexable SEO site,
// served on the apex domain aitoolsfordoctor.com).
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-white text-slate-900 antialiased">{children}</div>
}
