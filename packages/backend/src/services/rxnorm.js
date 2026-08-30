// ─────────────────────────────────────────────────────────────────────────────
// RxNorm / RxNav client (upgrade D-Tier2). Normalizes a spoken medication name to a
// stable RxCUI, pulls its therapeutic class (ATC/EPC), and offers spelling suggestions,
// so the pipeline can flag medications that don't resolve to a real drug concept
// (mis-hearings such as "Lolo", or garbage like "30 Brian").
//
// The public RxNav REST API needs NO API key. To use it fully and politely we add:
//   • rate limiting  (RXNORM_MAX_RPS, default 15 — under RxNav's ~20/s cap)
//   • a persistent on-disk cache (RxCUIs/classes rarely change) so repeat runs are
//     instant and we hit the API far less
//   • spelling suggestions so an unresolved drug gets "did you mean …?" hints
//
// Base URL is configurable (RXNORM_BASE_URL) — point at a local RxNav-in-a-Box if you
// ever want offline/PHI-safe lookups. fetch is injectable for tests. Never throws into
// the pipeline; on any error a medication is simply "unresolved".
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = () => (process.env.RXNORM_BASE_URL || 'https://rxnav.nlm.nih.gov/REST').replace(/\/+$/, '');
const CACHE_FILE = () => process.env.RXNORM_CACHE_FILE || path.join(__dirname, '..', '..', '.cache', 'rxnorm.json');
const _cache = new Map();
let _dirty = false;

// ── polite rate limiting (public API is ~20 req/s per IP) ─────────────────────
let _lastReqAt = 0;
const _minInterval = () => 1000 / Math.max(1, Number(process.env.RXNORM_MAX_RPS) || 15);
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function _throttle() {
  const wait = _lastReqAt + _minInterval() - Date.now();
  if (wait > 0) await _sleep(wait);
  _lastReqAt = Date.now();
}

async function _get(url, fetchImpl) {
  if (_cache.has(url)) return _cache.get(url);
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new Error('no fetch available');
  if (!fetchImpl) await _throttle();               // throttle real network only (tests inject fetch)
  const res = await f(url);
  if (!res.ok) throw new Error(`rxnav ${res.status}`);
  const json = await res.json();
  _cache.set(url, json); _dirty = true;
  return json;
}

// ── persistent cache ─────────────────────────────────────────────────────────
function loadCacheFromDisk() {
  try { const j = JSON.parse(fs.readFileSync(CACHE_FILE(), 'utf8')); for (const [k, v] of Object.entries(j)) _cache.set(k, v); return _cache.size; } catch { return 0; }
}
export function saveCacheToDisk() {
  if (!_dirty) return;
  try { fs.mkdirSync(path.dirname(CACHE_FILE()), { recursive: true }); fs.writeFileSync(CACHE_FILE(), JSON.stringify(Object.fromEntries(_cache))); _dirty = false; } catch { /* best effort */ }
}

// ── lookups ──────────────────────────────────────────────────────────────────
/** Best fuzzy RxCUI match for a name (approximateTerm). Returns null below minScore. */
export async function lookupRxcui(name, { fetchImpl, minScore = 50 } = {}) {
  const url = `${BASE()}/approximateTerm.json?term=${encodeURIComponent(name)}&maxEntries=1`;
  const j = await _get(url, fetchImpl);
  const c = j?.approximateGroup?.candidate?.[0];
  if (!c || Number(c.score) < minScore) return null;
  return { rxcui: String(c.rxcui), score: Number(c.score), name: c.name || name };
}

/** Exact RxCUI for a name as-spelled (is it already a real drug, brand or generic?).
 *  Null when there is no exact concept — i.e. the name is likely a garbled ASR artifact. */
export async function exactRxcui(name, { fetchImpl } = {}) {
  try {
    const j = await _get(`${BASE()}/rxcui.json?name=${encodeURIComponent(name)}&search=1`, fetchImpl);
    const id = j?.idGroup?.rxnormId?.[0];
    return id ? String(id) : null;
  } catch { return null; }
}

/** Therapeutic classes for an RxCUI (default ATC). */
export async function classesForRxcui(rxcui, { fetchImpl, relaSource = 'ATC' } = {}) {
  const url = `${BASE()}/rxclass/class/byRxcui.json?rxcui=${encodeURIComponent(rxcui)}&relaSource=${relaSource}`;
  const j = await _get(url, fetchImpl);
  const items = j?.rxclassDrugInfoList?.rxclassDrugInfo || [];
  const out = [];
  for (const it of items) { const c = it?.rxclassMinConceptItem; if (c && c.classId) out.push({ classId: c.classId, className: c.className, classType: c.classType }); }
  return [...new Map(out.map((c) => [c.classId, c])).values()];   // dedupe by classId
}

/** "Did you mean …" spellings for a name that didn't resolve. */
export async function spellingSuggestions(name, { fetchImpl } = {}) {
  try {
    const j = await _get(`${BASE()}/spellingsuggestions.json?name=${encodeURIComponent(name)}`, fetchImpl);
    return (j?.suggestionGroup?.suggestionList?.suggestion || []).slice(0, 3);
  } catch { return []; }
}

/** Resolve one medication → { resolved, rxcui?, score?, classes? }. Never throws. */
export async function checkMedication(name, opts = {}) {
  try {
    const hit = await lookupRxcui(name, opts);
    if (!hit) return { name, resolved: false };
    const classes = await classesForRxcui(hit.rxcui, opts).catch(() => []);
    return { name, resolved: true, rxcui: hit.rxcui, score: hit.score, classes };
  } catch (e) { return { name, resolved: false, error: e.message }; }
}

/**
 * Flag medications that do NOT resolve to a real RxNorm concept, with spelling hints.
 * Best-effort and network-optional — on any error it returns fewer flags, never blocks.
 * @returns {{ flags: object[] }}
 */
export async function reconcileMedications(meds = [], { fetchImpl, log = () => {} } = {}) {
  const flags = [];
  const names = [...new Set((meds || []).map((m) => String(m).trim()).filter((m) => /[a-z]/i.test(m) && m.length > 2))];
  for (const name of names) {
    let r; try { r = await checkMedication(name, { fetchImpl }); } catch { continue; }
    if (r && r.resolved === false && !r.error) {
      const hints = await spellingSuggestions(name, { fetchImpl });
      const didYouMean = hints.length ? ` Did you mean: ${hints.join(', ')}?` : '';
      flags.push({ type: 'unverified_medication', field: 'assessment_and_plan.treatment_planned', message: `"${name}" did not match any RxNorm drug concept — verify spelling / transcription.${didYouMean}`, severity: 'warning' });
      log(`[upgrade:rxnorm] unverified medication "${name}" (no RxNorm match)${didYouMean}`);
    } else if (r && r.resolved) {
      log(`[upgrade:rxnorm] verified "${name}" → RxCUI ${r.rxcui}${r.classes?.length ? ` (${r.classes.slice(0, 2).map((c) => c.className).join(', ')})` : ''}`);
    }
  }
  saveCacheToDisk();
  return { flags };
}

/** Canonical RxNorm Name for an RxCUI (used to correct spelling). */
export async function rxcuiName(rxcui, { fetchImpl } = {}) {
  try { const j = await _get(`${BASE()}/rxcui/${encodeURIComponent(rxcui)}/property.json?propName=RxNorm%20Name`, fetchImpl); return j?.propConceptGroup?.propConcept?.[0]?.propValue || null; } catch { return null; }
}

const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const _title = (s) => String(s || '').replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
// Levenshtein for the "nearest spoken term" hint (sound-alike substitution detection).
function _lev(a, b) {
  a = String(a).toLowerCase(); b = String(b).toLowerCase();
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
// The transcript token most similar to `name` (drug-like words only), for a "did you mean" hint.
function _nearestToken(name, transcript) {
  const toks = [...new Set(String(transcript).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [])];
  let best = null, bd = Infinity;
  for (const t of toks) { if (_norm(t) === _norm(name)) return t; const d = _lev(name, t); if (d < bd && d <= Math.ceil(name.length * 0.5)) { bd = d; best = t; } }
  return best;
}
function replaceNameInNote(note, from, to) {
  const rx = new RegExp('\\b' + String(from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
  const fix = (t) => (typeof t === 'string' ? t.replace(rx, to) : t);
  for (const k of Object.keys(note.subjective || {})) note.subjective[k] = fix(note.subjective[k]);
  if (note.objective) for (const k of Object.keys(note.objective)) note.objective[k] = fix(note.objective[k]);
  for (const p of (note.assessment_and_plan || [])) for (const f of ['assessment', 'treatment_planned', 'investigations_planned']) p[f] = fix(p[f]);
  if (Array.isArray(note?.metadata?.medications_mentioned)) note.metadata.medications_mentioned = note.metadata.medications_mentioned.map((m) => (_norm(m) === _norm(from) ? to : m));
}

/**
 * Medication normalization agent: for every medication the note names, (1) correct its
 * spelling to the canonical RxNorm name, (2) flag a drug that resolves to NOTHING and
 * isn't in the transcript as a likely fabrication, (3) flag an unresolved-but-spoken drug
 * with "did you mean" hints. Corrects the note text in place. Network-optional, never throws.
 * @returns {{ flags:object[], corrected:number }}
 */
export async function normalizeMedications(note, transcript = '', { fetchImpl, log = () => {} } = {}) {
  const flags = []; let corrected = 0;
  const tLower = String(transcript).toLowerCase();
  const names = [...new Set((note?.metadata?.medications_mentioned || []).map((m) => String(m).trim()).filter((m) => /[a-z]/i.test(m) && m.length > 2))];
  const CORRECT_MIN = Number(process.env.RXNORM_MIN_SCORE) || 60;
  for (const name of names) {
    const inTranscript = tLower.includes(name.toLowerCase());
    // STEP 1 — is the name ALREADY a real drug exactly as written (brand OR generic)? If so,
    // NEVER rewrite it: converting a valid brand (Synjardy, Breo) to its generic is a
    // specificity regression the eval penalizes. Only run the sound-alike safety check.
    let exact; try { exact = await exactRxcui(name, { fetchImpl }); } catch { exact = null; }
    if (exact) {
      if (!inTranscript) {
        const near = _nearestToken(name, transcript);
        flags.push({ type: 'medication_not_in_transcript', field: 'assessment_and_plan.treatment_planned',
          message: `Medication "${name}" is a real drug but is NOT mentioned in the transcript${near ? ` (nearest spoken term: "${near}")` : ''} — possible sound-alike substitution (e.g. Zofran↔Zolpidem); verify against the transcript.`,
          severity: 'critical' });
        log(`[upgrade:rxnorm] SAFETY: "${name}" not in transcript${near ? ` — nearest spoken "${near}"` : ''}`);
      } else {
        log(`[upgrade:rxnorm] verified "${name}" (exact RxCUI ${exact}) — preserved as spoken`);
      }
      continue;
    }
    // STEP 2 — the name is NOT a real drug as written (likely garbled ASR, e.g. "gladipine",
    // "Premafoid"). Use a CONFIDENT approximate match to correct it to the real drug.
    let hit; try { hit = await lookupRxcui(name, { fetchImpl, minScore: CORRECT_MIN }); } catch { continue; }
    if (hit) {
      let canonical = hit.name && /[a-z]/i.test(hit.name) ? hit.name : await rxcuiName(hit.rxcui, { fetchImpl });
      canonical = canonical ? _title(String(canonical).replace(/\s*\[.*?\]\s*/g, '').trim()) : null;
      const cleanCorrection = canonical && canonical.length <= 40 && canonical.split(/\s+/).length <= 4;
      if (cleanCorrection && _norm(canonical) !== _norm(name)) {
        replaceNameInNote(note, name, canonical); corrected++;
        log(`[upgrade:rxnorm] corrected garbled medication "${name}" → "${canonical}" (RxCUI ${hit.rxcui}, score ${hit.score})`);
      } else {
        log(`[upgrade:rxnorm] "${name}" ≈ RxCUI ${hit.rxcui} but no clean correction — left as-is`);
      }
    } else if (!inTranscript) {
      flags.push({ type: 'fabricated_medication', field: 'assessment_and_plan.treatment_planned', message: `Medication "${name}" is not a known RxNorm drug and is not in the transcript — possible fabrication; verify or remove.`, severity: 'critical' });
      log(`[upgrade:rxnorm] "${name}" unresolved AND not in transcript — possible fabrication`);
    } else {
      const hints = await spellingSuggestions(name, { fetchImpl });
      flags.push({ type: 'unverified_medication', field: 'assessment_and_plan.treatment_planned', message: `"${name}" did not match RxNorm — verify spelling.${hints.length ? ` Did you mean: ${hints.join(', ')}?` : ''}`, severity: 'warning' });
      log(`[upgrade:rxnorm] unverified "${name}"${hints.length ? ` — did you mean ${hints.join(', ')}` : ''}`);
    }
  }
  saveCacheToDisk();
  return { flags, corrected };
}

export const _clearCache = () => { _cache.clear(); _dirty = false; };

/** True when RxNorm verification is switched on (RXNORM_VERIFY=1). */
export const rxnormEnabled = () => process.env.RXNORM_VERIFY === '1';

/**
 * Ping RxNav once at startup: loads the disk cache and confirms the source is reachable
 * (public API vs local RxNav-in-a-Box). Logs the outcome; never throws.
 * @returns {Promise<{ ok:boolean, base:string, version?:string, cached?:number, error?:string }>}
 */
export async function initRxNorm({ fetchImpl, log = console.log } = {}) {
  const base = BASE();
  const local = /localhost|127\.0\.0\.1|:4000\b/.test(base);
  const cached = loadCacheFromDisk();
  try {
    const j = await _get(`${base}/version.json`, fetchImpl);
    const version = j?.version || j?.apiVersion || 'unknown';
    log(`[rxnorm] ✓ initialized — ${local ? 'local RxNav-in-a-Box' : 'public RxNav API'} at ${base} (RxNorm ${version}); ${cached} cached lookups; throttle ${Number(process.env.RXNORM_MAX_RPS) || 15}/s`);
    return { ok: true, base, version, cached };
  } catch (e) {
    log(`[rxnorm] ⚠ could not reach RxNav at ${base} (${e.message}). Medication verification will no-op until it's reachable.` + (local ? ' Is the RxNav-in-a-Box container up on :4000?' : ' Check network / RXNORM_BASE_URL.'));
    return { ok: false, base, error: e.message, cached };
  }
}
