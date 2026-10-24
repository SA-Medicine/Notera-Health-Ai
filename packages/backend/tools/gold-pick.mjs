#!/usr/bin/env node
// Picks the reference set from the owner's gold pairs (data/gold: transcript + the doctor's own SOAP note, 2 800 visits).
// A good reference is a pair where the doctor's note is complete AND faithful to the transcript, of a normal visit length:
//   * transcript 300-2 500 words, note 120-600 words, the note has a plan;
//   * faithful: nearly every number in the note is in the transcript, and most of its content words are;
//   * complete: the note is long enough for the transcript (words per 100 transcript words);
//   * varied: at most one pair per topic (the file name's first words), so the set covers different kinds of visit.
// Writes eval/gold-set.json (file names and measures only, no clinical text).   node packages/backend/tools/gold-pick.mjs [count=30]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.REPO_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIR = path.join(ROOT, 'data', 'gold'); const N = Number(process.argv[2]) || 30;
const words = (s) => String(s).toLowerCase().match(/[a-z]{5,}/g) || [];
const nums = (s) => String(s).match(/\b\d+(?:\.\d+)?\b/g) || [];
const rows = [];
for (const f of fs.readdirSync(DIR)) {
  const t = fs.readFileSync(path.join(DIR, f), 'utf8'); const i = t.search(/\n\s*\**Subjective:?\**/i); if (i < 0) continue;
  const tx = t.slice(0, i).replace(/^\s*\d+:\d+\s*$/gm, ' '); const note = t.slice(i);
  const tw = tx.split(/\s+/).filter(Boolean).length, nw = note.split(/\s+/).filter(Boolean).length;
  if (tw < 300 || tw > 2500 || nw < 120 || nw > 600) continue;
  if (!/assessment|plan/i.test(note)) continue;
  const txw = new Set(words(tx)), txn = new Set(nums(tx));
  const nW = words(note), nN = nums(note).filter((n) => !/^(19|20)\d\d$/.test(n));
  const wordGround = nW.length ? nW.filter((w) => txw.has(w)).length / nW.length : 0;
  const numGround = nN.length ? nN.filter((n) => txn.has(n)).length / nN.length : 1;
  const density = nw / tw * 100;
  if (numGround < 0.8 || wordGround < 0.45) continue;
  const score = wordGround * 0.5 + numGround * 0.3 + Math.min(1, density / 25) * 0.2;
  rows.push({ file: f, topic: f.replace(/\.txt$/, '').replace(/^\d[\d-]*-?/, '').split(/[-_ ]/).slice(0, 2).join('-') || f, tw, nw, wordGround: +wordGround.toFixed(2), numGround: +numGround.toFixed(2), score: +score.toFixed(3) });
}
rows.sort((a, b) => b.score - a.score);
const seen = new Set(); const pick = [];
for (const r of rows) { if (seen.has(r.topic)) continue; seen.add(r.topic); pick.push(r); if (pick.length >= N) break; }
fs.mkdirSync(path.join(ROOT, 'eval'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'eval', 'gold-set.json'), JSON.stringify({ made: new Date().toISOString().slice(0, 10), candidates: rows.length, rule: 'transcript 300-2500 words, note 120-600, has a plan, numbers >=80% and words >=45% found in the transcript, one per topic, best score', pairs: pick }, null, 1));
console.log(`${rows.length} pairs pass the filters; picked ${pick.length}. Transcript words ${Math.min(...pick.map((p) => p.tw))}-${Math.max(...pick.map((p) => p.tw))}; topics: ${pick.map((p) => p.topic).join(', ')}`);
