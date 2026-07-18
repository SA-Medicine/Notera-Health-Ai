// Server-side backend client. Runs ONLY in Next.js server code (route handlers /
// server components) so the service token + PHI never reach the browser (doc 10 §2).
// In prod, swap the bearer token for a Google-signed ID token to call the private
// Cloud Run backend (the backend is not publicly reachable).
import 'server-only';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const TOKEN = process.env.BACKEND_SERVICE_TOKEN || '';

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.NODE_ENV === 'production' && process.env.USE_ID_TOKEN === 'true') {
    // Cloud Run → Cloud Run: mint an ID token for the backend audience.
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth();
    const client = await auth.getIdTokenClient(BACKEND_URL);
    Object.assign(headers, await client.getRequestHeaders());
  } else if (TOKEN) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }
  return headers;
}

export async function backendFetch(path: string, init: RequestInit = {}) {
  const headers = { ...(await authHeaders()), ...(init.headers as Record<string, string> | undefined) };
  const res = await fetch(`${BACKEND_URL}${path}`, { ...init, headers, cache: 'no-store' });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}
