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
};

export function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = esc(md || '').split('\n');
  const out: string[] = [];
  let inList = false;
  for (const ln of lines) {
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
      out.push(kind ? `<li class="ap-line ap-${kind}"><span class="ap-lbl">${lab![1]}:</span> ${lab![2]}</li>` : '<li>' + body + '</li>');
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
