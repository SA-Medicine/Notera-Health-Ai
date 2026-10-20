import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { conformance, parseRendered, SPEC } from '../studio/conformance.js';
import { normalizeEval, evaluateNote, RUBRIC } from '../studio/evaluator.js';
import { mapEvidence, noteClaims } from '../studio/evidence.js';
import { makeQuestions, answersToProposals } from '../studio/teach.js';
import { diffRendered, inferPreferences } from '../studio/editLearning.js';
import { parseGold, buildIndex, poolIds, cohortStats } from '../studio/corpus.js';
import { exportTuning } from '../studio/tuning.js';
import { runGate } from '../studio/gate.js';
import { parseJson } from '../studio/llm.js';

const GOOD = `### Subjective
**Presenting Complaint:**
- Right-sided abdominal pain
- Medication refills

**Abdominal Pain:**
- Sharp right-sided pain radiating to back, present for at least 1 year
- Episodes last 5 to 10 minutes, longer last night
- Denies nausea or fever

### Past Medical History
- Fatty liver
- Hypothyroidism
- Medications: perindopril plus 1 daily, metoprolol twice daily

### Objective
- Abdomen: tenderness in right upper quadrant
- Bloods (Apr 2025): Hb 139; LDL 4 (high); sodium, potassium, renal function normal

### Assessment & Plan
1. **Right upper quadrant abdominal pain**
   - Investigations planned: Ultrasound abdomen (Bell River)
2. **Hypertension**
   - Diagnosis: Hypertension
   - Treatment planned: Continue perindopril plus 1 daily; continue metoprolol twice daily
`;
const BAD = `### Subjective
- The patient presents with right-sided abdominal pain that has been ongoing for approximately one year and is described as sharp and wrapping around to the back and worse after eating but not fatty foods.
- Right-sided abdominal pain that has been ongoing for approximately one year and is described as sharp and wrapping around to the back and worse after eating.
- Worse after eating but not fatty foods
- Denies nausea or fever

### Past Medical History
- Lives in Lake Shore, East Pike Creek
- Preventive care: none mentioned.
- Medications: Synthroid 88 mcg, metoprolol, Senna, senna

### Objective
**Vital Signs**
- Blood pressure stable per history
- Patient reports feeling well

### Assessment & Plan
1. **Right upper quadrant pain, rule out gallbladder vs liver**
   - Diagnosis: Right upper quadrant pain
   - Patient reports pain after eating.
   - Investigations planned: Ultrasound abdomen and pelvis
   - Investigations planned: ultrasound for abdomen and pelvis
2. **Medication refills**
   - Treatment planned: Refill metoprolol
`;
const fake = (obj) => ({ generateContent: async () => JSON.stringify(obj) });

test('a note in the approved format passes every Style Spec v1 check', () => {
  const c = conformance(GOOD); assert.deepEqual(c.failed, [], JSON.stringify(c.failed)); assert.equal(c.score, 1);
});
test('a note in the old flat style fails the checks it should', () => {
  const c = conformance(BAD); const rules = new Set(c.failed.map((f) => f.rule));
  for (const r of ['S1', 'S2', 'S4', 'P3', 'P4', 'O1', 'O3', 'A2', 'A3', 'A4', 'A5', 'A7', 'G1']) assert.ok(rules.has(r), `rule ${r} should fail: ${JSON.stringify(c.failed.map((f) => f.rule))}`);
  assert.ok(c.score < 0.6);
});
test('the parser understands topics, bullets, numbered problems and plan labels', () => {
  const P = parseRendered(GOOD); assert.equal(P.Subjective.filter((x) => x.type === 'head').length, 2); assert.equal(P.plan.length, 2);
  assert.equal(P.plan[1].items[1].label, 'Treatment planned'); assert.ok(SPEC.rules.length >= 19);
});

test('evaluator normalises a model reply into rubric scores and CREOLA errors', async () => {
  const n = normalizeEval({ scores: { accurate: 5, thorough: 9, useful: 'x' }, errors: [{ kind: 'omission', subtype: 'plan', severity: 'major', text: 'follow-up missing' }, { kind: 'hallucination', severity: 'weird' }], would_sign: false });
  assert.equal(n.scores.thorough, 5); assert.equal(n.scores.useful, null); assert.equal(n.major_errors, 1); assert.equal(n.errors[1].severity, 'minor'); assert.equal(n.would_sign, false);
  const e = await evaluateNote({ transcript: 'x', rendered: GOOD, llm: fake({ scores: Object.fromEntries(RUBRIC.map((r) => [r.id, 4])), errors: [] }) });
  assert.equal(e.overall, 4);
});
test('evidence: a quote that is not in the transcript is downgraded to unverified, never trusted', async () => {
  const tx = 'Doctor: any nausea or fever? Patient: no nausea, no fever. The pain is sharp on the right side and goes around to the back for a year.';
  const claims = noteClaims(GOOD); const c1 = claims.find((c) => /Denies nausea/.test(c.text)); const c2 = claims.find((c) => /Sharp right-sided/.test(c.text));
  const ev = await mapEvidence({ transcript: tx, rendered: GOOD, llm: fake({ claims: [{ id: c1.id, verdict: 'supported', quote: 'no nausea, no fever' }, { id: c2.id, verdict: 'supported', quote: 'the pain started after lifting a box' }] }) });
  assert.equal(ev.claims.find((c) => c.id === c1.id).verdict, 'supported'); assert.equal(ev.claims.find((c) => c.id === c2.id).verdict, 'unverified');
  assert.ok(ev.claims.filter((c) => c.verdict === 'unsupported').length > 3, 'lines the model did not mention are unsupported');
});
test('teach: questions are cleaned and answers become PHI-free proposals; unanswered questions create none', async () => {
  const qs = await makeQuestions({ transcript: 't', rendered: GOOD, conformance: { failed: [] }, llm: fake({ questions: [{ id: 'q1', section: 'Subjective', question: 'Short or full sentences?', evidence: 'Episodes last 5 to 10 minutes', options: [{ id: 'a', label: 'Short clauses', meaning: 'keep' }, { id: 'b', label: 'Sentences', meaning: 'use sentences' }, { label: '' }] }, { question: '' }] }) });
  assert.equal(qs.length, 1); assert.equal(qs[0].options.length, 2);
  const props = await answersToProposals({ questions: qs, answers: { q1: { option: 'b', text: 'Always full sentences for the history' } }, llm: fake({ proposals: [{ title: 'Full sentences', section: 'Subjective', kind: 'change_rule', rule: 'Write the Subjective history in full sentences.', replaces: 'S2' }] }) });
  assert.equal(props.length, 1); assert.equal(props[0].replaces, 'S2');
  assert.deepEqual(await answersToProposals({ questions: qs, answers: {}, llm: fake({ proposals: [{ title: 'x', rule: 'y' }] }) }), []);
});
test('edit learning: deletions, additions and rewordings are separated and the edit rate is measured', async () => {
  const before = GOOD; const after = GOOD.replace('- Medication refills\n', '').replace('Denies nausea or fever', 'No nausea or fever').replace('- Fatty liver', '- Fatty liver\n- Appendectomy 2010');
  const d = diffRendered(before, after);
  assert.equal(d.removed.length, 1); assert.equal(d.added.length, 1); assert.equal(d.reworded.length, 1); assert.ok(d.edit_rate > 0 && d.edit_rate < 0.4);
  assert.equal(diffRendered(before, before).edit_rate, 0);
  const props = await inferPreferences({ diff: d, llm: fake({ proposals: [{ title: 'No refill line in the complaint list', section: 'Subjective', kind: 'remove_rule', rule: 'Do not list medication refills as a presenting complaint.', because: 'deleted' }] }) });
  assert.equal(props.length, 1); assert.equal((await inferPreferences({ diff: diffRendered(before, before), llm: fake({}) })).length, 0);
});
test('corpus: style and date features, pools and a stable split; tuning export writes files and starts nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-'));
  const tx = (d) => `Transcript started 4:33 PM ${d}\n\n` + 'Doctor: how are you feeling today. Patient: my knee hurts when I climb stairs and it has for weeks. '.repeat(25);
  fs.writeFileSync(path.join(dir, 'old.txt'), tx('12/18/2025') + '\n\nSubjective:\n\n- Knee pain\n- 3 weeks\n\nPast Medical History:\n\n- None\n\nObjective:\n\n- Knee: tender\n\nAssessment & Plan:\n\n1. Knee pain\n- Treatment planned: ice\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), tx('05/02/2026') + '\n\nSubjective:\n\nPresenting Complaint:\n\n- Knee pain\n\nAggravating Factors:\n\n- Stairs\n\nPast Medical History:\n\n- None\n\nObjective:\n\n- Knee: tender\n\nAssessment & Plan:\n\n1. Knee pain\n- Treatment planned: ice\n');
  const g = parseGold(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8')); assert.equal(g.subjectiveTopics, true); assert.equal(g.month, '2026-05');
  const rows = buildIndex(dir); assert.equal(rows.length, 2);
  assert.deepEqual(poolIds(rows, 'recent_style').map((x) => x.id), ['new']); assert.deepEqual(poolIds(rows, 'legacy_style').map((x) => x.id), ['old']);
  assert.equal(cohortStats(rows).pools.topic_style, 1);
  const out = path.join(dir, 'out'); const m = exportTuning({ pool: 'recent_style', outDir: out, goldDir: dir });
  assert.equal(m.counts.test + m.counts.val + m.counts.train, 1); const jl = fs.readFileSync(path.join(out, 'recent_style.test.jsonl'), 'utf8').trim();
  assert.ok(JSON.parse(jl).contents[1].parts[0].text.startsWith('Subjective:'));
});
test('gate: scores generated notes with the Style Spec checks and reports the failing rules', async () => {
  const r = await runGate({ items: [{ id: 'a', transcript: 'x' }, { id: 'b', transcript: 'y' }, { id: 'c', transcript: 'z' }], generate: async (t) => { if (t === 'z') throw new Error('boom'); return t === 'x' ? GOOD : BAD; } });
  assert.equal(r.summary.generated, 2); assert.equal(r.summary.failed, 1); assert.ok(r.summary.failures_by_rule.S1 >= 1); assert.equal(r.summary.notes_at_90, 0.5);
});
test('parseJson tolerates fences and surrounding text', () => { assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 }); assert.deepEqual(parseJson('here: {"a":2} done'), { a: 2 }); assert.equal(parseJson('nope'), null); });
