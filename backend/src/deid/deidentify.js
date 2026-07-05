// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — De-identification / re-identification (doc 02 §5, 04)
//
// ⚠️ COMPLIANCE-CRITICAL. The AI Studio Gemini endpoint is NOT BAA-covered, so we
// MUST NOT send raw PHI to it. Flow:
//   1. deidentify(text)  → replaces PHI with stable tokens, returns { text, map }
//   2. Gemini writes the note from the DE-IDENTIFIED text
//   3. reidentify(note, map) → puts real identifiers back, inside our own systems
//
// `map` (the deidMap) is the most sensitive object in the system — it is stored in
// a tightly-restricted Firestore collection / Secret Manager, never sent to Gemini
// (doc 09 §6). When LLM_BACKEND=vertex (BAA), de-id can be skipped for the LLM hop.
//
// This is a deterministic, dependency-free redactor for the common HIPAA-18
// identifier classes. For production, back it with the NER sidecar's PERSON/DATE/ID
// entities and/or a dedicated de-id model; the interface here stays the same.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import crypto from 'node:crypto';

// Pseudonym pools for consistent-pseudonymization mode (keeps phrasing natural).
const FAKE_FIRST = ['Alex', 'Jordan', 'Sam', 'Taylor', 'Casey', 'Morgan', 'Riley', 'Jamie'];
const FAKE_LAST = ['Rivera', 'Chen', 'Okafor', 'Novak', 'Haddad', 'Silva', 'Brooks', 'Ahmed'];

const PATTERNS = [
  // Order matters — most specific first.
  { type: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'PHONE', re: /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g },
  { type: 'MRN', re: /\b(?:MRN|mrn|Medical Record(?: Number)?)[:#\s]*([A-Z0-9-]{4,})\b/g },
  { type: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'DOB', re: /\b(?:DOB|D\.O\.B\.|Date of Birth)[:\s]*\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/gi },
  { type: 'DATE', re: /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g },
  { type: 'ZIP', re: /\b\d{5}(?:-\d{4})?\b/g },
  { type: 'ID', re: /\b(?:ID|Id)[:#\s]*([A-Z0-9-]{5,})\b/g },
];

// Age > 89 is PHI under HIPAA safe harbor.
const AGE_RE = /\b(9\d|1\d{2})\s*(?:years?[- ]old|yo|y\/o|years? of age)\b/gi;

// "Mr./Ms./Dr. Lastname" and "Firstname Lastname" heuristics for names.
const TITLE_NAME_RE = /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?\b/g;

/**
 * @param {string} text
 * @param {object} opts
 * @param {'redact'|'pseudonymize'} opts.mode  redact = [TOKEN]; pseudonymize = fake-but-consistent
 * @param {string[]} opts.nameHints  known names (e.g. from NER PERSON) to redact explicitly
 * @returns {{ text: string, map: Record<string,{type:string, original:string}> }}
 */
export function deidentify(text, opts = {}) {
  const mode = opts.mode || 'redact';
  const nameHints = opts.nameHints || [];
  let out = String(text || '');
  const map = {};              // token -> { type, original }
  const seen = new Map();      // original -> token (stable within a document)
  let counters = {};

  const mint = (type, original) => {
    if (seen.has(original)) return seen.get(original);
    counters[type] = (counters[type] || 0) + 1;
    const token = mode === 'pseudonymize' && type === 'NAME'
      ? pseudoName(original)
      : `[${type}_${counters[type]}]`;
    seen.set(original, token);
    map[token] = { type, original };
    return token;
  };

  // 1. explicit name hints from NER (most reliable)
  for (const name of nameHints) {
    if (!name || name.length < 2) continue;
    const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'g');
    out = out.replace(re, (m) => mint('NAME', m));
  }

  // 2. titled / bare names
  out = out.replace(TITLE_NAME_RE, (m) => mint('NAME', m));

  // 3. ages > 89
  out = out.replace(AGE_RE, (m) => mint('AGE', m));

  // 4. structured identifiers
  for (const { type, re } of PATTERNS) {
    out = out.replace(re, (m) => mint(type, m));
  }

  return { text: out, map };
}

/**
 * Put real identifiers back into a generated note (string or object).
 * Runs INSIDE our systems, after generation (doc 04). Object inputs are walked
 * recursively so schema-shaped notes re-identify field-by-field.
 */
export function reidentify(value, map) {
  if (!map || Object.keys(map).length === 0) return value;
  const tokens = Object.keys(map).sort((a, b) => b.length - a.length); // longest first
  const restore = (s) => {
    let r = s;
    for (const t of tokens) r = r.split(t).join(map[t].original);
    return r;
  };
  const walk = (v) => {
    if (typeof v === 'string') return restore(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  return walk(value);
}

/** Opaque, non-reversible hash of the deidMap key material — safe to log/audit. */
export function mapFingerprint(map) {
  const material = Object.entries(map).map(([t, v]) => `${t}:${v.original}`).sort().join('|');
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function pseudoName(original) {
  const h = crypto.createHash('md5').update(original).digest();
  return `${FAKE_FIRST[h[0] % FAKE_FIRST.length]} ${FAKE_LAST[h[1] % FAKE_LAST.length]}`;
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
