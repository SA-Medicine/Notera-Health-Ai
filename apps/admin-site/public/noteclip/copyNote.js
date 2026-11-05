// GENERATED from apps/web/app/(app)/app/copyNote.ts by scripts/sync-admin-copy.mjs. Do not edit here.
// The note on the clipboard: formatted text, the way it looks on the screen, with no markdown symbols in it.
// One copy puts two versions on the clipboard: text/html (headings, bold, bullets and indents, so Word, Gmail and the EMR keep the layout) and
// text/plain (clean lines with real bullets and blank lines between sections, so a .txt file or Notepad also looks right).
// Pure functions, no DOM: noteToClipboard() is tested in test/copyNote.test.mjs.

            
                                                                 
                                                                                          
                                                                 
                                                                                                                                                                          
                             

const LABELS = ['diagnosis', 'differential diagnoses', 'investigations planned', 'treatment planned', 'referrals', 'advice', 'follow-up', 'started', 'changed', 'stopped', 'continued', 'given today', 'other'];

function parse(md        )          {
  const out          = [];
  let inAP = false;
  for (const raw of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
    const ln = raw.replace(/\s+$/, '');
    if (!ln.trim()) continue;
    let m                         ;
    if ((m = ln.match(/^#{1,6}\s+(.*)$/))) { inAP = /assessment/i.test(m[1]); out.push({ k: 'h', text: m[1].trim() }); continue; }
    if ((m = ln.match(/^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*$/))) { out.push({ k: 'num', n: m[1], text: m[2].trim() }); continue; }
    if ((m = ln.match(/^(\s*)[-*•]\s+(.*)$/))) { const ind = m[1].replace(/\t/g, '    ').length; out.push({ k: 'li', level: ind >= 5 ? 2 : ind >= 2 ? 1 : 0, text: m[2].trim(), ap: inAP }); continue; }
    if ((m = ln.match(/^\s*\*\*(.+?)\*\*\s*$/))) { out.push({ k: 'sub', text: m[1].trim() }); continue; }
    out.push({ k: 'p', text: ln.trim() });
  }
  return out;
}

const esc = (s        ) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Inline markdown to plain words: **bold** and `code` lose their marks. */
const plainInline = (s        ) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/\*\*/g, '').replace(/ /g, ' ');
const htmlInline = (s        ) => {
  const e = esc(plainInlineKeepBold(s));
  return e.replace(/\u0001(.+?)\u0002/g, '<strong>$1</strong>');
};
function plainInlineKeepBold(s        ) { return s.replace(/\*\*(.+?)\*\*/g, '\u0001$1\u0002').replace(/`([^`]*)`/g, '$1').replace(/\*\*/g, '').replace(/ /g, ' '); }

/** "Diagnosis: x" -> the label is bold in the pasted version, like the label on the screen. */
function labelSplit(text        )                                       {
  const m = text.match(/^([A-Za-z][A-Za-z -]{2,26}):\s*(.*)$/);
  return m && LABELS.includes(m[1].trim().toLowerCase()) ? { lab: m[1], rest: m[2] } : null;
}

const FONT = "font-family:Calibri,Arial,Helvetica,sans-serif;color:#000;";

export function noteToClipboard(md        )                                 {
  const blocks = parse(md);
  // ── plain text ──
  const t           = [];
  const gap = () => { if (t.length && t[t.length - 1] !== '') t.push(''); };
  for (const b of blocks) {
    if (b.k === 'h') { gap(); t.push(plainInline(b.text) + ':'); }
    else if (b.k === 'sub') { gap(); t.push(plainInline(b.text)); }
    else if (b.k === 'num') { gap(); t.push(`${b.n}. ${plainInline(b.text)}`); }
    else if (b.k === 'li' && b.ap) t.push(' '.repeat(b.level * 3) + plainInline(b.text));   // the plan is shown without bullets, so it is copied without bullets; its lines sit indented under the problem so each problem reads as a block
    else if (b.k === 'li') t.push(' '.repeat(b.level * 3) + (b.level < 2 ? '• ' : '– ') + plainInline(b.text));
    else t.push(plainInline(b.text));
  }
  const text = t.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // ── html ──
  // Lists are nested for real (a sub-point sits inside its parent bullet) so Word and Google Docs indent them. Headings are bold paragraphs,
  // not <h3>: Word restyles a heading tag and drops the bold.
  const h           = [];
  let depth = 0;   // 0 = no list open, 1 = a list, 2 = a list inside a list item
  const liStyle = `margin:0 0 2pt 0;${FONT}font-size:11pt;line-height:1.4;`;
  const ulStyle = (d        ) => `margin:0 0 ${d === 1 ? 4 : 2}pt 0;padding:0 0 0 ${d === 1 ? 20 : 18}pt;list-style-type:${d === 1 ? 'disc' : 'circle'};`;
  // Real spacing, not margins: many EMR editors and Word-to-web paste filters drop CSS margins, so a gap between blocks is a small empty paragraph.
  const spacer = (pt = 8) => `<p style="margin:0;${FONT}font-size:${pt}pt;line-height:${pt}pt;">&nbsp;</p>`;
  const closeTo = (to        ) => {
    while (depth > to) { h.push('</li></ul>'); depth--; }
  };
  for (const b of blocks) {
    if (b.k === 'li' && b.ap) {   // a plan line: a plain paragraph, a sub-point indented
      closeTo(0);
      const ls = labelSplit(b.text);
      const body = ls ? `<strong>${esc(plainInline(ls.lab))}:</strong> ${htmlInline(ls.rest)}` : htmlInline(b.text);
      h.push(`<p style="margin:0 0 2pt ${b.level >= 2 ? 28 : b.level === 1 ? 12 : 0}pt;${FONT}font-size:11pt;line-height:1.4;">${body}</p>`);
      continue;
    }
    if (b.k === 'li') {
      const d = b.level === 2 ? 2 : 1;
      const ls = labelSplit(b.text);
      const body = ls ? `<strong>${esc(plainInline(ls.lab))}:</strong> ${htmlInline(ls.rest)}` : htmlInline(b.text);
      if (d === 1) {
        if (depth === 2) { h.push('</li></ul>'); depth = 1; }   // back out of the sub-list, the parent <li> is closed below
        if (depth === 1) h.push('</li>'); else { h.push(`<ul style="${ulStyle(1)}">`); depth = 1; }
        h.push(`<li style="${liStyle}">${body}`);
      } else {
        if (depth === 0) { h.push(`<ul style="${ulStyle(1)}"><li style="${liStyle}">`); depth = 1; }   // a sub-point with no parent bullet
        if (depth === 2) h.push('</li>'); else { h.push(`<ul style="${ulStyle(2)}">`); depth = 2; }
        h.push(`<li style="${liStyle}">${body}`);
      }
      continue;
    }
    closeTo(0);
    if (h.length && (b.k === 'h' || b.k === 'num')) h.push(spacer(b.k === 'h' ? 10 : 8));
    if (b.k === 'h') h.push(`<p style="margin:14pt 0 4pt 0;${FONT}font-size:13pt;font-weight:700;"><b>${htmlInline(b.text)}:</b></p>`);
    else if (b.k === 'sub') h.push(`<p style="margin:6pt 0 2pt 0;${FONT}font-size:11pt;font-weight:700;"><b>${htmlInline(b.text)}</b></p>`);
    else if (b.k === 'num') h.push(`<p style="margin:8pt 0 2pt 0;${FONT}font-size:11pt;font-weight:700;"><b>${esc(b.n)}. ${htmlInline(b.text)}</b></p>`);
    else h.push(`<p style="margin:0 0 4pt 0;${FONT}font-size:11pt;line-height:1.4;">${htmlInline(b.text)}</p>`);
  }
  closeTo(0);
  const html = `<meta charset="utf-8"><div style="${FONT}font-size:11pt;">${h.join('')}</div>`;
  return { html, text };
}

/** Puts the formatted note on the clipboard (html + plain). Returns true when it worked; falls back to a copy event, then to plain text. */
export async function copyNoteToClipboard(md        )                   {
  const { html, text } = noteToClipboard(md);
  try {
    const CI = (globalThis                                                       ).ClipboardItem;
    if (CI && navigator.clipboard?.write) {
      await navigator.clipboard.write([new CI({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
      return true;
    }
  } catch { /* fall through to the copy event */ }
  try {
    let ok = false;
    const on = (e                ) => { e.preventDefault(); e.clipboardData?.setData('text/html', html); e.clipboardData?.setData('text/plain', text); ok = true; };
    document.addEventListener('copy', on, { once: true });
    const sel = document.createElement('textarea'); sel.value = ' '; sel.style.position = 'fixed'; sel.style.opacity = '0'; document.body.appendChild(sel); sel.select();
    document.execCommand('copy'); document.body.removeChild(sel); document.removeEventListener('copy', on);
    if (ok) return true;
  } catch { /* plain text below */ }
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
