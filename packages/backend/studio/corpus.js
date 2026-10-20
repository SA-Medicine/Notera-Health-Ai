// Corpus manager: the gold (transcript -> doctor note) pairs, indexed by STYLE and DATE. READ-ONLY analysis for Studio.
// The files carry no creation timestamp, so two proxies are used: the encounter date printed in the transcript header
// ("Transcript started 4:33 PM 12/18/2025") and the import batch (file time inside the image).
// IMPORTANT: this index never feeds the production pipeline. The locked Style Spec v1 is not trained or tuned from it.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const GOLD_DIR = () => process.env.GOLD_DIR || path.resolve(process.cwd(), '..', '..', 'data', 'gold');
const FIRST_RECENT_MONTH = '2026-04';

export function parseGold(text) {
  const i = text.indexOf('Subjective:'); if (i < 0) return null;
  const tx = text.slice(0, i).trim(), note = text.slice(i).trim();
  const m = tx.match(/Transcript started\s+\d{1,2}:\d{2}\s*(?:AM|PM)?\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  const subj = (note.match(/Subjective:([\s\S]*?)(?:\n\s*Past Medical History:|\n\s*Objective:)/) || [, ''])[1];
  const obj = (note.match(/Objective:([\s\S]*?)(?:\n\s*Assessment)/) || [, ''])[1];
  const heads = (re, s) => (s.match(re) || []).length;
  const HEAD = /^\s*[A-Z][A-Za-z &/,'-]{2,40}:\s*$/gm;
  return {
    transcript: tx, note, month: m ? `${m[3]}-${m[1].padStart(2, '0')}` : null,
    subjectiveTopics: heads(HEAD, subj) >= 2, objectiveTopics: heads(HEAD, obj) >= 2,
    subjectiveLines: subj.split('\n').filter((l) => l.trim()).length, noteWords: note.split(/\s+/).length, transcriptWords: tx.split(/\s+/).length,
    labelled: /Treatment planned:|Investigations planned:/i.test(note), numberedPlan: /\n\s*1\.\s/.test(note.slice(note.indexOf('Assessment') >= 0 ? note.indexOf('Assessment') : 0)),
  };
}

export function buildIndex(dir = GOLD_DIR()) {
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.txt'))) {
    const p = path.join(dir, f); const g = parseGold(fs.readFileSync(p, 'utf8')); if (!g) continue;
    const { transcript, note, ...feat } = g;
    rows.push({ id: f.replace(/\.txt$/, ''), batch: fs.statSync(p).mtime.toISOString().slice(0, 10), ...feat });
  }
  return rows;
}

const inRecent = (r) => r.subjectiveTopics || (r.month && r.month >= FIRST_RECENT_MONTH);
export const POOLS = {
  all: () => true,
  topic_style: (r) => r.subjectiveTopics,
  recent_style: inRecent,
  legacy_style: (r) => !inRecent(r),
};
/** Stable split by hash of the id: 100 frozen test, 50 validation, the rest train. */
export function splitOf(id, rank) { return rank < 100 ? 'test' : rank < 150 ? 'val' : 'train'; }
export function poolIds(rows, name) {
  const f = POOLS[name]; if (!f) throw new Error('unknown pool');
  const ids = rows.filter((r) => f(r) && r.transcriptWords >= 300).map((r) => r.id).sort((a, b) => crypto.createHash('sha1').update(a).digest('hex').localeCompare(crypto.createHash('sha1').update(b).digest('hex')));
  return ids.map((id, i) => ({ id, split: splitOf(id, i) }));
}

export function cohortStats(rows) {
  const mean = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : 0);
  const group = (key) => { const g = {}; for (const r of rows) (g[key(r)] ||= []).push(r); return Object.entries(g).sort().map(([k, a]) => ({ cohort: k, n: a.length,
    topic_headings: +mean(a, (r) => +r.subjectiveTopics).toFixed(2), objective_topics: +mean(a, (r) => +r.objectiveTopics).toFixed(2), subjective_lines: +mean(a, (r) => r.subjectiveLines).toFixed(1),
    note_words: Math.round(mean(a, (r) => r.noteWords)), transcript_words: Math.round(mean(a, (r) => r.transcriptWords)), labelled_plan: +mean(a, (r) => +r.labelled).toFixed(2) })); };
  return { total: rows.length, by_month: group((r) => r.month || 'undated'), by_batch: group((r) => r.batch), pools: Object.fromEntries(Object.keys(POOLS).map((p) => [p, rows.filter(POOLS[p]).length])) };
}
