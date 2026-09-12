// ─────────────────────────────────────────────────────────────────────────────
// clinicalPhrasing — is a note line a PLAN ACTION or PATIENT HISTORY?
//
// Shared by condenseNote (subjective-bleed removal) and dedupeNote (so a plan action is
// never dropped as a duplicate of the history above).
//
// Both signals are needed and they are used TWO-SIDED on purpose: a line is only removed
// from a plan field when it positively reads as history AND carries no action verb.
// Absence of an action verb alone is not enough — "Paracetamol 1 g PRN" and "Kidney
// function and electrolytes" are valid plan entries with no verb at all.
//
// WHY THIS EXISTS: the previous pattern was
//   /\b(continu|increas|prescrib|refer|…)\b/i
// and the trailing \b made every stem alternative unmatchable — "continu" needs a word
// boundary after it, but "Continue" has an "e" there. So "Continue metformin 1 g twice
// daily", "Increase amlodipine to 10 mg", "Prescribed paracetamol" and "Referral to
// diabetes educator" were all classified as NARRATIVE, which disabled the guard that is
// supposed to stop a real plan action being deleted as a duplicate.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// Management verbs as PREFIX stems (no trailing boundary) so inflections match:
// continu → continue/continued/continuing, prescrib → prescribe/prescribed, etc.
const ACTION_PARTS = [
  'continu', 'commenc', 'initiat', 'increas', 'decreas', 'reduc', 'titrat', 'taper', 'wean',
  'prescrib', 'renew', 'refill', 'dispens', 'administer',
  'refer', 'arrang', 'order', 'organis', 'organiz', 'schedul', 'book', 'request',
  'advis', 'counsel', 'educat', 'instruct', 'encourag', 'recommend', 'suggest',
  'monitor', 'recheck', 'reassess', 'repeat', 'await', 'observ', 'screen',
  'discontinu', 'ceas', 'withhold', 'switch', 'chang', 'trial',
  'inject', 'vaccinat', 'immunis', 'immuniz', 'provid', 'suppl', 'given', 'give',
  'start', 'stop', 'hold', 'consider', 'fax', 'defer', 'titrate',
  'plan(?:s|ned|ning)?',
  // Investigation shorthand that is an order in its own right.
  'x-?ray', 'ultrasound', 'mri\\b', 'ct scan', 'swab', 'biopsy', 'ecg\\b',
  // PLURAL only. 'bloods?' also matched "blood pressure", which made a history line read
  // as a plan action and so kept bled history in the Plan.
  'bloods\\b',
  // Follow-up phrasing. "return" must be followed by to/for/in so that a SYMPTOM
  // returning ("headaches have returned over the last 3 weeks") is not read as a plan.
  'rtc\\b', 'follow.?up', 'return (?:to|for|in)\\b', 'see (?:me|us|you) (?:in|again)',
  // "review" only as an instruction. As a bare stem it matched "3-month review" inside a
  // history sentence and so protected that sentence from the bleed check.
  '^\\s*review\\b', 'review(?:ed|ing)?\\s+(?:in|at|after|again|with|on)\\b', 'for review\\b',
];
export const ACTION_RX = new RegExp('\\b(?:' + ACTION_PARTS.join('|') + ')', 'i');

// Positive evidence that a line is describing the patient's history or current state
// rather than prescribing something. Matches anywhere in the line, not just at the start
// — the old rule required the line to OPEN with "patient/he/she/they", so "Takes
// amlodipine 5 mg daily with good adherence" and "Reports home blood pressure around
// 150/90" slipped through into the Plan.
const HISTORY_PARTS = [
  // Opens with the subject of the history.
  '^\\s*(?:the\\s+)?(?:patient|pt|client|mother|father|parent|caregiver|he|she|they)\\b',
  // Reporting verbs.
  '\\b(?:reports?|reported|reporting|describes?|described|states?|stated|notes?|noted'
    + '|mentions?|mentioned|complains?|complained|denies|denied|admits?|endorses?)\\b',
  // Current-medication / current-state phrasing.
  '\\b(?:takes?|taking|took|is on|was on|has been on|have been on|currently on|uses?|using)\\b',
  // Experience verbs.
  '\\b(?:experienc\\w*|suffers?|suffered|feels?|felt|notices?|noticed|remains?|remained)\\b',
  // Adherence / tolerance commentary and visit framing are history, not orders.
  '\\b(?:adherent|adheres?|adherence|compliant|compliance|tolerat\\w*|no side.?effects?)\\b',
  '\\bpresents? (?:for|with)\\b',
  // Symptom-course phrasing, with or without an auxiliary ("GI upset resolved after a
  // month" carries none).
  '\\b(?:ha[sd]|have|had) (?:returned|recurred|persisted|worsened|improved|settled|resolved)\\b',
  '\\b(?:resolved|settled|recurred|persisted|worsened|subsided|flared)\\b',
  // Duration phrasing.
  '\\bfor (?:the )?(?:last|past)\\s+\\w+', '\\bover the (?:last|past)\\s+\\w+',
  '\\b(?:since|for)\\s+(?:about|approximately|around)?\\s*\\d+\\s*(?:day|week|month|year)',
];
export const HISTORY_RX = new RegExp(HISTORY_PARTS.join('|'), 'i');

/** A line that belongs in a plan field: it prescribes or orders something. */
export const isPlanAction = (line) => ACTION_RX.test(String(line || ''));

/** A line that reads as patient history / current state rather than a plan step. */
export const isHistoryNarrative = (line) => HISTORY_RX.test(String(line || ''));

/**
 * Should this line be removed from an Assessment & Plan *plan* field as bled history?
 * Requires positive history evidence AND no action verb, so a genuine plan entry — with
 * or without a verb — is never removed.
 */
export function isBledHistory(line) {
  const s = String(line || '');
  if (!s.trim()) return false;
  if (isPlanAction(s)) return false;
  return isHistoryNarrative(s);
}
