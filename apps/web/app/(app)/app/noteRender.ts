// Note text → HTML for the Notera scribe screen.
// Input: the markdown the backend renders (### sections, "1. **Problem**", "- Label: text"). Safe by construction: everything is escaped first.
// The labels of the Assessment & Plan (Diagnosis, Investigations planned, Treatment planned, Referrals, Advice, Follow-up) become a small label
// span INSIDE the list item, so the text of the note is unchanged ("Advice: Drink water") when it is copied or read back with innerText.

const LABELS: Record<string, string> = {
  'diagnosis': 'dx',
  'differential diagnoses': 'dx',
  'investigations planned': 'inv',
  'treatment planned': 'tx',
  'referrals': 'ref',
  'advice': 'adv',
  'follow-up': 'fu',
  // the sub-points under Treatment planned
  'started': 'sta', 'changed': 'chg', 'stopped': 'stp', 'continued': 'con', 'given today': 'giv', 'other': 'oth',
};

export function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = esc(md || '').split('\n');
  const out: string[] = [];
  let inList = false;
  let inAP = false;   // inside the Assessment & Plan: a bullet without a label is the problem's assessment line
  for (const ln of lines) {
    if (/^#{1,6}\s/.test(ln)) inAP = /assessment/i.test(ln);
    // Numbered A&P problem heading: "1. **Title**" → keep the number inside the bold so "1. Title" stays on one line.
    const numHead = ln.match(/^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*$/);
    if (numHead) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p class="ap-head"><strong>${numHead[1]}. ${numHead[2]}</strong></p>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(ln)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      const body = ln.replace(/^\s*[-*]\s+/, '');
      const lab = body.match(/^([A-Za-z][A-Za-z -]{2,26}):\s*(.*)$/);
      const kind = lab ? LABELS[lab[1].trim().toLowerCase()] : undefined;
      const sub = /^\s{5,}[-*]\s/.test(ln) && !!kind;   // a sub-point under "Treatment planned:"
      out.push(kind ? `<li class="ap-line ap-${kind}${sub ? ' ap-sub' : ''}"><span class="ap-lbl">${lab![1]}:</span> ${lab![2]}</li>` : inAP ? '<li class="ap-line ap-as">' + body + '</li>' : '<li>' + body + '</li>');
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    if (/^#{1,6}\s/.test(ln)) {
      const h = ln.match(/^#+/)![0].length;
      out.push(`<h${h}>` + ln.replace(/^#+\s/, '') + `</h${h}>`);
      continue;
    }
    if (!ln.trim()) { out.push('<br/>'); continue; }
    out.push('<p>' + ln + '</p>');
  }
  if (inList) out.push('</ul>');
  return out.join('').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}


/** The edited note body back to the markdown the app stores: the inverse of mdToHtml (headings, bold topic lines, numbered problems, bullets, plan sub-points). */
export function htmlToMd(root: HTMLElement): string {
  const inline = (n: Node): string => {
    if (n.nodeType === 3) return (n.textContent || '').replace(/\u00a0/g, ' ');
    if (n.nodeType !== 1) return '';
    const e = n as HTMLElement; const t = e.tagName;
    if (t === 'BR') return '\n';
    const inner = Array.from(e.childNodes).map(inline).join('');
    return t === 'STRONG' || t === 'B' ? (inner.trim() ? '**' + inner + '**' : inner) : inner;
  };
  const out: string[] = [];
  const block = (e: Element) => {
    const t = e.tagName;
    if (/^H[1-6]$/.test(t)) { out.push('#'.repeat(Number(t[1])) + ' ' + inline(e).trim()); return; }
    if (t === 'UL' || t === 'OL') {
      for (const li of Array.from(e.children)) {
        const body = inline(li).replace(/\s*\n\s*/g, ' ').trim(); if (!body) continue;
        const c = (li as HTMLElement).classList;
        out.push((c.contains('ap-sub') ? '     - ' : c.contains('ap-line') ? '   - ' : '- ') + body);
      }
      return;
    }
    if (t === 'BR') { out.push(''); return; }
    if (t === 'P' && (e as HTMLElement).classList.contains('ap-head')) { const raw = inline(e).replace(/\*\*/g, '').trim(); const m = raw.match(/^(\d+)\.\s*(.*)$/); out.push(m ? m[1] + '. **' + m[2] + '**' : raw); return; }
    if (t === 'P' || t === 'DIV') {
      if (Array.from(e.children).some((c) => /^(UL|OL|P|H[1-6]|DIV)$/.test(c.tagName))) { Array.from(e.children).forEach(block); return; }
      const lines = inline(e).split('\n'); for (const l of lines) out.push(l.trim()); return;
    }
    const x = inline(e).trim(); if (x) out.push(x);
  };
  const kids = Array.from(root.childNodes);
  for (const n of kids) {
    if (n.nodeType === 3) { const x = (n.textContent || '').trim(); if (x) out.push(x); } else if (n.nodeType === 1) block(n as Element);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
