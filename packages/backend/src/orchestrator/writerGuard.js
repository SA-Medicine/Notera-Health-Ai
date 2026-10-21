// Detects a writer draft that cannot be a usable note: no Assessment & Plan for a real consultation, or a repetition loop
// (the model repeating the same lines until its output budget ends, so the plan is never reached).
// Found on 2 of 30 newer test notes (2026-10-22). Pure functions. The retry itself lives in generateNoteV2.js; this module only decides.
// It changes no wording, label or layout of a note, so Style Spec v1 is unaffected.
'use strict';

const words = (t) => (String(t || '').match(/\S+/g) || []).length;
const strings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => strings(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out)); return out; };

export const MIN_TRANSCRIPT_WORDS = 300;     // shorter recordings can legitimately have no plan
export const LOOP_CHARS = 9000;              // a normal draft is about 2-4 thousand characters; the looping one was ~20 thousand
export const LOOP_REPEATS = 5;               // the same line this many times in one draft

/** '' when the draft is usable; otherwise 'loop' or 'no_plan'. */
export function writerDraftIssue(out, transcript) {
  if (!out || typeof out !== 'object') return '';
  const all = strings(out);
  const lines = all.flatMap((s) => s.split('\n')).map((l) => l.trim().toLowerCase()).filter((l) => l.length > 12);
  const counts = new Map(); for (const l of lines) counts.set(l, (counts.get(l) || 0) + 1);
  const worst = Math.max(0, ...counts.values());
  const chars = all.reduce((n, s) => n + s.length, 0);
  if (worst >= LOOP_REPEATS || chars > LOOP_CHARS) return 'loop';
  const plan = out.assessment_and_plan;
  const hasPlan = Array.isArray(plan) && plan.some((p) => p && typeof p === 'object' && Object.values(p).some((v) => (typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.length : v)));
  if (!hasPlan && words(transcript) >= MIN_TRANSCRIPT_WORDS) return 'no_plan';
  return '';
}

/** Which of two drafts to keep after a retry: the retry only wins if it has no issue, or fewer problems than the original. */
export function pickDraft(original, retry, transcript) {
  const a = writerDraftIssue(original, transcript), b = retry ? writerDraftIssue(retry, transcript) : 'failed';
  if (!b) return { draft: retry, used: 'retry', before: a, after: '' };
  if (a === 'loop' && b !== 'loop' && retry) return { draft: retry, used: 'retry', before: a, after: b };   // a loop is worse than a missing plan
  return { draft: original, used: 'original', before: a, after: b };
}

export const RETRY_NOTE = '\n\nIMPORTANT: your previous attempt did not give a usable note. Write each fact once (never repeat a line), keep every list short, and make sure the assessment_and_plan section is complete, with one numbered problem for every issue discussed.';
