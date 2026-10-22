// Fallback for the story agent (3 of 10 newer test notes lost their topic headings after every attempt): instead of asking a model to REWRITE
// the Subjective, ask it only to GROUP the existing lines under headings. No line is reworded, added or dropped, so there is nothing to fact-check.
// Code checks that every line is used exactly once. Pure parts are exported for tests.
'use strict';

const isHead = (l) => /^[A-Za-z][A-Za-z &/,'-]{1,50}:\s*$/.test(String(l).trim());
export const GROUP_SYS = `You group the lines of a clinic note's Subjective section under topic headings. You do NOT rewrite anything.
You receive numbered lines. Return ONLY JSON: {"groups":[{"heading":"","lines":[1,2]}]}.
Rules: every line number appears in exactly one group; one group per symptom or problem (for example "Abdominal Pain", "Cough", "Heartburn", "Thyroid Symptoms", "Medication Review"), 2 to 6 groups, 1 to 4 words each, plain medical names, no colon; put the lines that say why the patient came or what was reviewed in the first group named "Presenting Complaint"; keep the original order of lines inside a group; order the groups by first appearance.`;

export function buildGrouped(lines, groups) {
  const n = lines.length; const used = new Set(); const out = [];
  for (const g of groups || []) {
    const heading = String(g?.heading || '').replace(/[:*]/g, '').trim(); const idx = (Array.isArray(g?.lines) ? g.lines : []).map(Number).filter((i) => Number.isInteger(i) && i >= 1 && i <= n && !used.has(i)).filter((i, k, arr) => arr.indexOf(i) === k);
    if (!/^[A-Za-z][A-Za-z &/,'-]{1,40}$/.test(heading) || !idx.length) continue;
    idx.forEach((i) => used.add(i)); out.push({ heading, idx: idx.sort((a, b) => a - b) });
  }
  if (!out.length) return null;
  const missing = lines.map((_, i) => i + 1).filter((i) => !used.has(i));
  if (missing.length) { const last = out[out.length - 1]; last.idx.push(...missing); last.idx.sort((a, b) => a - b); }   // never lose a line
  return out.map((g) => `${g.heading}:\n${g.idx.map((i) => lines[i - 1]).join('\n')}`).join('\n');
}

/** Returns { reason_for_visit, hpi_details } with topic headings, or null. Keeps reason_for_visit as the Presenting Complaint topic. */
export async function groupSubjective(llm, subjective, log = () => {}) {
  const hpi = String(subjective?.hpi_details || '').split('\n').map((l) => l.trim()).filter((l) => l && !isHead(l));
  if (hpi.length < 4) return null;
  const numbered = hpi.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const raw = await llm.generateContent(GROUP_SYS, numbered, null, { maxOutputTokens: 1500, timeoutMs: 20000, retries: 0, hedgeMs: 0, temperature: 0, thinkingBudget: 0, responseMimeType: 'application/json' });
  let groups; try { groups = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()).groups; } catch { return null; }
  const text = buildGrouped(hpi, groups); if (!text) return null;
  log(`[v2:story] fallback: grouped ${hpi.length} Subjective lines under ${text.split('\n').filter(isHead).length} headings (no line reworded)`);
  return text;
}
