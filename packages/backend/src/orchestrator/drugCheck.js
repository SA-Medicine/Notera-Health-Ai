// Drug check (owner, 2026-10-24: "use the API where it can fetch the drug name fast"; "a box below the note so the doctor can fix the drug name fast").
// Every medicine named in the finished note is checked against RxNorm (the NIH drug database, public API, no key):
//   * NAME   is it a real drug name? The full RxNorm name list (28 000 brand and generic names) is downloaded once and kept on disk, so the check is
//            instant. A name RxNorm does not know (a misheard "cand") is matched against what was actually said around it: "at a cand" joined is
//            "atacand", a real drug, so "Atacand" is offered. A patient's own medication list (from the EHR, when given) is tried first.
//   * DOSE   does the dose exist? RxNorm lists the strengths a drug is sold in (amlodipine: 2.5, 5, 10 mg). "Amlodipine 200 mg" is flagged.
// Nothing in the note is changed. The result is (a) "Check drug name" / "Check the dose" flags the clinician resolves in one click, and (b) one
// review row per drug for the medicines box under the note. Network failures only mean fewer checks. Off switch: DRUG_CHECK=0.
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exactRxcui } from '../services/rxnorm.js';

const BASE = () => (process.env.RXNORM_BASE_URL || 'https://rxnav.nlm.nih.gov/REST').replace(/\/+$/, '');
const LEX_FILE = () => process.env.RXNORM_LEXICON_FILE || path.join(os.tmpdir(), 'notera-rxnorm-displaynames.json');
const GENERIC = new Set('medication medications medicine medicines pill pills tablet tablets drug drugs supplement supplements cream ointment drops spray inhaler injection shot vaccine blood pressure the his her their new current same other dose doses daily twice once sugar cholesterol thyroid pain water iron vitamin'.split(' '));
const collapse = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

let LEX = null;   // { set: Set<collapsed name>, byLen: Map<len, string[]>, display: Map<collapsed, name> }
export function buildLexicon(names) {
  const set = new Set(); const byLen = new Map(); const display = new Map();
  for (const n of names || []) {
    const s = String(n).trim(); if (!/^[a-z][a-z0-9 \-]{2,28}$/i.test(s) || s.split(' ').length > 3) continue;
    const c = collapse(s); if (c.length < 4 || set.has(c)) continue;
    set.add(c); display.set(c, s); if (!byLen.has(c.length)) byLen.set(c.length, []); byLen.get(c.length).push(c);
  }
  return { set, byLen, display };
}
export async function loadLexicon({ fetchImpl, log = () => {} } = {}) {
  if (LEX) return LEX;
  try { LEX = buildLexicon(JSON.parse(fs.readFileSync(LEX_FILE(), 'utf8'))); if (LEX.set.size > 1000) return LEX; } catch { /* not cached yet */ }
  try {
    const f = fetchImpl || fetch; const r = await f(`${BASE()}/displaynames.json`, { signal: AbortSignal.timeout(20000) }); const j = await r.json();
    const names = j?.displayTermsList?.term || []; LEX = buildLexicon(names);
    try { fs.writeFileSync(LEX_FILE(), JSON.stringify(names)); } catch { /* cache is optional */ }
    log(`[v2:drugs] RxNorm name list loaded (${LEX.set.size} names)`);
  } catch (e) { log(`[v2:drugs] RxNorm name list unavailable — ${String(e.message).slice(0, 80)}`); LEX = buildLexicon([]); }
  return LEX;
}
export function setLexicon(names) { LEX = buildLexicon(names); return LEX; }

function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m; let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
/** Nearest real drug name to a spoken string, or null. */
export function nearest(lex, s, { maxRatio = 0.25 } = {}) {
  const c = collapse(s); if (c.length < 4) return null; if (lex.set.has(c)) return { name: lex.display.get(c), dist: 0 };
  let best = null; const maxD = Math.max(1, Math.floor(c.length * maxRatio));
  for (let L = c.length - maxD; L <= c.length + maxD; L++) for (const w of lex.byLen.get(L) || []) { const d = lev(c, w); if (d <= maxD && (!best || d < best.dist)) best = { name: lex.display.get(w), dist: d }; }
  return best;
}

/** The words just before a term where it was said ("at a cand" for "cand"), joined: the transcript often splits one drug name into several words. */
export function spokenVariants(term, transcript) {
  const t = norm(transcript).split(' '); const k = norm(term).split(' ').filter(Boolean); const out = new Set(); if (!k.length) return [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== k[0]) continue;
    for (let back = 1; back <= 2; back++) if (i - back >= 0) out.add(t.slice(i - back, i + k.length).join(' '));
    if (i + k.length < t.length) out.add(t.slice(i, i + k.length + 1).join(' '));
  }
  return [...out];
}

/** The medicine names the note gives: the Medications line and the treatment sub-points, cut before the dose. */
export function drugsInNote(md) {
  const out = []; const add = (raw, line) => {
    const lead = String(raw).replace(/\(.*?\)/g, ' ').split(/\s+\d|\s+(?:for|to|at|in|with|as|once|twice|daily|every|nightly|prn|orally|po|bid|tid|qhs)\b/i)[0].trim();
    const words = lead.split(/\s+/).filter((w) => /^[a-z][a-z-]+$/i.test(w) && !GENERIC.has(w.toLowerCase())).slice(0, 2);
    if (words.length) out.push({ term: words.join(' '), line: line.trim() });
  };
  for (const raw of String(md || '').split('\n')) {
    const l = raw.replace(/^\s*[-*]\s*/, '');
    const meds = l.match(/^Medications?:\s*(.*)$/i); if (meds) { for (const p of meds[1].split(/,\s*/)) add(p, raw); continue; }
    const sub = l.match(/^(Started|Changed|Stopped|Continued):\s*(.*)$/); if (sub) { add(sub[2].replace(/^(increase|decrease|reduce|switch)\w*\s+/i, ''), raw); continue; }
    const tx = l.match(/^Treatment planned:\s*(.+)$/); if (tx) for (const p of tx[1].split(/;\s*/)) if (/^(start|stop|continue|increase|decrease|refill|renew|prescri|take)\w*\s/i.test(p)) add(p.replace(/^\w+\s+/, ''), raw);
  }
  const seen = new Set(); return out.filter((d) => { const k = collapse(d.term); if (seen.has(k)) return false; seen.add(k); return true; });
}

const STRENGTH_CACHE = new Map();
/** Strengths a drug is sold in, in mg / mcg, from RxNorm's clinical drug names ("amlodipine 5 MG Oral Tablet"). */
export async function strengthsOf(name, { fetchImpl } = {}) {
  const key = collapse(name); if (STRENGTH_CACHE.has(key)) return STRENGTH_CACHE.get(key);
  let out = [];
  try {
    const rxcui = await exactRxcui(name, { fetchImpl }); if (rxcui) {
      const f = fetchImpl || fetch; const r = await f(`${BASE()}/rxcui/${rxcui}/related.json?tty=SCD+SBD`, { signal: AbortSignal.timeout(8000) }); const j = await r.json();
      const names = (j?.relatedGroup?.conceptGroup || []).flatMap((g) => (g.conceptProperties || []).map((c) => c.name)).filter((n) => !n.includes(' / '));
      const s = new Set(); for (const n of names) { const m = n.match(/(\d+(?:\.\d+)?)\s*(MG|MCG)\b/); if (m) s.add(`${Number(m[1])} ${m[2].toLowerCase()}`); }
      out = [...s];
    }
  } catch { out = []; }
  STRENGTH_CACHE.set(key, out); return out;
}
/** Is a stated dose one the drug comes in (or 2-4 of one tablet)? */
export function doseOk(dose, unit, strengths) {
  if (!strengths.length) return true; const vals = strengths.filter((s) => s.endsWith(' ' + unit)).map((s) => Number(s.split(' ')[0])); if (!vals.length) return true;
  return vals.some((v) => [1, 2, 3, 4].some((k) => Math.abs(v * k - dose) < 1e-6) || Math.abs(v / 2 - dose) < 1e-6);
}

export async function checkDrugs(md, transcript, { log = () => {}, patientMeds = [], fetchImpl, lexicon } = {}) {
  const lex = lexicon || (await loadLexicon({ fetchImpl, log })); const review = []; const flags = [];
  const patient = (patientMeds || []).map((m) => String(m).trim()).filter(Boolean); const patientLex = buildLexicon(patient.map((m) => m.split(/\s+\d/)[0].trim()));   // "Seroquel 50 mg" -> "Seroquel"
  for (const d of drugsInNote(md)) {
    const words = d.term.split(' '); const known = lex.set.has(collapse(d.term)) || lex.set.has(collapse(words[0])) || patientLex.set.has(collapse(words[0]));
    const row = { name: d.term, line: d.line, verified: known, suggestion: '', dose: '', strengths: [], doseOk: true, source: known ? 'RxNorm' : '' };
    if (!known && lex.set.size) {
      const variants = [d.term, ...spokenVariants(words[0], transcript)];
      let best = null;
      for (const v of variants) { const p = nearest(patientLex, v, { maxRatio: 0.35 }); if (p && (!best || p.dist < best.dist)) best = { ...p, from: 'the patient\'s medication list' }; }
      if (!best) for (const v of variants) { const n = nearest(lex, v); if (n && (!best || n.dist < best.dist)) best = { ...n, from: 'RxNorm' }; }
      if (best && collapse(best.name) !== collapse(d.term)) { row.suggestion = best.name.replace(/^./, (c) => c.toUpperCase()); row.source = best.from; }
      flags.push({ type: 'medication_unverified', field: 'medications', severity: 'warning',
        message: row.suggestion ? `Heard "${words[0]}" — not a drug name RxNorm knows; closest drug said in the visit (${row.source}): had written "${row.suggestion}"` : `Heard "${words[0]}" — not a drug name RxNorm knows. Type the drug you prescribed.` });
    }
    const dm = d.line.match(new RegExp(words[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^;\\n]{0,40}?(\\d+(?:\\.\\d+)?)\\s*(mg|mcg|milligrams?|micrograms?)\\b', 'i'));
    if (dm && (known || row.suggestion)) {
      const dose = Number(dm[1]); const unit = /^mc|^micro/i.test(dm[2]) ? 'mcg' : 'mg'; row.dose = `${dose} ${unit}`;
      row.strengths = await strengthsOf(row.suggestion || d.term, { fetchImpl });
      row.doseOk = doseOk(dose, unit, row.strengths);
      if (!row.doseOk) flags.push({ type: 'dose_check', field: 'medications', severity: 'warning', message: `"${d.line.replace(/^\s*[-*]\s*/, '').trim()}" - ${row.suggestion || d.term} is not sold as ${dose} ${unit} (RxNorm strengths: ${row.strengths.join(', ')}). Check the dose.` });
    }
    review.push(row);
  }
  if (review.length) log(`[v2:drugs] ${review.length} medicine(s): ${review.filter((r) => r.verified).length} known to RxNorm, ${review.filter((r) => r.suggestion).length} with a suggested name, ${review.filter((r) => !r.doseOk).length} dose(s) to check`);
  return { review, flags };
}
