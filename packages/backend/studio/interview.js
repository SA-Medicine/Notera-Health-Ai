// The Style Interview service: eligibility, storage with autosave, part gating, personalised follow-ups, the Style Profile synthesised from
// the answers, the doctor's confirmation of it, and the owner's views (per person, export, cross-doctor synthesis).
// Nothing here changes how notes are produced: answers become a stored profile and PROPOSALS for a future spec; the Style Spec v1 is locked.
'use strict';

import { query, one, audit } from './db.js';
import { askJson, MODELS } from './llm.js';
import { bank, partInfo, allQuestions, cleanAnswer, INTERVIEW_VERSION } from './interviewBank.js';
import { SPEC } from './conformance.js';

const CUTOFF = String(process.env.STUDIO_INTERVIEW_CUTOFF || '2026-10-20T23:59:59Z').replace(/[^0-9TZ:.+ -]/g, '');

/** Every account created before the cutoff (by the owner or a script) is invited. Self sign-ups and later accounts are not. Idempotent. */
export async function seedInterviewees() {
  const signups = new Set((await query(`SELECT DISTINCT user_id::text AS id FROM auth.audit_log WHERE action = 'signup'`)).map((r) => r.id));
  const users = await query(`SELECT id::text AS id, full_name FROM auth.users WHERE is_active AND created_at <= '${CUTOFF}'::timestamptz`);
  let added = 0;
  for (const u of users) {
    if (signups.has(u.id)) continue;
    if (await one(`SELECT 1 AS x FROM studio.interviewees WHERE user_id = $1`, [u.id])) continue;      // already invited (or deliberately switched off): leave it alone
    await query(`INSERT INTO studio.interviewees (user_id, full_name, source) VALUES ($1, $2, 'existing') ON CONFLICT (user_id) DO NOTHING`, [u.id, u.full_name]);
    added++;
  }
  return added;
}

export async function isInterviewee(userId) { return !!(await one(`SELECT 1 AS x FROM studio.interviewees WHERE user_id = $1 AND active`, [userId])); }

const humanAnswer = (q, a) => {
  if (a == null) return '(no answer)';
  const label = (id) => (q.options || []).find((o) => o.id === id)?.label || id;
  if (q.type === 'text') return String(a);
  if (q.type === 'scale') return `${a}/5${q.labels ? ` (1 = ${q.labels[0]}, 5 = ${q.labels[1]})` : ''}`;
  if (q.type === 'single' || q.type === 'compare') return typeof a === 'object' ? `${label(a.choice)} — ${a.note}` : label(a);
  if (q.type === 'multi') return (Array.isArray(a) ? a : a.choices).map(label).join('; ') + (a.note ? ` — ${a.note}` : '');
  if (q.type === 'rank') return a.map((id, i) => `${i + 1}. ${label(id)}`).join(' | ');
  return JSON.stringify(a);
};

async function getRow(userId, part) { return one(`SELECT * FROM studio.interviews WHERE user_id = $1 AND part = $2`, [userId, part]); }
async function ensureRow(userId, part) {
  await query(`INSERT INTO studio.interviews (user_id, part) VALUES ($1, $2) ON CONFLICT (user_id, part) DO NOTHING`, [userId, part]);
  return getRow(userId, part);
}
const questionsFor = (part, row) => { const p = partInfo(part); return [...p.questions, ...((row?.followups || []).map((q) => ({ ...q, group: 'Follow-ups from your earlier answers' })))]; };

/** Progress of one person across the three parts. */
export async function progress(userId) {
  const rows = await query(`SELECT part, answers, followups, status, updated_at, submitted_at FROM studio.interviews WHERE user_id = $1`, [userId]);
  const by = Object.fromEntries(rows.map((r) => [r.part, r]));
  return bank().map((p) => {
    const r = by[p.part]; const qs = questionsFor(p.part, r); const ans = r?.answers || {};
    const answered = qs.filter((q) => ans[q.id] != null).length; const requiredLeft = qs.filter((q) => q.required && ans[q.id] == null).length;
    const prev = p.part === 1 ? true : by[p.part - 1]?.status === 'submitted';
    return { part: p.part, title: p.title, minutes: p.minutes, intro: p.intro, total: qs.length, answered, required_left: requiredLeft, status: r?.status || 'new', locked: !prev, updated_at: r?.updated_at || null, submitted_at: r?.submitted_at || null };
  });
}

export async function partView(userId, part) {
  const info = partInfo(part); if (!info) { const e = new Error('no such part'); e.status = 404; throw e; }
  if (part > 1) { const prev = await getRow(userId, part - 1); if (prev?.status !== 'submitted') { const e = new Error(`Finish Part ${part - 1} first.`); e.status = 409; throw e; } }
  const row = await ensureRow(userId, part);
  return { part, title: info.title, intro: info.intro, minutes: info.minutes, status: row.status, questions: questionsFor(part, row), answers: row.answers || {}, version: INTERVIEW_VERSION };
}

/** Autosave: only valid answers are stored; empty ones clear the answer. A submitted part must be reopened first. */
export async function saveAnswers(userId, part, incoming) {
  const row = await ensureRow(userId, part); if (!row) throw new Error('no such part');
  if (row.status === 'submitted') { const e = new Error('This part is submitted. Reopen it to change answers.'); e.status = 409; throw e; }
  const qs = Object.fromEntries(questionsFor(part, row).map((q) => [q.id, q])); const answers = { ...(row.answers || {}) }; const rejected = {};
  for (const [id, raw] of Object.entries(incoming || {})) {
    const q = qs[id]; if (!q) continue;
    const c = cleanAnswer({ ...q, required: false }, raw); if (!c.ok) { rejected[id] = c.why; continue; }
    if (c.value == null) delete answers[id]; else answers[id] = c.value;
  }
  await query(`UPDATE studio.interviews SET answers = $3::jsonb, updated_at = now() WHERE user_id = $1 AND part = $2`, [userId, part, JSON.stringify(answers)]);
  return { saved: Object.keys(incoming || {}).length - Object.keys(rejected).length, rejected };
}

export async function reopen(userId, part) { await query(`UPDATE studio.interviews SET status = 'open', submitted_at = NULL WHERE user_id = $1 AND part = $2`, [userId, part]); return { ok: true }; }

// ── personalised follow-ups ──
export const FOLLOWUP_SYS = `You are a skilled qualitative interviewer helping a physician define exactly how she wants her clinical notes written. You receive her answers so far (question and answer). Ask 6 to 8 FOLLOW-UP questions that dig into what she said: where her answers are vague, where two answers pull in different directions, where she gave a strong opinion or a surprising one, and what a good scribe would still need to know to write a note she would sign without edits.
Rules: quote or refer to her own words; never repeat a question she answered; no patient-specific detail; each question is either type "text" (open) or "single" (2 to 4 options, each with a short label). Keep each under 45 words.
Return JSON {"questions":[{"type":"text|single","prompt":"...","options":["..."]}]}.`;

export async function generateFollowups({ userId, nextPart, llm }) {
  const info = partInfo(nextPart); if (!info) return [];
  const qa = await renderedAnswers(userId, nextPart - 1);
  const out = await askJson({ llm, model: MODELS.judge(), agent: 'studio-interview', system: FOLLOWUP_SYS, maxOutputTokens: 4000, thinkingBudget: 512,
    user: `Her answers so far:\n${qa.map((x) => `- ${x.prompt}\n  → ${x.answer}`).join('\n').slice(0, 40000)}\n\nThe next part of the interview is "${info.title}". Return ONLY the JSON.` });
  return (Array.isArray(out.questions) ? out.questions : []).slice(0, 8).map((q, i) => {
    const type = q.type === 'single' && Array.isArray(q.options) && q.options.length >= 2 ? 'single' : 'text';
    return { id: `p${nextPart}.f${i + 1}`, type, prompt: String(q.prompt || '').slice(0, 400), required: false, ...(type === 'single' ? { options: q.options.slice(0, 4).map((l, j) => ({ id: String.fromCharCode(97 + j), label: String(l).slice(0, 120) })) } : {}) };
  }).filter((q) => q.prompt);
}

export async function renderedAnswers(userId, upToPart = 3) {
  const rows = await query(`SELECT part, answers, followups FROM studio.interviews WHERE user_id = $1 AND part <= $2 ORDER BY part`, [userId, upToPart]);
  const out = [];
  for (const r of rows) for (const q of questionsFor(r.part, r)) if (r.answers?.[q.id] != null) out.push({ part: r.part, id: q.id, group: q.group, type: q.type, prompt: q.prompt, answer: humanAnswer(q, r.answers[q.id]) });
  return out;
}

// ── the Style Profile ──
export const PROFILE_SYS = `You are building a STYLE PROFILE for one physician from her complete note-writing interview. Be faithful to her words; never invent preferences. Where she contradicted herself, say so. Where she did not say, write "not stated".
The profile will be used later to restructure an AI scribe; it must be specific, actionable and short enough to read.
Return JSON {
 "summary":"3-4 sentences who she is and what her notes are for",
 "priorities":["ranked qualities in her order, one short phrase each"],
 "sections":{"subjective":[{"text":"one rule","based_on":["question ids"],"confidence":"high|medium|low"}],"past_medical_history":[...],"objective":[...],"assessment_and_plan":[...],"language":[...],"general":[...]},
 "hard_rules":["her Always/Never rules, cleaned up, in her words"],
 "terminology":{"abbreviations_ok":[],"avoid":[]},
 "tradeoffs":["how she resolves completeness vs brevity, flag vs omit, strict vs flexible, etc."],
 "spec_v1_feedback":[{"rule":"S1","verdict":"keep|change|drop","change":"what she wants"}],
 "contradictions":["where her answers conflict"],
 "open_questions":["what is still unclear and should be asked next"]
}
Every rule is one sentence a writer could follow. 6 to 14 rules per section where she gave enough information. Cite question ids in based_on.`;

export async function buildProfile({ userId, llm }) {
  const qa = await renderedAnswers(userId, 3); if (qa.length < 20) { const e = new Error('Too few answers to build a profile.'); e.status = 409; throw e; }
  const out = await askJson({ llm, model: MODELS.judge(), agent: 'studio-profile', system: PROFILE_SYS, maxOutputTokens: 12000, thinkingBudget: 2048, timeoutMs: 240000,
    user: `The approved Style Spec v1 rules (for her rule-by-rule review): ${SPEC.rules.map((r) => `${r.id} ${r.text}`).join(' | ')}\n\nHER ANSWERS:\n${qa.map((x) => `[${x.id}] ${x.prompt}\n  → ${x.answer}`).join('\n').slice(0, 90000)}\n\nReturn ONLY the JSON.` });
  // ids for every rule so she can confirm them one by one
  let n = 0; const sections = {};
  for (const [k, arr] of Object.entries(out.sections || {})) sections[k] = (Array.isArray(arr) ? arr : []).slice(0, 16).map((r) => ({ id: `r${++n}`, text: String(r.text || r).slice(0, 400), based_on: Array.isArray(r.based_on) ? r.based_on.slice(0, 6).map(String) : [], confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'medium' }));
  const list = (a, m = 14, l = 300) => (Array.isArray(a) ? a.slice(0, m).map((x) => String(x).slice(0, l)) : []);
  const profile = { summary: String(out.summary || '').slice(0, 1200), priorities: list(out.priorities, 10, 120), sections, hard_rules: list(out.hard_rules, 14), terminology: { abbreviations_ok: list(out.terminology?.abbreviations_ok, 30, 30), avoid: list(out.terminology?.avoid, 30, 40) },
    tradeoffs: list(out.tradeoffs, 10), spec_v1_feedback: (Array.isArray(out.spec_v1_feedback) ? out.spec_v1_feedback : []).slice(0, 30).map((f) => ({ rule: String(f.rule || '').slice(0, 8), verdict: ['keep', 'change', 'drop'].includes(f.verdict) ? f.verdict : 'keep', change: String(f.change || '').slice(0, 300) })),
    contradictions: list(out.contradictions, 10), open_questions: list(out.open_questions, 10), interview_version: INTERVIEW_VERSION };
  const v = (await one(`SELECT coalesce(max(version), 0) + 1 AS v FROM studio.style_profiles WHERE user_id = $1`, [userId])).v;
  const row = await one(`INSERT INTO studio.style_profiles (user_id, version, profile, markdown) VALUES ($1, $2, $3::jsonb, $4) RETURNING id, version, created_at`, [userId, v, JSON.stringify(profile), profileMarkdown(profile)]);
  // rule-by-rule changes asked for in the interview become proposals (never applied)
  const rows = await query(`SELECT answers FROM studio.interviews WHERE user_id = $1 AND part = 3`, [userId]); const a = rows[0]?.answers || {}; let made = 0;
  for (const r of SPEC.rules) {
    const raw = a[`p3.spec.${r.id}`]; const choice = typeof raw === 'object' ? raw.choice : raw; const note = typeof raw === 'object' ? raw.note : '';
    if (choice === 'change' || choice === 'drop') { await query(`INSERT INTO studio.proposals (source, reviewer_id, section, title, detail, change) VALUES ('interview', $1, $2, $3, $4, $5::jsonb)`, [userId, r.section, `${choice === 'drop' ? 'Drop' : 'Change'} rule ${r.id}: ${r.text}`.slice(0, 140), note || '', JSON.stringify({ rule: note || `(${choice})`, replaces: r.id, verdict: choice })]); made++; }
  }
  return { ...row, profile, proposals: made };
}

export function profileMarkdown(p) {
  const L = [`# Style profile`, '', p.summary || '', ''];
  if (p.priorities?.length) L.push('## What matters most (in her order)', ...p.priorities.map((x, i) => `${i + 1}. ${x}`), '');
  const T = { subjective: 'Subjective', past_medical_history: 'Past Medical History', objective: 'Objective', assessment_and_plan: 'Assessment & Plan', language: 'Language', general: 'General' };
  for (const [k, arr] of Object.entries(p.sections || {})) if (arr.length) L.push(`## ${T[k] || k}`, ...arr.map((r) => `- ${r.text}${r.confidence === 'low' ? ' _(low confidence)_' : ''}`), '');
  if (p.hard_rules?.length) L.push('## Hard rules', ...p.hard_rules.map((x) => `- ${x}`), '');
  if (p.tradeoffs?.length) L.push('## Trade-offs', ...p.tradeoffs.map((x) => `- ${x}`), '');
  if (p.terminology?.abbreviations_ok?.length || p.terminology?.avoid?.length) L.push('## Terminology', `- Fine: ${(p.terminology.abbreviations_ok || []).join(', ') || '—'}`, `- Avoid: ${(p.terminology.avoid || []).join(', ') || '—'}`, '');
  if (p.spec_v1_feedback?.length) L.push('## Review of the approved format', ...p.spec_v1_feedback.map((f) => `- ${f.rule}: ${f.verdict}${f.change ? ' — ' + f.change : ''}`), '');
  if (p.contradictions?.length) L.push('## Contradictions to resolve', ...p.contradictions.map((x) => `- ${x}`), '');
  if (p.open_questions?.length) L.push('## Still to ask', ...p.open_questions.map((x) => `- ${x}`), '');
  return L.join('\n');
}

/** Submit a part: required questions must be answered. Part 1 and 2 prepare follow-ups for the next part; Part 3 builds the profile. */
export async function submitPart(userId, part, { llm } = {}) {
  const row = await ensureRow(userId, part); const qs = questionsFor(part, row); const ans = row.answers || {};
  const missing = qs.filter((q) => q.required && ans[q.id] == null).map((q) => q.id);
  if (missing.length) { const e = new Error(`${missing.length} required question(s) are still unanswered.`); e.status = 422; e.missing = missing; throw e; }
  await query(`UPDATE studio.interviews SET status = 'submitted', submitted_at = now() WHERE user_id = $1 AND part = $2`, [userId, part]);
  const res = { ok: true, part };
  if (part < 3) {
    await ensureRow(userId, part + 1);
    try { const f = await generateFollowups({ userId, nextPart: part + 1, llm }); await query(`UPDATE studio.interviews SET followups = $3::jsonb WHERE user_id = $1 AND part = $2`, [userId, part + 1, JSON.stringify(f)]); res.followups = f.length; } catch (e) { res.followups = 0; res.followup_error = String(e.message).slice(0, 120); }
  } else {
    try { const p = await buildProfile({ userId, llm }); res.profile_id = p.id; res.proposals = p.proposals; } catch (e) { res.profile_error = String(e.message).slice(0, 200); }
  }
  return res;
}

export async function latestProfile(userId) { return one(`SELECT id, version, profile, markdown, status, confirmations, created_at, confirmed_at FROM studio.style_profiles WHERE user_id = $1 ORDER BY version DESC LIMIT 1`, [userId]); }
export async function confirmProfile(userId, confirmations) {
  const p = await latestProfile(userId); if (!p) { const e = new Error('no profile yet'); e.status = 404; throw e; }
  const valid = new Set(Object.values(p.profile.sections || {}).flat().map((r) => r.id)); const clean = {};
  for (const [id, c] of Object.entries(confirmations || {})) if (valid.has(id) && ['agree', 'not_quite', 'wrong'].includes(c?.verdict)) clean[id] = { verdict: c.verdict, text: String(c.text || '').slice(0, 500) };
  const extra = String(confirmations?._missing || '').slice(0, 2000);
  await query(`UPDATE studio.style_profiles SET confirmations = $2::jsonb, status = 'confirmed', confirmed_at = now() WHERE id = $1`, [p.id, JSON.stringify({ items: clean, missing: extra })]);
  // corrections become proposals so nothing she says is lost
  for (const [id, c] of Object.entries(clean)) if (c.verdict !== 'agree' && c.text) { const rule = Object.values(p.profile.sections).flat().find((r) => r.id === id); await query(`INSERT INTO studio.proposals (source, reviewer_id, section, title, detail, change) VALUES ('interview-confirm', $1, 'Overall', $2, $3, $4::jsonb)`, [userId, `Correction: ${String(rule?.text || '').slice(0, 100)}`, c.text, JSON.stringify({ rule: c.text, replaces: '', verdict: c.verdict })]); }
  if (extra.trim()) await query(`INSERT INTO studio.proposals (source, reviewer_id, section, title, detail, change) VALUES ('interview-confirm', $1, 'Overall', 'Something the profile missed', $2, $3::jsonb)`, [userId, extra, JSON.stringify({ rule: extra })]);
  return { ok: true, confirmed: Object.keys(clean).length };
}

// ── owner views ──
export async function listInterviews() {
  const people = await query(`SELECT i.user_id, i.full_name, i.source, i.active, i.added_at FROM studio.interviewees i ORDER BY i.added_at, i.full_name`);
  const out = [];
  for (const p of people) { const pr = await progress(p.user_id); const prof = await latestProfile(p.user_id); out.push({ ...p, parts: pr.map((x) => ({ part: x.part, status: x.status, answered: x.answered, total: x.total })), profile: prof ? { version: prof.version, status: prof.status, created_at: prof.created_at } : null }); }
  return out;
}
export async function personDetail(userId) {
  const who = await one(`SELECT user_id, full_name FROM studio.interviewees WHERE user_id = $1`, [userId]); if (!who) { const e = new Error('not found'); e.status = 404; throw e; }
  return { who, progress: await progress(userId), answers: await renderedAnswers(userId, 3), profile: await latestProfile(userId) };
}
export async function exportPerson(userId, format = 'md') {
  const d = await personDetail(userId);
  if (format === 'json') return { type: 'application/json', name: `interview-${d.who.full_name || userId}.json`.replace(/\s+/g, '-'), body: JSON.stringify({ who: d.who, answers: d.answers, profile: d.profile?.profile || null, confirmations: d.profile?.confirmations || null }, null, 2) };
  const L = [`# Interview — ${d.who.full_name || userId}`, ''];
  let g = ''; for (const a of d.answers) { if (a.part + a.group !== g) { g = a.part + a.group; L.push(`\n## Part ${a.part} · ${a.group || ''}`); } L.push(`**${a.prompt}**`, `${a.answer}`, ''); }
  if (d.profile) L.push('\n---\n', d.profile.markdown);
  return { type: 'text/markdown', name: `interview-${d.who.full_name || userId}.md`.replace(/\s+/g, '-'), body: L.join('\n') };
}

/** Cross-doctor view: counts per answer option for every choice question + (optional) a written synthesis of agreement and conflict. */
export async function synthesis({ llm, narrative = true } = {}) {
  const rows = await query(`SELECT i.user_id, i.part, i.answers, f.full_name FROM studio.interviews i JOIN studio.interviewees f ON f.user_id = i.user_id WHERE i.status = 'submitted'`);
  const people = new Set(rows.map((r) => r.user_id)).size; const qs = Object.fromEntries(allQuestions().map((q) => [q.id, q]));
  const dist = {};
  for (const r of rows) for (const [id, a] of Object.entries(r.answers || {})) {
    const q = qs[id]; if (!q || !['single', 'multi', 'compare', 'scale'].includes(q.type)) continue;
    const d = (dist[id] ||= { id, part: r.part, prompt: q.prompt, type: q.type, counts: {}, n: 0 }); d.n++;
    const vals = q.type === 'multi' ? (Array.isArray(a) ? a : a.choices || []) : [typeof a === 'object' ? a.choice : a];
    for (const v of vals) { const k = q.type === 'scale' ? String(v) : ((q.options || []).find((o) => o.id === v)?.label || v); d.counts[k] = (d.counts[k] || 0) + 1; }
  }
  const out = { people, questions: Object.values(dist).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })), narrative: null, at: new Date().toISOString() };
  if (narrative && people >= 1) {
    try {
      const texts = []; for (const r of rows) for (const [id, a] of Object.entries(r.answers || {})) { const q = qs[id]; if (q?.type === 'text' && String(a).length > 20) texts.push(`${r.full_name || r.user_id.slice(0, 6)} · ${q.prompt}\n  ${String(a).slice(0, 600)}`); }
      const o = await askJson({ llm, model: MODELS.judge(), agent: 'studio-synthesis', maxOutputTokens: 6000, thinkingBudget: 1024, system: 'You compare the note-writing interviews of several physicians. Return JSON {"agreements":["where they agree, with how many"],"conflicts":["where they disagree and between whom, what decision is needed"],"surprises":["notable or unexpected answers"],"recommended_shared_rules":["rules most doctors would accept"],"personal_variations":["things that should stay personal per doctor"]}. Be specific and short.', user: `Distributions:\n${out.questions.map((d) => `${d.id} ${d.prompt}: ${JSON.stringify(d.counts)}`).join('\n').slice(0, 30000)}\n\nFree-text answers:\n${texts.join('\n').slice(0, 40000)}\n\nReturn ONLY the JSON.` });
      out.narrative = o;
    } catch (e) { out.narrative_error = String(e.message).slice(0, 160); }
  }
  await query(`INSERT INTO studio.interview_synthesis (data) VALUES ($1::jsonb)`, [JSON.stringify(out)]);
  return out;
}
export async function latestSynthesis() { const r = await one(`SELECT data, created_at FROM studio.interview_synthesis ORDER BY id DESC LIMIT 1`); return r ? { ...r.data, created_at: r.created_at } : null; }

// ── routes ──
export function registerInterviewRoutes(app, { wrap, owner }) {
  const ok = (res, b) => res.json(b);
  app.get('/interview', wrap(async (req, res) => ok(res, { parts: await progress(req.who.id), profile: await latestProfile(req.who.id).then((p) => p && { version: p.version, status: p.status, created_at: p.created_at }) })));
  app.get('/interview/part/:n', wrap(async (req, res) => ok(res, await partView(req.who.id, Number(req.params.n)))));
  app.put('/interview/part/:n/answers', wrap(async (req, res) => ok(res, await saveAnswers(req.who.id, Number(req.params.n), req.body?.answers || {}))));
  app.post('/interview/part/:n/submit', wrap(async (req, res) => {
    try { const r = await submitPart(req.who.id, Number(req.params.n)); await audit(req.who.id, 'interview_submit', { part: Number(req.params.n) }); ok(res, r); }
    catch (e) { if (e.missing) return res.status(422).json({ error: e.message, missing: e.missing }); throw e; }
  }));
  app.post('/interview/part/:n/reopen', wrap(async (req, res) => ok(res, await reopen(req.who.id, Number(req.params.n)))));
  app.get('/interview/profile', wrap(async (req, res) => ok(res, { profile: await latestProfile(req.who.id) })));
  app.post('/interview/profile/rebuild', wrap(async (req, res) => { const p = await buildProfile({ userId: req.who.id }); ok(res, { ok: true, id: p.id }); }));
  app.post('/interview/profile/confirm', wrap(async (req, res) => { const r = await confirmProfile(req.who.id, req.body?.confirmations || {}); await audit(req.who.id, 'profile_confirm', r); ok(res, r); }));

  app.get('/interviews', owner, wrap(async (req, res) => ok(res, { people: await listInterviews() })));
  app.get('/interviews/synthesis', owner, wrap(async (req, res) => ok(res, { synthesis: await latestSynthesis() })));
  app.post('/interviews/synthesis', owner, wrap(async (req, res) => ok(res, { synthesis: await synthesis({ narrative: req.body?.narrative !== false }) })));
  app.get('/interviews/:userId', owner, wrap(async (req, res) => { await audit(req.who.id, 'interview_view', { user: req.params.userId }); ok(res, await personDetail(req.params.userId)); }));
  app.get('/interviews/:userId/export', owner, wrap(async (req, res) => { const f = await exportPerson(req.params.userId, req.query.format === 'json' ? 'json' : 'md'); res.setHeader('Content-Type', f.type + '; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`); res.send(f.body); }));
  app.get('/interviewees', owner, wrap(async (req, res) => ok(res, { people: await query(`SELECT user_id, full_name, source, active, added_at FROM studio.interviewees ORDER BY added_at`) })));
  app.post('/interviewees', owner, wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim(); const u = email ? await one(`SELECT id::text AS id, full_name FROM auth.users WHERE email = $1 AND is_active`, [email]) : null;
    if (!u) return res.status(404).json({ error: 'no active account with that email' });
    await query(`INSERT INTO studio.interviewees (user_id, full_name, source, added_by) VALUES ($1, $2, 'manual', $3) ON CONFLICT (user_id) DO UPDATE SET active = true`, [u.id, u.full_name, req.who.id]); ok(res, { ok: true, full_name: u.full_name });
  }));
  app.delete('/interviewees/:id', owner, wrap(async (req, res) => { await query(`UPDATE studio.interviewees SET active = false WHERE user_id = $1`, [req.params.id]); ok(res, { ok: true }); }));
}
