// Style Spec v2: show advice and follow-up as their own lines under a problem, as the gold notes and the doctor's
// profile ask ("safety-netting advice, patient refusals and return precautions in the plan under the relevant problem",
// "follow-up with a timeframe"). Works on the rendered Markdown after the plan labels were joined: it only moves parts of the
// "Treatment planned:" line into "Advice:" and "Follow-up:" lines; no wording is added or removed except the redundant
// "Rtc:" / "Follow-up:" prefix. Part of Style Spec v2 (approved by the owner 2026-10-22). On by default; opts.adviceLines=false or ADVICE_LINES=0 switches it off.
'use strict';

const FOLLOW = /^(rtc\b|follow[\s-]?up\b|return (to (the )?clinic )?in\b|recheck\b|review in\b|see (me|you)( again)? in\b|revisit\b|next visit\b)/i;
const ADVICE = /^(advis\w*|counsel+ed|counsel+ing|discuss\w*|warned|explained|educat\w*|avoid\b|monitor\b|return if\b|return (to (the )?clinic )?(if|sooner)\b|go to (the )?(er|emergency)|call (if|us)|seek\b|safety|red flag|reassur\w*|declined|refused|patient declines|patient declined)/i;

const TIMEFRAME = /(\d|\b(one|two|three|four|five|six|week|weeks|month|months|day|days|year|tomorrow|next|after|before|end of|soon|prn|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|spring|summer|fall|autumn|winter|visit|appointment)\b)/i;   // "Follow-up for lab results" is a reason, not a return date
export function classify(part) { const p = String(part).trim(); if (FOLLOW.test(p) && TIMEFRAME.test(p.replace(FOLLOW, ''))) return 'follow'; if (ADVICE.test(p)) return 'advice'; return 'treat'; }
const tidyAdvice = (p) => p.replace(/^advis(ed|e)\s+(to\s+)?/i, '').replace(/^./, (x) => x.toUpperCase());

export function splitAdviceLines(md) {
  const lines = String(md || '').split('\n'); const out = []; let inAP = false; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^###\s+/.test(l)) inAP = /^###\s+Assessment/i.test(l);
    if (!inAP || !/^\d+\.\s/.test(l)) { out.push(l); i++; continue; }
    const block = [l]; i++; while (i < lines.length && /^\s+-\s/.test(lines[i])) block.push(lines[i++]);
    const advice = [], follow = [];
    const kept = block.flatMap((b) => {
      const m = b.match(/^(\s+-\s)Treatment planned:\s*(.*)$/); if (!m) return [b];
      const treat = [];
      for (const p of m[2].split('; ').map((x) => x.trim()).filter(Boolean)) {
        const c = classify(p);
        if (c === 'follow') follow.push(p.replace(/^(rtc|follow[\s-]?up)\s*[:\-]?\s*/i, '').replace(/^./, (x) => x.toUpperCase()));
        else if (c === 'advice') advice.push(tidyAdvice(p));
        else treat.push(p);
      }
      return treat.length ? [`${m[1]}Treatment planned: ${treat.join('; ')}`] : [];
    });
    const ind = (block[1]?.match(/^(\s+-\s)/) || [, '   - '])[1];
    if (advice.length) kept.push(`${ind}Advice: ${advice.join('; ')}`);
    if (follow.length) kept.push(`${ind}Follow-up: ${follow.join('; ')}`);
    out.push(...kept);
  }
  return out.join('\n');
}
