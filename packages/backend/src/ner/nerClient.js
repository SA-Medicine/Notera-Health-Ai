// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — NER client (calls the private Python NER sidecar, doc 07 §5)
//
// The sidecar is a Cloud Run service reachable only by this backend's service
// account (service-to-service auth via a Google-signed ID token). NER entities do
// double duty: ground Gemini's prompt AND validate its output (doc 06 §1).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const NER_URL = process.env.NER_URL || 'http://localhost:8000';
const USE_IAM = String(process.env.NER_USE_IAM || (process.env.NODE_ENV === 'production')) === 'true';

async function idTokenHeaders() {
  if (!USE_IAM) return { 'Content-Type': 'application/json' };
  // Cloud Run → Cloud Run private call: mint an ID token for the NER audience.
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(NER_URL);
  const headers = await client.getRequestHeaders();
  return { 'Content-Type': 'application/json', ...headers };
}

/**
 * Extract structured medical entities from transcript text.
 * @param {string} text
 * @param {object} opts { timeoutMs }
 * @returns {Promise<Array<{text:string,label:string,start:number,end:number,source:string,negated?:boolean}>>}
 */
// Circuit breaker: when the NER sidecar is down (it was failing 51/51), stop paying a
// connection timeout on every note — after N consecutive failures, skip the call entirely
// for a cooldown window. Set NER_DISABLED=1 to skip it always.
let _consecFail = 0, _openUntil = 0;
const _BREAK_AFTER = Number(process.env.NER_BREAKER_THRESHOLD) || 3;
const _COOLDOWN_MS = Number(process.env.NER_BREAKER_COOLDOWN_MS) || 600000;   // 10 min

export async function extractEntities(text, opts = {}) {
  if (process.env.NER_DISABLED === '1') return [];
  if (Date.now() < _openUntil) return [];                 // breaker open → no network attempt
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || Number(process.env.NER_TIMEOUT_MS) || 8000);
  try {
    const headers = await idTokenHeaders();
    const r = await fetch(`${NER_URL}/ner`, { method: 'POST', headers, body: JSON.stringify({ text }), signal: controller.signal });
    if (!r.ok) throw new Error(`NER sidecar ${r.status}: ${await r.text().catch(() => '')}`);
    const data = await r.json();
    _consecFail = 0;                                       // success resets the breaker
    return data.entities || [];
  } catch (err) {
    if (opts.throwOnError) throw err;
    _consecFail++;
    if (_consecFail >= _BREAK_AFTER && _openUntil < Date.now()) {
      _openUntil = Date.now() + _COOLDOWN_MS;
      console.warn(`[nerClient] circuit OPEN after ${_consecFail} consecutive failures — skipping NER for ${Math.round(_COOLDOWN_MS / 60000)} min (set NER_DISABLED=1 to silence, or fix the sidecar)`);
    }
    console.warn('[nerClient] extraction failed, continuing without entities:', err.message);
    return [];
  } finally { clearTimeout(timer); }
}

/** Format entities as a grounding block for the Gemini prompt (doc 06 §2). */
export function entitiesToGroundingText(entities = []) {
  if (!entities.length) return '';
  const byLabel = {};
  for (const e of entities) {
    const key = e.label || 'OTHER';
    (byLabel[key] ||= new Set()).add(e.negated ? `${e.text} (NEGATED)` : e.text);
  }
  const lines = Object.entries(byLabel).map(([label, set]) => `- ${label}: ${[...set].join(', ')}`);
  return `CONFIRMED FACTS EXTRACTED FROM THE TRANSCRIPT (only assert facts supported by these or the transcript):\n${lines.join('\n')}`;
}
