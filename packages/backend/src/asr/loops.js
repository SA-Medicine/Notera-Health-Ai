// A speech model sometimes falls into a loop and writes the same few words thousands of times ("Yeah. Yeah. Yeah. ..." 8 000 times in one 11-minute
// recording, so 839 words a minute). A real conversation never repeats the same phrase six times in a row. This finds such runs and keeps two copies.
'use strict';

const key = (w) => w.toLowerCase().replace(/[^a-z0-9']+/g, '');

/** { text, collapsed: [{ unit, reps }] }: any run of one to eight words repeated `minRepeats`+ times in a row is cut down to `keep` copies. */
export function collapseLoops(text, { minRepeats = 6, maxUnit = 8, keep = 2 } = {}) {
  const w = String(text || '').split(/\s+/).filter(Boolean); const k = w.map(key); const out = []; const collapsed = [];
  const same = (a, b, n) => { for (let j = 0; j < n; j++) if (k[a + j] !== k[b + j]) return false; return true; };
  for (let i = 0; i < w.length;) {
    let hit = false;
    for (let n = 1; n <= maxUnit; n++) {
      if (i + n * minRepeats > w.length) break;
      let reps = 1; while (i + (reps + 1) * n <= w.length && same(i, i + reps * n, n)) reps++;
      if (reps >= minRepeats) { for (let r = 0; r < keep; r++) out.push(...w.slice(i, i + n)); collapsed.push({ unit: w.slice(i, i + n).join(' '), reps }); i += reps * n; hit = true; break; }
    }
    if (!hit) out.push(w[i++]);
  }
  return { text: out.join(' '), collapsed };
}
