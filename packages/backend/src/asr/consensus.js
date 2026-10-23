// Two engines, one transcript. Chirp 2 and Gemini are different kinds of model, so they rarely make the same mistake. Aligned word by word:
//   SWAP  where Chirp wrote an ordinary word and the other engine wrote a MEDICAL word that sounds alike ("class" / "calf", "uncle" / "ankles",
//         "light headache" is not 1:1 and is left alone), the medical word is used. Only words in the medical vocabulary can replace anything,
//         and only for a word that is not itself a medical word or a plain function word, so the check cannot rewrite ordinary speech.
//   FILL  where the other engine heard a run of at least `minFill` words that Chirp has nothing for (a sentence dropped in crosstalk or at a cut),
//         the run is added at that place.
// Pure code, no model call. The result is a transcript; every swap and fill is returned so it can be logged (never the text itself).
'use strict';

import { MEDICAL_TERMS } from './medicalVocab.js';

const STOP = new Set(`a an and are as at be but by can did do does for from had has have he her him his how i if in is it its me my no not of on or our she so than that the their them then there they this to too us was we were what when where which who why will with would you your yes yeah okay mm uh um oh well just like very really`.split(/\s+/));
const core = (tok) => String(tok).toLowerCase().replace(/[^a-z0-9']/g, '');
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
export const similarity = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

/** Word-level edit script between two token lists. ops: [type, i, j] with type m (match), s (substitute), d (only in A), i (only in B). */
export function alignTokens(A, B) {
  const n = A.length, m = B.length;
  const d = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i; for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
  const ops = []; let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)) { ops.push([A[i - 1] === B[j - 1] ? 'm' : 's', i - 1, j - 1]); i--; j--; }
    else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { ops.push(['d', i - 1, -1]); i--; } else { ops.push(['i', -1, j - 1]); j--; }
  }
  return ops.reverse();
}

/** Puts the new word into the old token's punctuation and capitalisation. */
function carry(oldTok, newTok) {
  const m = String(oldTok).match(/^([^A-Za-z0-9']*)(.*?)([^A-Za-z0-9']*)$/); const lead = m ? m[1] : ''; const trail = m ? m[3] : ''; const body = m ? m[2] : oldTok;
  const nb = String(newTok).replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '');
  return lead + (/^[A-Z]/.test(body) ? nb[0].toUpperCase() + nb.slice(1) : nb) + trail;
}

export function shouldSwap(a, b, terms = MEDICAL_TERMS) {
  return b.length >= 4 && a.length >= 3 && terms.has(b) && !terms.has(a) && !STOP.has(a) && similarity(a, b) >= 0.3;
}

/**
 * → { text, swaps: [{ from, to }], fills: [number of words] }
 * A fill is only made between two stretches both engines agree on (at least 2 matching words on each side), so a passage that the primary
 * garbled instead of dropping is never patched into a jumble: it is left as the primary heard it.
 */
export function reconcile(primary, second, { terms = MEDICAL_TERMS, minFill = 6, anchor = 2, maxCells = 25_000_000 } = {}) {
  const P = String(primary || '').split(/\s+/).filter(Boolean); const Q = String(second || '').split(/\s+/).filter(Boolean);
  if (!P.length || !Q.length || P.length * Q.length > maxCells) return { text: String(primary || ''), swaps: [], fills: [] };
  const A = P.map(core), B = Q.map(core); const ops = alignTokens(A, B);
  const matched = (k, dir) => { for (let c = 1; c <= anchor; c++) { const o = ops[k + dir * c]; if (!o || o[0] !== 'm') return false; } return true; };
  const out = []; const swaps = []; const fills = [];
  for (let k = 0; k < ops.length; k++) {
    const [t, i, j] = ops[k];
    if (t === 'm' || t === 'd') out.push(P[i]);
    else if (t === 's') {
      if (shouldSwap(A[i], B[j], terms)) {
        // "light headache" heard as one word elsewhere ("lightheadedness"): the word before is absorbed instead of repeated
        const prevCore = out.length ? core(out[out.length - 1]) : '';
        const carried = carry(P[i], Q[j]);
        if (prevCore.length >= 3 && B[j].startsWith(prevCore) && prevCore !== B[j]) { const lead = out.pop(); out.push(carry(lead, Q[j])); } else out.push(carried);
        swaps.push({ from: A[i], to: B[j] });
      } else out.push(P[i]);
    } else {
      let l = k; while (l < ops.length && ops[l][0] === 'i') l++;
      const edgeOk = (k === 0 || matched(k, -1)) && (l === ops.length || matched(l - 1, 1));
      if (l - k >= minFill && edgeOk) { for (let c = k; c < l; c++) out.push(Q[ops[c][2]]); fills.push(l - k); }
      k = l - 1;
    }
  }
  return { text: out.join(' '), swaps, fills };
}
