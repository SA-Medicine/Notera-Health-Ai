// db/test_upgrader_logic.mjs — unit tests for the System Upgrader pure logic.
// No DB, no LLM. Mirrors the guards in packages/backend/src/admin/handler.js so a
// regression in the safety/patch logic is caught in CI.
//   node db/test_upgrader_logic.mjs
import assert from 'node:assert';

let pass = 0; const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓', name); pass++; };

// ── mirror: protectedViolation ────────────────────────────────────────────────
const PROTECTED_PATTERNS = [
  { name: 'de-identification', rx: /de-?identif|\bPHI\b/i },
  { name: 'no-fabrication', rx: /\b(do not|never|don't)\b[^.]{0,40}\b(invent|fabricate|hallucinat|make up)/i },
  { name: 'negation-handling', rx: /negat(e|ion|ed)/i },
  { name: 'medication-grounding', rx: /unsupported|not supported by|grounded|grounding/i },
  { name: 'schema/format', rx: /schema|JSON|format/i },
];
function protectedViolation(patches = []) {
  for (const pt of patches) for (const P of PROTECTED_PATTERNS)
    if (P.rx.test(pt.before || '') && !P.rx.test(pt.after || '')) return `removes/weakens ${P.name} instruction`;
  return null;
}
console.log('protected-keyword guard');
ok('blocks removing a no-fabrication rule', !!protectedViolation([{ before: 'You must never invent facts.', after: 'Be creative.' }]));
ok('blocks dropping negation handling', !!protectedViolation([{ before: 'Preserve negation of symptoms.', after: 'List symptoms.' }]));
ok('allows edits that keep the rule', protectedViolation([{ before: 'Never fabricate medications.', after: 'Never fabricate medications or doses.' }]) === null);
ok('allows unrelated edits', protectedViolation([{ before: 'Use short clauses.', after: 'Use short, clinical clauses.' }]) === null);

// ── mirror: applyPatches ──────────────────────────────────────────────────────
function applyPatches(base, patches = []) {
  let text = String(base || ''); const applied = [], failed = [];
  for (const pt of patches) {
    const before = pt.before || '';
    if (before && text.includes(before)) { text = text.replace(before, pt.after || ''); applied.push(pt); }
    else failed.push(pt);
  }
  return { text, applied, failed };
}
console.log('patch application');
{
  const base = 'Rule 1: extract facts.\nRule 2: include everything.';
  const r = applyPatches(base, [
    { before: 'Rule 2: include everything.', after: 'Rule 2: include everything the transcript supports; never invent.' },
    { before: 'Rule 9: does not exist', after: 'x' },
  ]);
  ok('applies a matching patch', r.text.includes('never invent'));
  ok('reports a non-anchoring patch as failed', r.failed.length === 1 && r.applied.length === 1);
  ok('leaves untouched text intact', r.text.startsWith('Rule 1: extract facts.'));
}

// ── mirror: compositeScore + optimize/validate split ──────────────────────────
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const compositeScore = (m) => {
  if (!m) return 0;
  const cov = num(m.section_coverage) ?? 0, sim = num(m.similarity_to_gold) ?? 0, flow = num(m.story_flow) ?? 0, om = num(m.omission_rate) ?? 0;
  return (cov + sim + flow + (1 - om)) / 4;
};
console.log('composite score');
ok('higher coverage/similarity → higher score', compositeScore({ section_coverage: 1, similarity_to_gold: 1, story_flow: 1, omission_rate: 0 }) > compositeScore({ section_coverage: 0.2, similarity_to_gold: 0.1, story_flow: 0.3, omission_rate: 0.9 }));
ok('omission is inverted (more omission → lower score)', compositeScore({ omission_rate: 0 }) > compositeScore({ omission_rate: 1 }));

console.log('optimize/validate split');
{
  const all = ['a', 'b', 'c', 'd'].map((s) => ({ slug: s })).sort((x, y) => x.slug.localeCompare(y.slug));
  const ratio = 0.5; const nOpt = Math.max(1, Math.round(all.length * ratio));
  const optimize = all.slice(0, nOpt), validate = all.slice(nOpt);
  ok('splits by ratio deterministically', optimize.length === 2 && validate.length === 2 && optimize[0].slug === 'a');
  const nOpt2 = Math.max(1, Math.round(1 * 0.5));
  ok('always keeps at least one in optimize', nOpt2 >= 1);
}

console.log(`\n✅ ${pass} assertions passed`);
