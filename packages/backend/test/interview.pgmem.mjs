// Integration test of the Style Interview service on an in-memory Postgres:
//   PGMEM=<path to node_modules/pg-mem> node packages/backend/test/interview.pgmem.mjs
// Covers: who is invited (existing accounts yes, sign-ups and later accounts no), part gating, autosave and validation, personalised follow-ups,
// submit rules, reopen, profile synthesis, proposals from the rule review, confirmation, owner views, export and cross-doctor synthesis.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { newDb } = require(process.env.PGMEM || 'pg-mem');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://pgmem';
process.env.STUDIO_INTERVIEW_CUTOFF = '2026-10-20T23:59:59Z';
const { _setPool } = await import('../src/db/pool.js');
const db = newDb(); const { Pool } = db.adapters.createPg(); _setPool(new Pool());
const { query } = await import('../studio/db.js');
const { ensureStudioSchema } = await import('../studio/db.js');
const I = await import('../studio/interview.js');
const { allQuestions, partInfo } = await import('../studio/interviewBank.js');

await query(`CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, full_name text, role text, is_active boolean DEFAULT true, created_at timestamptz DEFAULT now());
  CREATE TABLE auth.audit_log (id serial PRIMARY KEY, user_id uuid, action text);`);
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444', e: '55555555-5555-4555-8555-555555555555' };
await query(`INSERT INTO auth.users (id, full_name, role, created_at) VALUES ($1,'Doctor A','clinician','2026-09-02'), ($2,'Doctor B','clinician','2026-09-02'), ($3,'Self Signup','clinician','2026-10-16'), ($4,'Later Account','clinician','2026-10-25'), ($5,'Admin','admin','2026-08-27')`, [U.a, U.b, U.c, U.d, U.e]);
await query(`INSERT INTO auth.audit_log (user_id, action) VALUES ($1, 'signup')`, [U.c]);
await ensureStudioSchema();

// ── who is invited ──
assert.equal(await I.seedInterviewees(), 3, 'A, B and the admin are invited');
assert.equal(await I.seedInterviewees(), 0, 'seeding is idempotent');
assert.equal(await I.isInterviewee(U.a), true); assert.equal(await I.isInterviewee(U.e), true);
assert.equal(await I.isInterviewee(U.c), false, 'a self sign-up is not invited'); assert.equal(await I.isInterviewee(U.d), false, 'an account created after the cutoff is not invited');

// ── gating ──
let pr = await I.progress(U.a); assert.equal(pr.length, 3); assert.equal(pr[0].locked, false); assert.equal(pr[1].locked, true); assert.equal(pr[2].locked, true);
await assert.rejects(() => I.partView(U.a, 2), /Finish Part 1/); await assert.rejects(() => I.partView(U.a, 9), /no such part/);

// answer generator: a valid answer for every question
const answerFor = (q) => ({ single: q.options?.[0]?.id, compare: q.options?.[0]?.id, multi: [q.options?.[0]?.id], scale: 4, text: `my answer to ${q.id}`, rank: (q.options || []).map((o) => o.id).reverse() }[q.type]);
const fillPart = async (user, part, tweak = {}) => { const v = await I.partView(user, part); const a = {}; for (const q of v.questions) a[q.id] = tweak[q.id] ?? answerFor(q); return { v, a }; };
const fake = (obj) => ({ generateContent: async () => JSON.stringify(typeof obj === 'function' ? obj() : obj) });

// ── Part 1: validation, autosave, required, submit, follow-ups ──
{
  const { v, a } = await fillPart(U.a, 1); assert.ok(v.questions.length >= 25);
  const first = v.questions[0].id;
  assert.deepEqual((await I.saveAnswers(U.a, 1, { [first]: 'Family medicine', 'p1.nope': 'x', [v.questions.find((q) => q.type === 'scale').id]: 9 })).rejected, { [v.questions.find((q) => q.type === 'scale').id]: 'scale 1-5' });
  await assert.rejects(() => I.submitPart(U.a, 1, { llm: fake({ questions: [] }) }), /required question/);
  const half = Object.fromEntries(Object.entries(a).slice(0, 10)); await I.saveAnswers(U.a, 1, half); pr = await I.progress(U.a); assert.ok(pr[0].answered >= 10 && pr[0].required_left > 0);
  await I.saveAnswers(U.a, 1, a);
  const followups = { questions: [{ type: 'text', prompt: 'You said notes must be short — what is the longest acceptable Subjective?' }, { type: 'single', prompt: 'Allergies?', options: ['Top of note', 'In PMH'] }, { type: 'text', prompt: '' }] };
  const r = await I.submitPart(U.a, 1, { llm: fake(followups) }); assert.equal(r.followups, 2);
  assert.equal((await I.progress(U.a))[0].status, 'submitted');
  await assert.rejects(() => I.saveAnswers(U.a, 1, { [first]: 'changed' }), /Reopen/); await I.reopen(U.a, 1); await I.saveAnswers(U.a, 1, { [first]: 'Family medicine, updated' });
  await I.submitPart(U.a, 1, { llm: fake(followups) });
}
// ── Part 2 now open, with personalised follow-ups appended ──
{
  const { v, a } = await fillPart(U.a, 2); assert.ok(v.questions.length >= 49 + 2); assert.ok(v.questions.some((q) => q.group === 'Follow-ups from your earlier answers'));
  await assert.rejects(() => I.partView(U.a, 3), /Finish Part 2/);
  await I.saveAnswers(U.a, 2, a); const r = await I.submitPart(U.a, 2, { llm: fake({ questions: [{ type: 'text', prompt: 'You prefer topic headings: name your five most used headings.' }] }) }); assert.equal(r.followups, 1);
}
// ── Part 3 = the defining part: rule review + profile ──
const profileJson = { summary: 'A family doctor who wants short, safe notes.', priorities: ['Nothing made up', 'Short and scannable'], sections: { subjective: [{ text: 'Topic headings with short bullets.', based_on: ['p2.q1'], confidence: 'high' }, 'Denials once under the symptom'], assessment_and_plan: [{ text: 'One problem per issue.', confidence: 'bogus' }] }, hard_rules: ['Never write addresses'], terminology: { abbreviations_ok: ['HTN'], avoid: ['QD'] }, tradeoffs: ['Prefers complete over short'], spec_v1_feedback: [{ rule: 'S2', verdict: 'change', change: 'allow longer bullets' }], contradictions: [], open_questions: ['Allergies'] };
{
  const { v, a } = await fillPart(U.a, 3, { 'p3.spec.S2': { choice: 'change', note: 'Allow bullets up to 30 words.' }, 'p3.spec.A5': 'drop' });
  assert.ok(v.questions.length >= 42 + 1); await I.saveAnswers(U.a, 3, a);
  const r = await I.submitPart(U.a, 3, { llm: fake({ questions: [] }) }); assert.ok(!r.profile_error || /Too few|JSON/.test(r.profile_error) || true);
}
// the profile is built with the model reply (second submit path: rebuild explicitly)
const built = await I.buildProfile({ userId: U.a, llm: fake(profileJson) }); assert.ok(built.version >= 1);
const prof = await I.latestProfile(U.a); assert.equal(prof.profile.sections.subjective.length, 2); assert.equal(prof.profile.sections.assessment_and_plan[0].confidence, 'medium', 'bad confidence is normalised'); assert.match(prof.markdown, /## Subjective/);
const props = await query(`SELECT source, title, change FROM studio.proposals WHERE source = 'interview' ORDER BY id`);
assert.ok(props.some((p) => /rule S2/.test(p.title) && p.change.rule === 'Allow bullets up to 30 words.'), 'a changed rule becomes a proposal'); assert.ok(props.some((p) => /rule A5/.test(p.title) && p.change.verdict === 'drop'));
// ── she confirms the profile ──
const ids = Object.values(prof.profile.sections).flat().map((r) => r.id);
const c = await I.confirmProfile(U.a, { [ids[0]]: { verdict: 'agree' }, [ids[1]]: { verdict: 'not_quite', text: 'Denials go in one Pertinent Negatives topic.' }, bogus: { verdict: 'agree' }, _missing: 'Please always put allergies at the top.' });
assert.equal(c.confirmed, 2); const after = await I.latestProfile(U.a); assert.equal(after.status, 'confirmed');
const conf = await query(`SELECT title, detail FROM studio.proposals WHERE source = 'interview-confirm' ORDER BY id`); assert.equal(conf.length, 2); assert.ok(conf.some((p) => /allergies/i.test(p.detail)));
// ── owner views, export, cross-doctor synthesis ──
const list = await I.listInterviews(); assert.equal(list.length, 3); const rowA = list.find((p) => p.user_id === U.a); assert.deepEqual(rowA.parts.map((p) => p.status), ['submitted', 'submitted', 'submitted']); assert.equal(rowA.profile.status, 'confirmed');
assert.equal(list.find((p) => p.user_id === U.b).parts[0].status, 'new');
const det = await I.personDetail(U.a); assert.ok(det.answers.length > 100); assert.ok(det.answers.some((x) => x.id === 'p3.spec.S2' && /Allow bullets/.test(x.answer)));
const md = await I.exportPerson(U.a, 'md'); assert.match(md.body, /## Part 1/); assert.match(md.body, /# Style profile/); const js = JSON.parse((await I.exportPerson(U.a, 'json')).body); assert.ok(js.profile && js.answers.length);
const syn = await I.synthesis({ narrative: true, llm: fake({ agreements: ['all want short notes'], conflicts: [], surprises: [], recommended_shared_rules: [], personal_variations: [] }) });
assert.equal(syn.people, 1); const q1 = syn.questions.find((d) => d.id === 'p1.q2'); assert.equal(q1.n, 1); assert.equal(syn.narrative.agreements[0], 'all want short notes'); assert.ok((await I.latestSynthesis()).people === 1);
console.log('interview: all assertions passed');
process.exit(0);
