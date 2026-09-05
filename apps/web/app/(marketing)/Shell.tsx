import './pages.css'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.aitoolsfordoctor.com'
const LOGIN = `${APP_URL}/login`

// Shared chrome for the static marketing content pages. Server-rendered (no JS) for SEO + speed.
export default function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mkt">
      <div className="mkt-bg"><span className="orb a" /><span className="orb b" /></div>

      <nav className="mkt-nav">
        <div className="wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <a className="mkt-brand" href="/"><img src="/icon.png" alt="Notera" width={32} height={32} />Notera</a>
          <div className="mkt-links">
            <a href="/notera">Product</a>
            <a href="/pricing">Pricing</a>
            <a href="/about">About</a>
            <a href="/contact">Contact</a>
          </div>
          <div className="mkt-nauth">
            <a className="mkt-btn mkt-btn-ghost" href={LOGIN}>Sign in</a>
            <a className="mkt-btn mkt-btn-primary" href={LOGIN}>Start free</a>
          </div>
        </div>
      </nav>

      <main className="mkt-main"><div className="wrap">{children}</div></main>

      <footer className="mkt-footer">
        <div className="wrap">
          <span>© 2026 Notera Health · Grounded, private, physician-built.</span>
          <nav>
            <a href="/">Home</a><a href="/notera">Product</a><a href="/pricing">Pricing</a>
            <a href="/about">About</a><a href="/contact">Contact</a>
          </nav>
        </div>
      </footer>
    </div>
  )
}

export const Check = () => (
  <svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" /></svg>
)
export { APP_URL, LOGIN }
