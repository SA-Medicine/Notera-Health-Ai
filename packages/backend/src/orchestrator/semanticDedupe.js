// ─────────────────────────────────────────────────────────────────────────────
// semanticDedupe — LLM pass that catches the duplicates lexical similarity cannot.
//
// dedupeNote removes repeats that share wording. It cannot see that "Hb not
// improving despite oral iron" and "Anaemia has not responded to iron
// supplementation" are one clinical point — that needs meaning, not word overlap.
//
// SAFETY MODEL — the model never writes note text:
//   • it receives the note as NUMBERED lines grouped under their section (and, in the
//     Assessment & Plan, under their problem heading) and returns only groups of line
//     IDs that state the same clinical point;
//   • we keep one line per group (the most informative, chosen deterministically) and
//     delete the others. Unknown IDs, single-member groups and overlapping groups are
//     discarded;
//   • a group is rejected outright when its members sit in different sections, in
//     different Assessment & Plan fields, under problems whose titles conflict, or when
//     they CONFLICT on numbers, on drug/analyte names, or on a meaning axis
//     (left/right, improving/worsening, start/stop, negated/affirmed) — so a wrong call
//     by the model cannot merge two clinically different statements;
//   • every section keeps at least one line, and an A&P problem is never emptied;
//   • any error, bad JSON or timeout leaves the note exactly as it was.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { conflictReason, moreInformative, signature } from '../validation/textSimilarity.js';

const splitLines = (v) => String(v == null ? '' : v).split('\n').map((x) => x.trim()).filter(Boolean);
const splitSentences = (line) => String(line)
  .split(/(?<=[a-z0-9]{3}[.!?])\s+(?=[A-Z(])/)
  .map((s) => s.trim())
  .filter(Boolean);
const toUnits = (v) => splitLines(v).flatMap(splitSentences);

const AP_FIELDS = ['assessment', 'investigations_planned', 'treatment_planned', 'referrals'];

const SECTIONS = [
  { key: 'subjective', label: 'SUBJECTIVE' },
  { key: 'past_medical_history', label: 'PAST MEDICAL HISTORY' },
  { key: 'objective', label: 'OBJECTIVE' },
];

const FIELD_LABEL = {
  assessment: 'Assessment', investigations_planned: 'Investigations',
  treatment_planned: 'Treatment', referrals: 'Referrals',
};

const SYS = `You are a clinical documentation de-duplication reviewer. You are given a SOAP note as numbered lines, grouped by section.

Your ONLY job: find sets of lines that state the SAME clinical point — including when they are worded completely differently (paraphrases, restatements, one line summarising another).

Report each set as a group of line numbers.

A group is correct ONLY when every line in it carries the SAME clinical information. Lines are NOT duplicates if they differ in ANY of these ways:
- different numeric values (a different lab value, dose, blood pressure, interval, date)
- different medications, tests or body sites
- different laterality (left vs right), different severity, or a different time point
- one is affirmed and the other negated ("controlled" vs "not controlled", "fever" vs "no fever")
- opposite direction or trajectory (increase vs decrease, improving vs worsening, start vs stop)
- one is an interpretation and the other is a distinct ACTION to take
- one adds a clinically meaningful qualifier the other lacks (cause, trigger, response to treatment)
- they belong to different numbered problems that are genuinely different conditions

Only group lines that sit in the SAME section. In the Assessment & Plan, only group lines that sit under the same kind of heading (Assessment with Assessment, Treatment with Treatment).

When unsure, DO NOT group. A missed duplicate is harmless; a wrong merge loses clinical information.

Return STRICT JSON only:
{"duplicate_groups": [[2, 7], [11, 12, 15]]}
Use an empty array when there are no duplicates.`;

/**
 * Flatten the note into addressable units, and build the listing the model sees.
 * @returns {{units:Array, listing:string}}
 */
function collectUnits(note) {
  const units = [];
  const lines = [];
  const add = (u) => { units.push(u); lines.push(`${u.id}. ${u.text}`); };

  for (const { key, label } of SECTIONS) {
    const section = note[key];
    if (!section) continue;
    const fields = Object.keys(section).filter((f) => typeof section[f] === 'string' && section[f].trim());
    if (!fields.length) continue;
    lines.push(`\n## ${label}`);
    for (const field of fields) {
      for (const text of toUnits(section[field])) {
        add({ id: units.length + 1, scope: key, section: key, field, text, sig: signature(text) });
      }
    }
  }

  const ap = Array.isArray(note.assessment_and_plan) ? note.assessment_and_plan : [];
  if (ap.length) {
    lines.push('\n## ASSESSMENT & PLAN');
    ap.forEach((problem, pi) => {
      const title = String(problem.issue || problem.diagnosis || `Problem ${pi + 1}`).trim();
      lines.push(`\nProblem ${pi + 1}: ${title}`);
      const titleSig = signature(title);
      for (const field of AP_FIELDS) {
        if (problem[field] == null) continue;
        const items = toUnits(problem[field]);
        if (!items.length) continue;
        lines.push(`  ${FIELD_LABEL[field]}:`);
        for (const text of items) {
          add({ id: units.length + 1, scope: 'ap', section: 'ap', field, pi, titleSig, text, sig: signature(text) });
        }
      }
    });
  }
  return { units, listing: lines.join('\n').trim() };
}

/**
 * A group is only usable when every pair in it is safe to merge.
 * @returns {string} '' when safe, otherwise why it was rejected
 */
function groupRejection(members) {
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i];
      const b = members[j];
      if (a.section !== b.section) return `spans ${a.section} and ${b.section}`;
      // In the A&P an interpretation and a plan order are different roles, never
      // duplicates of each other, and two genuinely different problems may legitimately
      // carry the same line (left knee / right knee).
      if (a.section === 'ap') {
        if (a.field !== b.field) return `spans ${a.field} and ${b.field}`;
        if (a.pi !== b.pi) {
          const why = conflictReason(a.titleSig, b.titleSig);
          if (why) return `different problems (${why})`;
        }
      }
      const why = conflictReason(a.sig, b.sig);
      if (why) return why;
    }
  }
  return '';
}

function parseGroups(raw) {
  const s = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let parsed = null;
  try { parsed = JSON.parse(s); } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* give up */ } }
  }
  const groups = parsed && Array.isArray(parsed.duplicate_groups) ? parsed.duplicate_groups : [];
  return groups
    .filter(Array.isArray)
    .map((g) => [...new Set(g.map(Number).filter((n) => Number.isInteger(n) && n > 0))])
    .filter((g) => g.length >= 2);
}

/** Rebuild every field from the units we kept, preserving their original order. */
function applyDrops(note, units, dropIds) {
  const kept = new Map();
  const key = (u) => (u.scope === 'ap' ? `ap|${u.pi}|${u.field}` : `${u.section}|${u.field}`);
  for (const u of units) {
    if (dropIds.has(u.id)) continue;
    const k = key(u);
    if (!kept.has(k)) kept.set(k, []);
    kept.get(k).push(u.text);
  }
  for (const { key: sk } of SECTIONS) {
    const section = note[sk];
    if (!section) continue;
    for (const field of Object.keys(section)) {
      if (typeof section[field] !== 'string' || !section[field].trim()) continue;
      section[field] = (kept.get(`${sk}|${field}`) || []).join('\n');
    }
  }
  (note.assessment_and_plan || []).forEach((problem, pi) => {
    for (const field of AP_FIELDS) {
      if (problem[field] == null) continue;
      problem[field] = (kept.get(`ap|${pi}|${field}`) || []).join('\n');
    }
  });
}

/**
 * Remove semantically duplicate lines from an assembled note.
 * @param {object} note   schema v2 note (mutated in place on success)
 * @param {{llm:object, log?:Function, timeoutMs?:number}} ctx
 * @returns {Promise<{removed:number, groups:number}>}
 */
export async function semanticDedupeNote(note, ctx = {}) {
  const log = ctx.log || (() => {});
  const llm = ctx.llm;
  if (!llm || !note) return { removed: 0, groups: 0 };

  const { units, listing } = collectUnits(note);
  if (units.length < 4) return { removed: 0, groups: 0 };

  let raw;
  try {
    llm._agent = 'semantic-dedupe';
    raw = await llm.generateContent(
      SYS,
      `NOTE LINES:\n${listing}\n\nReturn ONLY the JSON object.`,
      null,
      { timeoutMs: ctx.timeoutMs || 25000, retries: 0, maxOutputTokens: 2048, thinkingBudget: 0 },
    );
  } catch (e) {
    log(`[dedupe:semantic] skipped — ${e.message}`);
    return { removed: 0, groups: 0 };
  }

  const byId = new Map(units.map((u) => [u.id, u]));
  const claimed = new Set();
  const dropIds = new Set();
  let usedGroups = 0;

  for (const group of parseGroups(raw)) {
    const members = group.map((id) => byId.get(id)).filter(Boolean);
    if (members.length < 2) continue;
    if (members.some((m) => claimed.has(m.id))) continue;        // overlapping groups → skip
    const rejection = groupRejection(members);
    if (rejection) {
      log(`[dedupe:semantic] rejected group [${group.join(', ')}] — ${rejection}`);
      continue;
    }
    // Keep the most informative member; delete the rest.
    let keeper = members[0];
    for (const m of members.slice(1)) keeper = moreInformative(keeper.sig, m.sig) === m.sig ? m : keeper;
    usedGroups += 1;
    for (const m of members) {
      claimed.add(m.id);
      if (m === keeper) continue;
      dropIds.add(m.id);
      log(`[dedupe:semantic] dropped paraphrased duplicate: "${m.text.slice(0, 90)}" (kept "${keeper.text.slice(0, 60)}")`);
    }
  }

  if (!dropIds.size) {
    log('[dedupe:semantic] no semantic duplicates found');
    return { removed: 0, groups: 0 };
  }

  // Never let a group empty an A&P problem or a whole section: if every unit of one
  // would go, keep its first line. A bare numbered heading is worse than a repeat.
  const buckets = new Map();
  for (const u of units) {
    const k = u.scope === 'ap' ? `ap|${u.pi}` : u.section;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(u);
  }
  for (const [k, list] of buckets) {
    if (!list.every((u) => dropIds.has(u.id))) continue;
    dropIds.delete(list[0].id);
    log(`[dedupe:semantic] kept "${list[0].text.slice(0, 60)}" — dropping it would have emptied ${k}`);
  }

  applyDrops(note, units, dropIds);
  log(`[dedupe:semantic] removed ${dropIds.size} paraphrased duplicate line(s) across ${usedGroups} group(s)`);
  return { removed: dropIds.size, groups: usedGroups };
}
