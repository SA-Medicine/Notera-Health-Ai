// Notera admin site — Cloudflare Worker (static assets + a thin same-origin proxy to the Google-VM backend).
//
//   /backend/*  → https://api.aitoolsfordoctor.com/*   (product API: auth, console, ops, ASR, note jobs)
//   /lab/*      → env.LAB_ORIGIN/lab/*                 (testing lab on the VM; admin session verified first, then X-Lab-Key added)
//   everything else → static files in ./public
//
// Why a proxy: the browser only ever talks to this origin, so the session cookie stays first-party (no CORS),
// and ALL load (static + API fan-out) lives in this separate Cloudflare account, not on the main website.
// Hardening: state-changing requests must come from this same origin; the API's `Domain=` cookie attribute is
// stripped so the admin session is host-only (never shared with other subdomains); pages are no-index/no-frame.

const API_ORIGIN = 'https://api.aitoolsfordoctor.com';

const SECURITY_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' https://storage.googleapis.com blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function withHeaders(res, extra = {}) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function proxy(req, origin, path, extraReqHeaders = {}) {
  const url = new URL(req.url);
  // CSRF guard: anything that changes state must originate from this site.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const o = req.headers.get('Origin');
    if (o && o !== url.origin) return new Response(JSON.stringify({ error: 'cross-origin request blocked' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  const headers = new Headers(req.headers);
  for (const h of ['host', 'origin', 'referer', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'x-forwarded-proto', 'x-forwarded-for']) headers.delete(h);
  headers.set('X-Forwarded-For', req.headers.get('cf-connecting-ip') || '');
  for (const [k, v] of Object.entries(extraReqHeaders)) headers.set(k, v);
  const upstream = await fetch(origin + path + url.search, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body, redirect: 'manual' });
  const out = new Headers(upstream.headers);
  // Host-only admin cookie: drop the API's Domain attribute.
  const cookies = upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : [];
  if (cookies.length) { out.delete('Set-Cookie'); for (const c of cookies) out.append('Set-Cookie', c.replace(/;\s*Domain=[^;]*/i, '')); }
  out.set('Cache-Control', 'no-store');
  return withHeaders(new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out }));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/backend/')) return proxy(req, env.API_ORIGIN || API_ORIGIN, url.pathname.slice('/backend'.length));
    if (url.pathname.startsWith('/lab/')) {
      if (!env.LAB_ORIGIN || !env.LAB_KEY) return withHeaders(new Response(JSON.stringify({ error: 'lab not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
      // The lab key is only ever attached after the caller proves, to the API itself, that they hold an ADMIN session.
      const me = await fetch((env.API_ORIGIN || API_ORIGIN) + '/api/auth/me', { headers: { Cookie: req.headers.get('Cookie') || '' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (me?.user?.role !== 'admin') return withHeaders(new Response(JSON.stringify({ error: 'admin session required' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
      return proxy(req, env.LAB_ORIGIN, url.pathname, { 'X-Lab-Key': env.LAB_KEY });   // Caddy strips the /lab prefix
    }
    const res = await env.ASSETS.fetch(req);
    return withHeaders(res, { 'Cache-Control': url.pathname.match(/\.(js|css)$/) ? 'public, max-age=300' : 'no-cache' });
  },
};
