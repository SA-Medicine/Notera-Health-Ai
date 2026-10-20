// Notera Studio site — Cloudflare Worker (static assets + a same-origin proxy to the Google-VM services).
//   /backend/*  -> https://api.aitoolsfordoctor.com/*      (product API: sign-in / sign-out / session)
//   /studio/*   -> <API>/studio/*                          (Studio service; the session is verified with the product API first,
//                                                           then the user's id and role are added together with the secret key)
//   everything else -> static files in ./public
// The doctor signs in with her normal Notera account. The Studio service decides what she may see (reviewer or owner).

const API_ORIGIN = 'https://api.aitoolsfordoctor.com';

const SECURITY_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const withHeaders = (res, extra = {}) => { const h = new Headers(res.headers); for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) h.set(k, v); return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h }); };
const json = (obj, status = 200) => withHeaders(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));

async function proxy(req, origin, path, extra = {}) {
  const url = new URL(req.url);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {                       // CSRF guard: state changes must come from this site
    const o = req.headers.get('Origin');
    if (o && o !== url.origin) return json({ error: 'cross-origin request blocked' }, 403);
  }
  const headers = new Headers(req.headers);
  for (const h of ['host', 'origin', 'referer', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'x-forwarded-proto', 'x-forwarded-for', 'x-studio-key', 'x-studio-user', 'x-studio-role', 'x-studio-name']) headers.delete(h);
  headers.set('X-Forwarded-For', req.headers.get('cf-connecting-ip') || '');
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  const upstream = await fetch(origin + path + url.search, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body, redirect: 'manual' });
  const out = new Headers(upstream.headers);
  const cookies = upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : [];
  if (cookies.length) { out.delete('Set-Cookie'); for (const c of cookies) out.append('Set-Cookie', c.replace(/;\s*Domain=[^;]*/i, '')); }   // host-only cookie
  out.set('Cache-Control', 'no-store');
  return withHeaders(new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out }));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url); const api = env.API_ORIGIN || API_ORIGIN;
    if (url.pathname.startsWith('/backend/')) return proxy(req, api, url.pathname.slice('/backend'.length));
    if (url.pathname.startsWith('/studio/')) {
      if (!env.STUDIO_KEY) return json({ error: 'studio not configured' }, 503);
      const me = await fetch(api + '/api/auth/me', { headers: { Cookie: req.headers.get('Cookie') || '' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!me?.user?.id) return json({ error: 'sign in required' }, 401);
      return proxy(req, api, url.pathname, { 'X-Studio-Key': env.STUDIO_KEY, 'X-Studio-User': String(me.user.id), 'X-Studio-Role': String(me.user.role || 'clinician') });
    }
    const res = await env.ASSETS.fetch(req);
    return withHeaders(res, { 'Cache-Control': url.pathname.match(/\.(js|css)$/) ? 'public, max-age=120' : 'no-cache' });
  },
};
