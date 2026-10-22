// One-click fixes for a line the review layer marked: find the line in the note's markdown and remove it, rewrite it, swap its side or
// replace a word. Pure string functions (no DOM), so the note text stays the single source of truth and Copy / Copy to EMR see the change.

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

const LABEL = /^(\s*(?:[-•*]\s+)?)((?:Diagnosis|Investigations planned|Treatment planned|Referrals|Advice|Follow-up|Differential diagnoses):\s*)?([\s\S]*)$/;
const TITLE = /^\s*\d+\.\s+\*\*(.+?)\*\*\s*$/;

export type Parts = { bullet: string; label: string; text: string; title: boolean };

export function splitLine(line: string): Parts {
  const t = line.match(TITLE);
  if (t) return { bullet: '', label: '', text: t[1], title: true };
  const m = line.match(LABEL)!;
  return { bullet: m[1] || '', label: m[2] || '', text: m[3] || '', title: false };
}

const isHeading = (l: string) => /^\s*#{1,6}\s/.test(l) || /^\s*\*\*[^*]+\*\*\s*$/.test(l);

/** Index of the markdown line that holds the quoted text (-1 when it is not there any more). A short quote must be the whole line. */
export function findLine(md: string, quote: string): number {
  const q = norm(quote); if (q.length < 3) return -1;
  const needle = q.slice(0, 40); const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (isHeading(lines[i]) && !TITLE.test(lines[i])) continue;
    const p = splitLine(lines[i]);
    if (needle.length >= 8 ? norm(lines[i]).includes(needle) : norm(p.text) === needle) return i;
  }
  return -1;
}

/** Removes the quoted text: the whole line, or just that item when the line joins several with "; ". Null when the text is not found or is a problem title. */
export function removeQuote(md: string, quote: string): string | null {
  const idx = findLine(md, quote); if (idx < 0) return null;
  const lines = md.split('\n'); const p = splitLine(lines[idx]); if (p.title) return null;
  const parts = p.text.split(/;\s+/); const needle = norm(quote).slice(0, 40);
  const hit = parts.length > 1 ? parts.findIndex((x) => (needle.length >= 8 ? norm(x).includes(needle) : norm(x) === needle)) : -1;
  if (hit >= 0) { parts.splice(hit, 1); lines[idx] = p.bullet + p.label + parts.join('; '); } else lines.splice(idx, 1);
  return lines.join('\n');
}

/** The text of a line without its bullet and label (what the clinician edits). */
export function lineText(md: string, quote: string): string | null {
  const idx = findLine(md, quote); return idx < 0 ? null : splitLine(md.split('\n')[idx]).text.replace(/\*\*/g, '');
}

/** Rewrites the line that holds the quote; bullet and label stay. */
export function replaceLine(md: string, quote: string, text: string): string | null {
  const idx = findLine(md, quote); if (idx < 0) return null;
  const lines = md.split('\n'); const p = splitLine(lines[idx]);
  lines[idx] = p.title ? lines[idx].replace(/\*\*(.+?)\*\*/, '**' + text.trim() + '**') : p.bullet + p.label + text.trim();
  return lines.join('\n');
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Replaces a word or phrase everywhere in the note. */
export function replaceWord(md: string, from: string, to: string): string | null {
  if (!from.trim() || !to.trim()) return null;
  const rx = new RegExp('(?<![A-Za-z])' + esc(from) + '(?![A-Za-z])', 'g');
  return rx.test(md) ? md.replace(rx, to.trim()) : null;
}

/** Swaps left and right in the quoted line. */
export function swapSides(md: string, quote: string): string | null {
  const idx = findLine(md, quote); if (idx < 0) return null;
  const lines = md.split('\n'); const before = lines[idx];
  lines[idx] = before.replace(/\b(left|right)\b/gi, (w) => { const o = w.toLowerCase() === 'left' ? 'right' : 'left'; return w[0] === w[0].toUpperCase() ? o[0].toUpperCase() + o.slice(1) : o; });
  return lines[idx] === before ? null : lines.join('\n');
}

/** What the draft shows in place of a drug: `Written as "PPI"` or `written as "medication (name unclear)"`. */
export function shownAs(message: string): string {
  const m = String(message || '').match(/written as "([^"]+)"/i); return m ? m[1] : '';
}

export type Target = { label: string; end: number; indent: string };
/** Places a removed line can be added back to: each section, each topic heading in Subjective, each problem. `end` = index of the block's last line. */
export function targets(md: string): Target[] {
  const lines = md.split('\n'); const out: Target[] = []; let cur: { label: string; start: number; indent: string } | null = null; let last = -1;
  const close = () => { if (cur) out.push({ label: cur.label, end: Math.max(last, cur.start), indent: cur.indent }); };
  lines.forEach((l, i) => {
    const h = l.match(/^###\s+(.+?)\s*$/); const t = l.match(/^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*$/); const b = l.match(/^\*\*(.+?)\*\*\s*$/);
    if (h || t || b) { close(); cur = { label: h ? h[1] : t ? `${t[1]}. ${t[2]}` : b![1].replace(/:$/, ''), start: i, indent: t ? '   - ' : '- ' }; last = i; } else if (cur && l.trim()) last = i;
  });
  close(); return out.filter((x) => x.label !== 'Assessment & Plan');
}
export function insertLine(md: string, t: Target, text: string): string {
  const lines = md.split('\n'); lines.splice(t.end + 1, 0, t.indent + text.trim()); return lines.join('\n');
}
/** The old drug flag: `Heard "Rovastatin"; the model had written "rosuvastatin"...` -> the heard word and the suggested name. */
export function heardFix(message: string): { from: string; suggest: string } | null {
  const h = String(message || '').match(/^Heard "([^"]+)"/); if (!h) return null;
  const w = String(message).match(/had written "([^"]+)"/); return { from: h[1], suggest: w ? w[1] : '' };
}
