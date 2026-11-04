// GENERATED from apps/web/app/(app)/app/selectionCopy.ts by scripts/sync-admin-copy.mjs. Do not edit here.
// Ctrl+C on a note that was selected by hand (dragging the cursor over it) keeps the formatting too.
// The browser's own copy of the screen loses the bullets (they are drawn by CSS, not text) and brings the app's colours and fonts along.
// Here the copy event is taken over when the selection lies inside the note: the selected part is turned back into the note's markdown and
// goes through the same noteToClipboard() as the Copy button, so a hand selection and the button paste the same way into Word, Gmail and the EMR.
// A selection of a few words inside one line is left to the browser (plain words). Shared with the admin site (see scripts/sync-admin-copy.mjs).
import { htmlToMd } from './noteRender.js';
import { noteToClipboard } from './copyNote.js';

const norm = (s        ) => s.replace(/\s+/g, '');

/** The markdown of what is selected inside `root`, or null when the browser should do its normal copy. */
export function selectionToMd(sel                  , root             )                {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (!r.intersectsNode(root)) return null;
  const whole = document.createRange(); whole.selectNodeContents(root);
  const clip = r.cloneRange();
  if (clip.compareBoundaryPoints(Range.START_TO_START, whole) < 0) clip.setStart(root, 0);
  if (clip.compareBoundaryPoints(Range.END_TO_END, whole) > 0) clip.setEnd(root, root.childNodes.length);
  if (norm(sel.toString()) !== norm(clip.toString())) return null;   // the selection also holds text outside the note: not ours
  const box = document.createElement('div');
  box.appendChild(clip.cloneContents());
  if (!box.querySelector('li,p,h1,h2,h3,h4,h5,h6,ul,ol,br')) return null;   // a few words inside one line: plain copy
  // A selection that starts in one bullet and ends in another comes back as loose <li> elements: put them back in a list.
  for (let n                   = box.firstChild; n;) {
    if (n.nodeName === 'LI') {
      const ul = document.createElement('ul'); box.insertBefore(ul, n);
      while (n && n.nodeName === 'LI') { const next                   = n.nextSibling; ul.appendChild(n); n = next; }
    } else n = n.nextSibling;
  }
  const md = htmlToMd(box);
  return md.trim() ? md : null;
}

/** Listens for copy on the page and, when the selection is (only) inside the note, puts the formatted note on the clipboard. Returns the remover. */
export function installNoteCopy(getRoot                          )             {
  const on = (e                ) => {
    try {
      const root = getRoot(); if (!root || !e.clipboardData) return;
      const md = selectionToMd(window.getSelection(), root); if (!md) return;
      const { html, text } = noteToClipboard(md);
      e.clipboardData.setData('text/html', html); e.clipboardData.setData('text/plain', text); e.preventDefault();
    } catch { /* the browser's own copy goes ahead */ }
  };
  document.addEventListener('copy', on);
  return () => document.removeEventListener('copy', on);
}
