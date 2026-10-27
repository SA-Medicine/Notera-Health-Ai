// Negation check (research basis: Asgari et al., npj Digit Med 2025 — negation errors were 30% of all hallucinations and clustered in the plan; a reversed
// "no" or "not" can send care the wrong way and is hard for a reader to spot).
//
// Flags only; it never edits or removes a line. For every note line that is a negated statement ("No fever", "Did not start metformin", "Declined flu shot"), the
// words it is about are looked up in the transcript, and the closest passage must carry a negation of its own. If it does not, the line is flagged for the
// clinician: "the recording does not show this negation". Lines that are NOT negated are checked the other way round only for the unambiguous spoken forms
// ("no <word>", "not <word>", "don't have <word>", "denies <word>", "declined <word>") sitting right next to the line's key words.
// Off unless NEG_GUARD=1 (flags are shown under "Before you sign").
'use strict';

const NEG_NOTE = /\b(no|not|never|without|denies|denied|negative for|absent|declined|refused|refuses|declines|unable to|none|nil|didn'?t|doesn'?t|don'?t|isn'?t|wasn'?t|hasn'?t|haven'?t|cannot|can'?t|stopped|discontinued|no longer)\b/i;
const NEG_SPOKEN = /\b(no|not|never|without|deny|denies|denied|none|nothing|nope|neither|nor|decline|declined|declines|refuse|refused|refuses|don'?t|doesn'?t|didn'?t|isn'?t|wasn'?t|haven'?t|hasn'?t|won'?t|cannot|can'?t|stop|stopped|no longer|negative|normal|clear|fine|resolved|gone)\b/i;
const STOP = new Set('the and for with that this have has had was were are you your his her she him they them their from about into over then than also just very really okay yeah well like some any all can could would should will not but one two patient says said told states reported mentions noted discussed plan advised note denies denied without declined refused never none nil absent negative stopped discontinued longer still today visit clinic doctor'.split(' '));
const stem = (w) => w.toLowerCase().replace(/(ing|ed|es|s)$/, '').slice(0, 6);
const keys = (s) => [...new Set(String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)).map(stem))];

/** Split the transcript into passages (sentences), keeping the stems of each one. */
export function passages(transcript) {
  return String(transcript || '').split(/(?<=[.!?])\s+|\n+/).map((t) => t.trim()).filter((t) => t.length > 3).map((t) => ({ t, w: new Set(keys(t)) }));
}

/** Every passage (with its neighbours, three sentences) that holds at least 60% of a line's key words. A topic is often asked about more than once. */
export function matchingPassages(lineKeys, ps) {
  const out = [];
  for (let i = 0; i < ps.length; i++) {
    const win = [ps[i - 1], ps[i], ps[i + 1], ps[i + 2]].filter(Boolean); const have = new Set(win.flatMap((p) => [...p.w]));
    if (lineKeys.filter((k) => have.has(k)).length / lineKeys.length >= 0.6) out.push(win.map((p) => p.t).join(' '));
  }
  return out;
}

/** Does the passage deny / negate what the line key words are about? Looks for a negation word within a few words of one of the key words. */
export function negatedNear(text, lineKeys) {
  const toks = String(text).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    if (!NEG_SPOKEN.test(toks[i])) continue;   // "normal", "clear", "resolved" count too: they are how a negative finding is usually said ("chest is clear" for "no wheeze")
    for (let j = Math.max(0, i - 6); j <= Math.min(toks.length - 1, i + 6); j++) if (j !== i && lineKeys.includes(stem(toks[j]))) return true;
  }
  return false;
}

/** The lines of the note worth checking: bullets and plan items, with the section they sit in. */
export function noteLines(md) {
  const out = []; let section = '';
  for (const raw of String(md || '').split('\n')) {
    const h = raw.match(/^###\s+(.+)$/); if (h) { section = h[1]; continue; }
    const m = raw.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/); if (!m) continue;
    const text = m[1].replace(/\*\*/g, '').replace(/^(Started|Changed|Stopped|Continued|Given today|Other|Advice|Follow-up|Treatment planned|Diagnosis):\s*/i, '').trim();
    if (text.length >= 8 && !/:\s*$/.test(text)) out.push({ section, text, raw: m[1] });
  }
  return out;
}

/**
 * Flags for lines whose negation the recording does not support.
 * @returns {{ flags: object[], checked: number, negated: number }}
 */
export function negationGuard(md, transcript, log = () => {}) {
  const ps = passages(transcript); const flags = []; let checked = 0, negated = 0;
  for (const l of noteLines(md)) {
    const isNeg = NEG_NOTE.test(l.text); const lk = keys(l.text.replace(NEG_NOTE, ' '));
    if (lk.length < 1 || lk.length > 8) continue;
    const found = matchingPassages(lk, ps); if (!found.length) continue; checked++;
    const spoken = found.some((t) => negatedNear(t, lk));
    if (isNeg) { negated++; if (!spoken) flags.push({ type: 'check_against_recording', field: 'note', severity: 'warning', message: `"${l.text.slice(0, 110)}" - the recording does not show this negation`, section: l.section, kind: 'unsupported_negation' }); }
    else if (/^(Assessment|Plan)/i.test(l.section) || /plan|assessment/i.test(l.section)) {
      // a positive plan statement whose key words are explicitly denied or declined in the recording
      const tight = new RegExp(`\\b(declin\\w*|refus\\w*|denies|denied|don'?t want|doesn'?t want|no longer|stopped|not (?:taking|on|going))\\b[^.?!]{0,40}\\b(${lk.map((k) => k.replace(/[^a-z0-9]/g, '')).filter(Boolean).join('|')})`, 'i');
      if (lk.length && found.some((t) => tight.test(t))) flags.push({ type: 'check_against_recording', field: 'note', severity: 'warning', message: `"${l.text.slice(0, 110)}" - the recording says this was declined or denied`, section: l.section, kind: 'reversed_negation' });
    }
  }
  if (flags.length) log(`[v2:negation] ${flags.length} line(s) whose negation the recording does not support (flagged, nothing changed)`);
  return { flags, checked, negated };
}
