// Tuning export (experiment track, step 5 of the plan). Builds supervised-tuning files for Vertex AI Gemini from a chosen cohort with a
// frozen date-independent split. It only WRITES FILES: it starts no tuning job, costs nothing, and never touches production.
// A tuned model may be adopted only after the owner unlocks the Style Spec and the gate (gate.js) shows it wins.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { GOLD_DIR, parseGold, poolIds, buildIndex } from './corpus.js';

export const TUNING_SYSTEM = 'You are a clinical scribe. Write the SOAP note for the consultation transcript exactly as the doctor would document it.';

export function exportTuning({ pool = 'recent_style', outDir, goldDir = GOLD_DIR(), limit = 100000 } = {}) {
  const rows = buildIndex(goldDir); const ids = poolIds(rows, pool).slice(0, limit);
  fs.mkdirSync(outDir, { recursive: true });
  const files = { train: [], val: [], test: [] };
  for (const { id, split } of ids) {
    const g = parseGold(fs.readFileSync(path.join(goldDir, id + '.txt'), 'utf8')); if (!g) continue;
    files[split].push(JSON.stringify({ systemInstruction: { role: 'system', parts: [{ text: TUNING_SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: g.transcript }] }, { role: 'model', parts: [{ text: g.note }] }] }));
  }
  for (const [k, lines] of Object.entries(files)) fs.writeFileSync(path.join(outDir, `${pool}.${k}.jsonl`), lines.join('\n') + (lines.length ? '\n' : ''));
  const manifest = { pool, created_at: new Date().toISOString(), counts: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length])),
    note: 'Experiment only. Does not affect production. Vertex AI supervised tuning format (systemInstruction + contents). Train on `train`, tune hyper-parameters on `val`, report only on the frozen `test`.' };
  fs.writeFileSync(path.join(outDir, `${pool}.manifest.json`), JSON.stringify(manifest, null, 2));
  return manifest;
}
