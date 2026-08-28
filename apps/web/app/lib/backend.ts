// Server-side backend client. Runs ONLY in Next.js server code (route handlers /
// server components) so the service token + PHI never reach the browser (doc 10 §2).
// In prod, swap the bearer token for a Google-signed ID token to call the private
// Cloud Run backend (the backend is not publicly reachable).
import 'server-only';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const TOKEN = process.env.BACKEND_SERVICE_TOKEN || '';

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // We reach the backend over HTTPS via Cloudflare and authenticate with a shared service
  // token (BACKEND_SERVICE_TOKEN on the frontend must match SERVICE_TOKENS on the backend).
  // (The old Cloud Run ID-token path is removed — we don't use Cloud Run.)
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
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
