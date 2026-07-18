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
export async function extractEntities(text, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 30000);
  try {
    const headers = await idTokenHeaders();
    const r = await fetch(`${NER_URL}/ner`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`NER sidecar ${r.status}: ${await r.text().catch(() => '')}`);
    const data = await r.json();
    return data.entities || [];
  } catch (err) {
    // NER is a safety net, not a hard dependency for producing a draft. Degrade
    // gracefully: return no entities so generation still proceeds, but the
    // orchestrator records that the cross-check could not run.
    if (opts.throwOnError) throw err;
    console.warn('[nerClient] extraction failed, continuing without entities:', err.message);
    return [];
  }
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
