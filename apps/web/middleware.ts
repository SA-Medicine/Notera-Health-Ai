import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Host-based split (works on Cloudflare Pages / any Next host):
//   aitoolsfordoctor.com/          → public marketing site (/marketing)
//   app.aitoolsfordoctor.com/      → the clinician app (unchanged)
// Only the homepage is rewritten; deeper marketing pages (/notera, /pricing) resolve directly.
export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') || '').toLowerCase()
  const isApex = host === 'aitoolsfordoctor.com' || host === 'www.aitoolsfordoctor.com'
  if (isApex && req.nextUrl.pathname === '/') {
    return NextResponse.rewrite(new URL('/marketing', req.url))
  }
  // monitor.aitoolsfordoctor.com → the admin monitoring dashboard
  if (host.startsWith('monitor.') && req.nextUrl.pathname === '/') {
    return NextResponse.rewrite(new URL('/monitor', req.url))
  }
  return NextResponse.next()
}

export const config = { matcher: ['/'] }
