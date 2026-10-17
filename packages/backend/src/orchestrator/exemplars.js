// ─────────────────────────────────────────────────────────────────────────────
// Few-shot exemplars: for each consultation, the writer is shown the 1–3 most similar clinician-written
// (transcript → note) pairs from a small curated bank, so it learns THIS clinic's organisation, terseness and what gets
// recorded. Retrieval is plain TF-IDF cosine over content words (no model call, ~1 ms).
// The bank (exemplars/bank.json) excludes every note used for evaluation, so tests never see their own answer.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BANK_FILE = process.env.EXEMPLAR_BANK || path.join(HERE, '..', '..', 'exemplars', 'bank.json');

const STOP = new Set('that this with have from they them were what when your will there their about would could just like know okay yeah right going really because actually thing something good also then than been being into very some more other which where while does done said says well still back take make look want need come feel think'.split(' '));
const toks = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w));

let _idx = null;
function index() {
  if (_idx) return _idx;
  let bank = [];
  try { bank = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8')); } catch { /* no bank → few-shot silently off */ }
  const df = new Map(); const docs = bank.map((b) => { const tf = new Map(); for (const w of toks(b.tx)) tf.set(w, (tf.get(w) || 0) + 1); for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1); return { b, tf }; });
  const N = Math.max(1, docs.length); const idf = (w) => Math.log(1 + N / (1 + (df.get(w) || 0)));
  for (const d of docs) { let n2 = 0; d.vec = new Map(); for (const [w, c] of d.tf) { const v = (1 + Math.log(c)) * idf(w); d.vec.set(w, v); n2 += v * v; } d.norm = Math.sqrt(n2) || 1; }
  _idx = { docs, idf, size: docs.length };
  return _idx;
}
export const exemplarCount = () => index().size;

/** The k most similar bank entries for a transcript → [{ id, tx, note, sim }]. Never throws. */
export function pickExemplars(transcript, k = 2, excludeIds = []) {
  try {
    const { docs, idf } = index(); if (!docs.length || k < 1) return [];
    const q = new Map(); for (const w of toks(transcript)) q.set(w, (q.get(w) || 0) + 1);
    let qn = 0; for (const [w, c] of q) { const v = (1 + Math.log(c)) * idf(w); q.set(w, v); qn += v * v; } qn = Math.sqrt(qn) || 1;
    const ex = new Set(excludeIds);
    return docs.filter((d) => !ex.has(d.b.id)).map((d) => { let dot = 0; for (const [w, v] of q) { const x = d.vec.get(w); if (x) dot += v * x; } return { ...d.b, sim: dot / (qn * d.norm) }; })
      .sort((a, b) => b.sim - a.sim).slice(0, k);
  } catch { return []; }
}

/** The text block placed before the target transcript. */
export function exemplarBlock(list) {
  if (!list.length) return '';
  return `REFERENCE EXAMPLES — notes written by this clinic's clinicians for similar visits. Use them ONLY to learn how a good note is organised, how terse it is, what gets recorded and what is left out. They are DIFFERENT patients: never copy any fact, name, drug, value, date or diagnosis from them.\n\n`
    + list.map((e, i) => `--- EXAMPLE ${i + 1}: TRANSCRIPT ---\n${e.tx}\n--- EXAMPLE ${i + 1}: CLINICIAN'S NOTE ---\n${e.note}\n`).join('\n')
    + `\n=== NOW THE REAL CONSULTATION ===\n\n`;
}
