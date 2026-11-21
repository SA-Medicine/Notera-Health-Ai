// Doctor feedback 2026-11-20/21 (Seema, hypertension visit pjxur and dermatology visit tiiir), found again in a scan of the last 130 notes.
// Three small, pure, model-free fixes that run on the FINISHED markdown (after the joiner, plan tidy and group runs), so nothing they edit is
// re-created later. Each one only moves or removes WORDS THAT ALREADY EXIST in another line of the same note; no word is added and nothing is
// reworded. Fails closed (any doubt: the note is returned as it was). Switch off: NOTE_TIDY=0. Not a locked file; it reads the pipeline's output.
'use strict';

const BUL = /^(\s*(?:[-•*]|\d+\.)\s+)(.*\S)\s*$/;
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const stem = (w) => (/^\d/.test(w) || w.length <= 5 ? w : w.slice(0, 5));

// ── 1. The same referral / order written two or three ways ("Referral to Dr. Toth for dermatology evaluation...", "Referral to dermatologist", "Dermatology referral request for skin lesions")
const INTENTS = [
  ['dermatology', /\bdermatolog\w*|\bskin (?:specialist|doctor)\b/i, 'skin lesion lesions rash evaluation'],
  ['ent', /\bENT\b|\bear,? nose,? (?:and )?throat\b|\botolaryngolog\w*/i, 'ear nose throat locally'],
  ['cardiology', /\bcardiolog\w*/i, 'heart'],
  ['gastroenterology', /\bgastroenterolog\w*|\bGI (?:specialist|referral)\b/i, ''],
  ['neurology', /\bneurolog\w*/i, ''],
  ['ophthalmology', /\bophthalmolog\w*|\beye specialist\b/i, 'eye'],
  ['orthopedics', /\borthop\w*/i, ''],
  ['urology', /\burolog\w*/i, ''],
  ['endocrinology', /\bendocrinolog\w*/i, ''],
  ['psychiatry', /\bpsychiatr\w*/i, ''],
  ['ultrasound', /\bultrasound\b/i, ''],
  ['x-ray', /\bx-?ray\b/i, ''],
  ['mri', /\bMRI\b/, ''],
  ['ct', /\bCT\b/, ''],
];
const ORDER = /\b(refer\w*|arrange\w*|request\w*|book\w*|order\w*|schedule\w*)\b/i;
const NOT_ORDER = /\b(provid\w*|print\w*|requisition|receiv\w*|contact\w*|agree\w*|follow-?up|review\w*|result\w*|discuss\w*|declin\w*|booked|completed|done|already)\b/i;
const FILLER = new Set('referral referred refer to for of the a an and or in on at with by request requested requesting arrange arranged arrangement specialist consult consultation assessment evaluation see patient further management appointment book booked order ordered urgent urgently please local locally'.split(' '));

/** One content-word set per line, with the intent's own words (specialty names, "skin", "ear nose throat") removed so "Referral to dermatologist" has no content left. */
function content(body, intentWords) {
  const extra = new Set(String(intentWords).split(' ').filter(Boolean));
  return new Set(norm(body).split(' ').filter((w) => w && !FILLER.has(w) && !extra.has(w) && !/^(dermatolog|otolaryn|cardiolog|gastroen|neurolog|ophthalm|orthop|urolog|endocrin|psychiat|ultrasound|x|ray|mri|ct|ent|dr)/.test(w)).map(stem));
}

/** Drops a plan line when another line of the SAME problem already holds its referral/order intent and every content word of it. Returns { md, dropped: [text] }. */
export function dropIntentDuplicates(md) {
  const lines = String(md || '').split('\n'); const drop = new Set(); const dropped = [];
  const a0 = lines.findIndex((l) => /^###\s+assessment/i.test(l)); if (a0 < 0) return { md, dropped };
  let a1 = lines.findIndex((l, i) => i > a0 && /^###\s/.test(l)); if (a1 < 0) a1 = lines.length;
  // problem blocks: a numbered title line starts one
  const blocks = []; let cur = null;
  for (let i = a0 + 1; i < a1; i++) { if (/^\s*\d+\.\s/.test(lines[i])) { cur = []; blocks.push(cur); } else if (cur && BUL.test(lines[i])) cur.push(i); }
  for (const idxs of blocks) {
    for (const [name, rx, extra] of INTENTS) {
      const cand = idxs.map((i) => { const m = lines[i].match(BUL); return m && rx.test(m[2]) && ORDER.test(m[2]) && !NOT_ORDER.test(m[2]) ? { i, body: m[2], tok: content(m[2], extra) } : null; }).filter(Boolean);
      if (cand.length < 2) continue;
      for (const a of cand) for (const b of cand) {
        if (a.i === b.i || drop.has(a.i) || drop.has(b.i)) continue;
        const sub = [...a.tok].every((t) => b.tok.has(t));
        const longer = b.tok.size > a.tok.size || (b.tok.size === a.tok.size && (b.body.length > a.body.length || (b.body.length === a.body.length && b.i < a.i)));
        if (sub && longer) { drop.add(a.i); dropped.push(a.body); }
      }
    }
  }
  if (!drop.size) return { md, dropped };
  return { md: lines.filter((_, i) => !drop.has(i)).join('\n'), dropped };
}

// ── 2. "- Dr." on its own line followed by "- Albana walk-in clinic report reviewed..." (a sentence split at the title's full stop)
const TITLE_ONLY = /^(\s*(?:[-•*]|\d+\.)\s+)(Dr|Mr|Mrs|Ms|Prof|St)\.?\s*$/;
export function fixSplitTitles(md) {
  const lines = String(md || '').split('\n'); const out = []; let fixed = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].match(TITLE_ONLY); const nx = lines[i + 1] && lines[i + 1].match(BUL);
    if (t && nx) { out.push(`${t[1]}${t[2]}. ${nx[2]}`); i++; fixed++; } else out.push(lines[i]);
  }
  return { md: out.join('\n'), fixed };
}

// ── 3. One subject, one group: lines about ear wax (or about a medicine) that sit in another Subjective group than the group about that subject move into it
const WAX = /\b(?:ear ?wax|cerumen|wax)\b/i;
/** Key words of a line: "wax" and the medicines the note itself lists (medications_mentioned), matched as whole words. */
function keysOf(text, meds) {
  const ks = new Set(); if (WAX.test(text)) ks.add('wax');
  for (const m of meds) if (new RegExp(`(?<![A-Za-z])${m}(?![A-Za-z])`, 'i').test(text)) ks.add(m);
  return ks;
}
/**
 * Subjective groups are the blank-line separated blocks. For a key found in two or more groups: the home group is the one whose FIRST line names the key
 * (else the one with most lines on it, the earliest on a tie). A line moves into the home group only when it names that key and no other key (a line on
 * "nasal spray" AND "wax" stays where its story is), and the group it leaves keeps at least 2 lines. Lines keep their order inside the home group.
 */
export function gatherSubjective(md, meds = []) {
  const lines = String(md || '').split('\n'); const none = { md, moved: [] };
  const s0 = lines.findIndex((l) => /^###\s+subjective/i.test(l)); if (s0 < 0) return none;
  let s1 = lines.findIndex((l, i) => i > s0 && /^###\s/.test(l)); if (s1 < 0) s1 = lines.length;
  const body = lines.slice(s0 + 1, s1); if (body.some((l) => l.trim() && !BUL.test(l))) return none;
  const groups = []; let g = null;
  for (const l of body) { if (!l.trim()) { g = null; continue; } if (!g) { g = []; groups.push(g); } g.push(l); }
  if (groups.length < 2) return none;
  const medKeys = [...new Set((meds || []).map((m) => String(m).toLowerCase().split(/\s+\d/)[0].trim()).filter((m) => /^[a-z][a-z-]{4,}$/.test(m)))];
  const keyed = groups.map((gr) => gr.map((l) => keysOf(l.match(BUL)[2], medKeys)));
  const all = new Set(keyed.flat().flatMap((s) => [...s]));
  const moved = [];
  for (const key of all) {
    const where = groups.map((gr, gi) => gi).filter((gi) => keyed[gi].some((s) => s.has(key))); if (where.length < 2) continue;
    const lead = where.filter((gi) => keyed[gi][0].has(key));
    const home = lead.length ? lead[0] : where.slice().sort((a, b) => keyed[b].filter((s) => s.has(key)).length - keyed[a].filter((s) => s.has(key)).length || a - b)[0];
    for (const gi of where) {
      if (gi === home) continue;
      const about = (l) => { const t = l.match(BUL)[2]; return !/^[A-Z][A-Za-z ]{2,30}:\s/.test(t) && t.split(/\s+/).slice(0, 8).some((w) => (key === 'wax' ? WAX.test(w) : new RegExp(`^${key}`, 'i').test(w))); };   // the key is in the first 8 words and the line is not a labelled list ("Aggravating: ...")
      const movable = groups[gi].map((l, li) => ({ l, li })).filter(({ l, li }) => keyed[gi][li].size === 1 && keyed[gi][li].has(key) && about(l));
      if (!movable.length || groups[gi].length - movable.length < 2) continue;
      for (const { l, li } of movable) { groups[home].push(l); keyed[home].push(keyed[gi][li]); moved.push(l.trim().slice(0, 90)); }
      const keepIdx = new Set(groups[gi].map((_, li) => li).filter((li) => !movable.some((m) => m.li === li)));
      groups[gi] = groups[gi].filter((_, li) => keepIdx.has(li)); keyed[gi] = keyed[gi].filter((_, li) => keepIdx.has(li));
    }
  }
  if (!moved.length) return none;
  const rebuilt = []; groups.forEach((gr, i) => { if (i) rebuilt.push(''); rebuilt.push(...gr); });
  const before = body.filter((l) => l.trim()).sort().join('\n'); const after = rebuilt.filter((l) => l.trim()).sort().join('\n');
  if (before !== after) return none;   // never lose, add or change a line
  const lead = body.findIndex((l) => l.trim()); const tail = body.length - 1 - [...body].reverse().findIndex((l) => l.trim());
  return { md: [...lines.slice(0, s0 + 1), ...body.slice(0, lead), ...rebuilt, ...body.slice(tail + 1), ...lines.slice(s1)].join('\n'), moved };
}

/** All three, in order. -> { md, meta } ; meta only lists what changed. */
export function noteTidy(md, { meds = [] } = {}) {
  let cur = String(md || ''); const meta = {};
  try {
    const a = fixSplitTitles(cur); if (a.fixed) { cur = a.md; meta.titles = a.fixed; }
    const b = dropIntentDuplicates(cur); if (b.dropped.length) { cur = b.md; meta.duplicates = b.dropped; }
    const c = gatherSubjective(cur, meds); if (c.moved.length) { cur = c.md; meta.gathered = c.moved; }
  } catch { return { md, meta: { error: true } }; }
  return { md: cur, meta };
}
