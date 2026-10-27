// Windowed coverage (audit 2026-10-27): the coverage check reads the whole recording in one call. A long recording leaves details out of one call (the fact extractor found the
// same, so it reads windows). This runs the SAME coverage question (askCoverage, unchanged) on overlapping parts of the recording at the same time and merges the answers;
// acceptCoverage then applies the usual checks (exact quote, not already in the note, item limit). Off unless COVERAGE_WINDOWS=1.
'use strict';

import { askCoverage, parseCoverage } from './noteCoverage.js';
import { windowsOf } from './factGraph.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

export async function askCoverageWindowed(llm, note, transcript, opts = {}, { size = 800, overlap = 100, makeLlm = null } = {}) {
  const wins = windowsOf(transcript, { size, overlap });
  if (wins.length < 2) return askCoverage(llm, note, transcript, opts);
  const t0 = Date.now();
  const answers = await Promise.all(wins.map(async (w, i) => askCoverage(i === 0 || !makeLlm ? llm : await makeLlm(), note, w, opts)));
  if (!answers.some((a) => a.raw != null)) return { raw: null, error: answers[0]?.error || 'every window failed', ms: Date.now() - t0 };
  const seen = new Set();
  const items = answers.flatMap((a) => parseCoverage(a.raw)).filter((it) => { const k = norm(it?.text).slice(0, 60); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  return { raw: JSON.stringify({ items }), ms: Date.now() - t0, windows: wins.length };
}
