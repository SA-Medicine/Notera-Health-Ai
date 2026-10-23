// SUPER RUN: one stored recording through the whole chain, step by step, for the admin console.
//   1  TRANSCRIBE  the same audio goes to two separate speech models at once: Chirp 2 (Google Speech-to-Text, with the medical vocabulary) and Gemini 2.5 Flash.
//   2  COMPARE     a reviewer agent (Gemini 2.5 Pro) LISTENS to the recording and checks both transcripts against it: scores, every clinically meaningful
//                  disagreement and who is right, what each missed or invented, and a winner. Code adds the measurable facts (words, speed, cost, agreement).
//   3  SOAP NOTE   the production note pipeline writes the note from the chosen transcript (the winner unless the admin picks the other one),
//   4  AUDIT       and the lab's own auditor (the same one that audits every report) judges the note against that transcript.
//   +  SUMMARY     one consolidated statement of all steps: what ran, what it found, what does not match, and what is not proven.
// Every step runs in the background and is polled; a step never starts by itself (the admin presses Next). State is kept on disk (<data>/superruns).
// Nothing is saved to the clinical tables: a super run reads a recording and its transcript, and writes only its own result file.
// Opening a recording this way is written to the audit log with the admin's id (the admin Worker forwards it after checking the admin session).
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { query, one } from '../src/db/pool.js';
import { audit } from '../src/auth/users.js';
import { decodeFile } from '../src/admin/audioStats.js';
import { transcribeChirpPcm } from '../src/asr/googleSpeech.js';
import { defaultRunners } from '../src/asr/engines.js';
import { alignTokens } from '../src/asr/consensus.js';
import { MEDICAL_TERMS } from '../src/asr/medicalVocab.js';
import { generateNote } from '../src/orchestrator/generateNote.js';
import { createGeminiService } from '../src/services/LLMService.js';

export const ENGINE_INFO = {
  chirp: { id: 'chirp', label: 'Chirp 2', detail: 'Google Speech-to-Text V2, with the medical vocabulary', price: 0.016 },
  gemini: { id: 'gemini', label: 'Gemini 2.5 Flash', detail: 'Google Gemini audio transcription', price: 0.002 },
};
export const JUDGE = 'gemini-2.5-pro';
const BUCKET = () => process.env.GCS_AUDIO_BUCKET || '';
const RUN_RX = /^sr_[a-z0-9]{6,24}$/; const ID_RX = /^[A-Za-z0-9_-]{3,80}$/;
const nameOf = (uri) => String(uri || '').replace(`gs://${BUCKET()}/`, '');
const words = (t) => (String(t || '').match(/[A-Za-z0-9']+/g) || []);
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
const mmss = (s) => (s == null ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const cap = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const parseJson = (raw) => JSON.parse(String(raw).replace(/^```json|```$/g, '').trim());

// ── measurable facts (code, not a model) ───────────────────────────────────────────────────────────────────────────────────────────
/** How much two transcripts agree, and where they differ (largest and medical differences first). */
export function agreement(textA, textB, terms = MEDICAL_TERMS) {
  const A = norm(textA), B = norm(textB);
  if (!A.length || !B.length) return { sharedPct: null, differences: 0, medicalDifferences: 0, spans: [] };
  if (A.length * B.length > 25_000_000) return { sharedPct: null, differences: null, medicalDifferences: null, spans: [], note: 'too long to align word by word' };
  const ops = alignTokens(A, B); const spans = []; let cur = null; let match = 0;
  for (const [t, i, j] of ops) {
    if (t === 'm') { match++; cur = null; continue; }
    if (!cur) { cur = { a: [], b: [] }; spans.push(cur); }
    if (t !== 'i') cur.a.push(A[i]); if (t !== 'd') cur.b.push(B[j]);
  }
  const out = spans.map((s) => ({ a: s.a.join(' '), b: s.b.join(' '), medical: [...s.a, ...s.b].some((w) => terms.has(w)), size: Math.max(s.a.length, s.b.length) }));
  out.sort((x, y) => (y.medical - x.medical) || (y.size - x.size));
  return { sharedPct: +((match / Math.max(A.length, B.length)) * 100).toFixed(1), differences: out.length, medicalDifferences: out.filter((s) => s.medical).length, spans: out.slice(0, 30).map(({ a, b, medical }) => ({ a, b, medical })) };
}
export function engineMetrics(text, seconds, ms, price) {
  const w = words(text); const tokens = norm(text); const min = seconds ? seconds / 60 : null;
  return { words: w.length, wpm: min ? Math.round(w.length / min) : null, seconds: +(ms / 1000).toFixed(1), speedX: seconds && ms ? +(seconds / (ms / 1000)).toFixed(1) : null,
    medicalTerms: tokens.filter((t) => MEDICAL_TERMS.has(t)).length, numbers: tokens.filter((t) => /\d/.test(t)).length, costUsd: min ? +(min * price).toFixed(4) : null };
}

// ── the real steps (replaceable in tests) ─────────────────────────────────────────────────────────────────────────────────────────
async function toMp3(buf) {
  const f = path.join(os.tmpdir(), 'sr-' + crypto.randomBytes(6).toString('hex') + '.bin');
  try {
    fs.writeFileSync(f, buf);
    return await new Promise((resolve) => {
      const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const out = []; const t = setTimeout(() => p.kill('SIGKILL'), 120000); p.stdout.on('data', (d) => out.push(d)); p.on('error', () => { clearTimeout(t); resolve(null); });
      p.on('close', (code) => { clearTimeout(t); const b = Buffer.concat(out); resolve(code === 0 && b.length ? b : null); });
    });
  } finally { try { fs.unlinkSync(f); } catch { /* gone */ } }
}

export const COMPARE_SYS = `You are a senior medical transcription reviewer. You are given a RECORDING of a clinical consultation (when audio is attached) and two machine transcripts of it:
A = ${ENGINE_INFO.chirp.label} (${ENGINE_INFO.chirp.detail}), B = ${ENGINE_INFO.gemini.label}.
The recording is the only ground truth. Listen to it, then judge each transcript against what was actually said. Neither transcript is the reference for the other.
Score each transcript 0-100 on: accuracy (words heard correctly), completeness (share of the speech captured, nothing dropped), medical_terms (drug names, doses, numbers, body parts, symptoms right), no_invention (100 = nothing made up, text that was not said lowers it), overall.
List up to 12 DISAGREEMENTS that matter clinically (a drug, dose, number, side, symptom, negation, who said it). For each give what A wrote, what B wrote, what the recording actually says, who is right (A, B, neither, unclear) and the clinical impact (none, low, high). Skip differences in filler words, punctuation and spelling.
Also list what each transcript missed (speech that is in the recording) and what each invented (text that is not in the recording).
Pick the winner for THIS recording: A, B or tie, with a confidence (high, medium, low), one headline sentence and 3 to 6 short reasons grounded in the evidence above.
Be honest about limits: if the audio is unclear, say which parts you could not judge. If no audio is attached, say so and judge only on internal consistency (confidence at most low).
Return ONLY this JSON:
{"winner":"A|B|tie","confidence":"high|medium|low","headline":"one sentence","scores":{"A":{"accuracy":0,"completeness":0,"medical_terms":0,"no_invention":0,"overall":0},"B":{"accuracy":0,"completeness":0,"medical_terms":0,"no_invention":0,"overall":0}},"reasons":["..."],"disagreements":[{"a":"","b":"","audio":"","right":"A|B|neither|unclear","impact":"none|low|high"}],"missed_by_a":["..."],"missed_by_b":["..."],"invented_by_a":["..."],"invented_by_b":["..."],"clinical_risks":["..."],"limits":"..."}
At most 12 disagreements and 8 items in every other list.`;

async function compareWithAudio({ mp3, textA, textB, facts }) {
  const svc = await createGeminiService(null, { model: JUDGE }); const url = svc._endpoint(false, JUDGE);
  const cut = (s) => String(s).slice(0, 30000);
  const user = `MEASURED FACTS (computed by code, do not contradict): ${JSON.stringify(facts)}\n\n=== TRANSCRIPT A (${ENGINE_INFO.chirp.label}) ===\n${cut(textA)}\n\n=== TRANSCRIPT B (${ENGINE_INFO.gemini.label}) ===\n${cut(textB)}\n\n${mp3 ? 'The recording is attached.' : 'NO RECORDING IS ATTACHED.'} Return ONLY the JSON.`;
  const parts = [...(mp3 ? [{ inlineData: { mimeType: 'audio/mp3', data: mp3.toString('base64') } }] : []), { text: user }];
  const body = { systemInstruction: { parts: [{ text: COMPARE_SYS }] }, contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, maxOutputTokens: 16000, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 1024 } } };
  for (let attempt = 0; attempt < 3; attempt++) {
    const headers = await svc._authHeaders(); const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(170000) }); const j = await r.json();
    if (r.status === 429 && attempt < 2) { await new Promise((res) => setTimeout(res, 5000 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`reviewer model ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
    try { return parseJson((j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('')); }
    catch (e) { if (attempt >= 1) throw new Error('The reviewer answered, but its answer was cut off. Try again.'); body.contents[0].parts[body.contents[0].parts.length - 1].text += ' Keep it SHORT: at most 6 disagreements, at most 4 items in every other list, one short sentence each.'; }
  }
  throw new Error('reviewer model is busy, try again');
}

export const realSteps = {
  async recordings() {
    let rows;
    try {
      rows = await query(`SELECT c.consult_id, c.title, c.specialty, c.created_at, u.full_name, u.email, r.duration_s, r.status, coalesce(r.flags, '{}') AS flags
        FROM clinical.consults c LEFT JOIN auth.users u ON u.id::text = c.clinician_id LEFT JOIN ops.audio_review r ON r.consult_id = c.consult_id
        WHERE c.audio_uri IS NOT NULL AND c.audio_uri <> '' AND coalesce(r.status, 'unreviewed') <> 'removed' ORDER BY c.created_at DESC LIMIT 300`);
    } catch {
      rows = await query(`SELECT c.consult_id, c.title, c.specialty, c.created_at, u.full_name, u.email, NULL::real AS duration_s, 'unreviewed' AS status, '{}'::text[] AS flags FROM clinical.consults c LEFT JOIN auth.users u ON u.id::text = c.clinician_id WHERE c.audio_uri IS NOT NULL AND c.audio_uri <> '' ORDER BY c.created_at DESC LIMIT 300`);
    }
    return rows.map((r) => ({ id: r.consult_id, name: recordingName(r), status: r.status, damaged: (r.flags || []).some((f) => /damaged|cannot be decoded/.test(f)), durationS: r.duration_s }));
  },
  async consult(id) {
    return one(`SELECT c.consult_id, c.title, c.specialty, c.audio_uri, c.transcript->>'text' AS transcript, u.full_name, u.email, c.created_at FROM clinical.consults c LEFT JOIN auth.users u ON u.id::text = c.clinician_id WHERE c.consult_id = $1`, [id]);
  },
  async audioBytes(uri) {
    const { Storage } = await import('@google-cloud/storage'); const [buf] = await new Storage().bucket(BUCKET()).file(nameOf(uri)).download(); return buf;
  },
  async decode(buf) { return decodeFile(buf); },
  async mp3(buf) { const m = await toMp3(buf); return m && m.length < 14_000_000 ? m : null; },
  async chirp(pcm) { return (await transcribeChirpPcm(pcm, { model: 'chirp_2', location: process.env.ASR_V2_LOCATION || 'us-central1', hints: true, overlapSeconds: 0, log: () => {} })).text; },
  async gemini(pcm) { const r = await defaultRunners.gemini(pcm, 'gemini-2.5-flash', () => {}); return { text: r.text, note: r.loopedWindows ? `The model looped in ${r.loopedWindows} part(s) of the recording; the repeated text was cut back to two copies.` : '' }; },
  compare: compareWithAudio,
  async note(transcript, onLog) {
    const trace = {};
    const r = await generateNote({ transcript: String(transcript).slice(0, 120000), specialty: 'auto', noteType: 'consultation', clinicianId: 'super-run' }, { persist: false, mode: 'v2', onLog, trace });
    return { rendered: r.renderedNote || '', flags: r.flags || [], status: r.status, trace: { used: trace.used, timings: trace.timings } };
  },
};

export function recordingName(r) {
  const owner = r.full_name || (r.email ? String(r.email).split('@')[0] : 'unknown');
  const when = r.created_at ? new Date(r.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : '';
  return `${r.title || cap(r.specialty) || 'Consult'} · ${owner} · ${when}${r.duration_s ? ' · ' + mmss(r.duration_s) : ''}`;
}

// ── consolidated statement ──────────────────────────────────────────────────────────────────────────────────────────────────────
export function buildSummary(run) {
  const lines = []; const e = run.asr?.engines || {}; const c = run.compare?.result; const a = run.audit?.result;
  if (run.asr?.status === 'done') {
    const ag = run.asr.agreement || {};
    lines.push({ step: 'Transcribe', ok: Object.values(e).every((x) => x.status === 'done'), text: `The recording "${run.name}" (${mmss(run.durationS)}) went to ${ENGINE_INFO.chirp.label} (${e.chirp?.metrics?.words ?? '?'} words, ${e.chirp?.metrics?.seconds ?? '?'} s) and ${ENGINE_INFO.gemini.label} (${e.gemini?.metrics?.words ?? '?'} words, ${e.gemini?.metrics?.seconds ?? '?'} s). ${ag.sharedPct != null ? `They agree on ${ag.sharedPct}% of the words and differ in ${ag.differences} place${ag.differences === 1 ? '' : 's'}, ${ag.medicalDifferences} of them involving a medical term.` : ''}` });
  }
  if (c) {
    const w = c.winner === 'A' ? ENGINE_INFO.chirp.label : c.winner === 'B' ? ENGINE_INFO.gemini.label : 'neither (a tie)';
    lines.push({ step: 'Compare', ok: true, text: `The reviewer (${JUDGE}, ${run.compare.audioAttached ? 'listening to the recording' : 'without the audio'}) judged ${w} better, confidence ${c.confidence || 'unknown'}${c.scores ? `, overall ${c.scores.A?.overall ?? '?'} vs ${c.scores.B?.overall ?? '?'}` : ''}. ${c.headline || ''}` });
  }
  if (run.note?.status === 'done') lines.push({ step: 'SOAP note', ok: true, text: `The SOAP note was written from the ${run.note.sourceLabel} transcript in ${run.note.seconds} s; ${run.note.toCheck} line${run.note.toCheck === 1 ? '' : 's'} flagged to check before signing.` });
  let verdict = 'incomplete'; const caveats = [];
  if (a) {
    const crit = (a.wrong || []).filter((x) => x.severity === 'critical').length + (a.missing || []).filter((x) => x.importance === 'critical').length;
    verdict = a.verdict === 'unsafe' || crit ? 'unsafe' : a.verdict === 'excellent' || a.verdict === 'good' ? 'pass' : 'needs review';
    lines.push({ step: 'Audit', ok: verdict === 'pass', text: `The auditor scored the note ${a.score}/100 (${a.verdict}): ${(a.wrong || []).length} wrong, ${(a.missing || []).length} missing, ${(a.extra || []).length} extra, ${(a.ap_gaps || []).length} plan gap${(a.ap_gaps || []).length === 1 ? '' : 's'}${crit ? `, ${crit} critical` : ''}. ${a.summary || ''}` });
  }
  caveats.push('No human-checked transcript exists for this recording. The comparison is a judgement by an AI model that listened to the audio: a strong second opinion, not proof.');
  caveats.push('The note and its audit are based on the chosen machine transcript. A mistake in that transcript carries into the note, so check the disagreements listed in the Compare step.');
  const used = run.note?.sourceLabel;
  const headline = verdict === 'incomplete' ? 'Run not finished yet' : `${cap(verdict)}: ${used || 'the'} transcript, note scored ${a?.score ?? '?'}/100${verdict === 'unsafe' ? ', do not use without a fix' : ''}`;
  return { headline, verdict, lines, caveats };
}

// ── the run store and the HTTP routes ───────────────────────────────────────────────────────────────────────────────────────────
const blankStep = () => ({ status: 'idle' });
export function mountSuperRun(app, { wrap, auditAdhoc, dataDir, steps = realSteps, auditFn = audit }) {
  const dir = path.join(dataDir, 'superruns'); fs.mkdirSync(dir, { recursive: true });
  const RUNS = new Map();
  const file = (id) => path.join(dir, id + '.json');
  const save = (run) => { try { fs.writeFileSync(file(run.id), JSON.stringify(run)); } catch { /* disk full: the run still works in memory */ } };
  const load = (id) => {
    if (RUNS.has(id)) return RUNS.get(id);
    try { const run = JSON.parse(fs.readFileSync(file(id), 'utf8')); for (const k of ['asr', 'compare', 'note', 'audit']) if (run[k]?.status === 'running') { run[k] = { ...run[k], status: 'error', error: 'interrupted by a restart, run this step again' }; } RUNS.set(id, run); return run; } catch { return null; }
  };
  const touch = (run, step, patch) => { run[step] = { ...run[step], ...patch }; run.updatedAt = new Date().toISOString(); save(run); };
  const view = (run) => ({ ...run, summary: buildSummary(run) });
  const who = (req) => ({ id: String(req.headers['x-admin-id'] || ''), email: String(req.headers['x-admin-email'] || '') });
  const note = async (req, what, detail) => { const a = who(req); if (a.id) await auditFn(a.id, what, detail, String(req.headers['x-forwarded-for'] || '')).catch(() => {}); };

  app.get('/superrun/recordings', wrap(async (_req, res) => res.json({ recordings: await steps.recordings() })));
  app.get('/superrun/runs', wrap(async (_req, res) => {
    const out = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 15).map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt, by: r.by, headline: buildSummary(r).headline, steps: ['asr', 'compare', 'note', 'audit'].map((k) => r[k]?.status || 'idle') }));
    res.json({ runs: out });
  }));
  app.get('/superrun/:id', wrap(async (req, res) => { const run = RUN_RX.test(req.params.id) ? load(req.params.id) : null; run ? res.json(view(run)) : res.status(404).json({ error: 'not found' }); }));

  // 1 · create the run and send the recording to both speech models
  app.post('/superrun', wrap(async (req, res) => {
    const id = String(req.body?.consultId || ''); if (!ID_RX.test(id)) return res.status(400).json({ error: 'pick a recording' });
    const c = await steps.consult(id); if (!c?.audio_uri) return res.status(404).json({ error: 'that recording has no audio' });
    const run = { id: 'sr_' + crypto.randomBytes(6).toString('hex'), consultId: id, name: recordingName(c), owner: c.full_name || c.email || '', by: who(req).email || 'admin', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      durationS: null, asr: blankStep(), compare: blankStep(), note: blankStep(), audit: blankStep() };
    RUNS.set(run.id, run); save(run); await note(req, 'admin_super_run', { consultId: id, step: 'start' });
    runAsr(run, c).catch((e) => touch(run, 'asr', { status: 'error', error: String(e.message).slice(0, 300), finishedAt: new Date().toISOString() }));
    res.json(view(run));
  }));

  async function runAsr(run, c) {
    const t0 = Date.now();
    touch(run, 'asr', { status: 'running', stage: 'Fetching the recording', startedAt: new Date().toISOString(), engines: { chirp: { ...ENGINE_INFO.chirp, status: 'waiting' }, gemini: { ...ENGINE_INFO.gemini, status: 'waiting' } } });
    const buf = await steps.audioBytes(c.audio_uri); run.audioBytes = buf.length;
    touch(run, 'asr', { stage: 'Decoding the audio' });
    const pcm = await steps.decode(buf);
    if (!pcm) { touch(run, 'asr', { status: 'error', error: 'This recording cannot be decoded: the stored file is damaged (it has no audio header). Pick another recording.', finishedAt: new Date().toISOString() }); return; }
    run.durationS = +(pcm.length / 32000).toFixed(1);
    touch(run, 'asr', { stage: 'Both models are listening' });
    const one = async (key, fn) => {
      const t = Date.now(); run.asr.engines[key].status = 'running'; save(run);
      try { const out = await fn(pcm); const text = String(typeof out === 'string' ? out : out?.text || '').trim(); run.asr.engines[key] = { ...run.asr.engines[key], status: 'done', text, note: typeof out === 'string' ? '' : out?.note || '', metrics: engineMetrics(text, run.durationS, Date.now() - t, ENGINE_INFO[key].price) }; }
      catch (e) { run.asr.engines[key] = { ...run.asr.engines[key], status: 'error', error: String(e.message).slice(0, 200), text: '' }; }
      save(run);
    };
    await Promise.all([one('chirp', steps.chirp), one('gemini', steps.gemini)]);
    const e = run.asr.engines; const ok = e.chirp.status === 'done' && e.gemini.status === 'done';
    if (!ok) { touch(run, 'asr', { status: 'error', error: 'One of the two models failed: ' + [e.chirp, e.gemini].filter((x) => x.status === 'error').map((x) => `${x.label}: ${x.error}`).join('; '), finishedAt: new Date().toISOString(), ms: Date.now() - t0 }); return; }
    touch(run, 'asr', { status: 'done', stage: '', agreement: agreement(e.chirp.text, e.gemini.text), finishedAt: new Date().toISOString(), ms: Date.now() - t0 });
  }

  // 2 · the reviewer agent listens and compares
  app.post('/superrun/:id/compare', wrap(async (req, res) => {
    const run = RUN_RX.test(req.params.id) ? load(req.params.id) : null; if (!run) return res.status(404).json({ error: 'not found' });
    if (run.asr?.status !== 'done') return res.status(409).json({ error: 'the transcripts are not ready yet' });
    if (run.compare.status === 'running' || run.compare.status === 'done') return res.json(view(run));
    await note(req, 'admin_super_run', { consultId: run.consultId, step: 'compare' });
    (async () => {
      const t0 = Date.now(); touch(run, 'compare', { status: 'running', stage: 'Preparing the recording for the reviewer', startedAt: new Date().toISOString() });
      const c = await steps.consult(run.consultId); const buf = await steps.audioBytes(c.audio_uri); const mp3 = await steps.mp3(buf);
      touch(run, 'compare', { stage: mp3 ? 'The reviewer is listening and checking both transcripts' : 'The reviewer is checking both transcripts (no audio)' });
      const e = run.asr.engines; const facts = { audioSeconds: run.durationS, A: e.chirp.metrics, B: e.gemini.metrics, agreement: { sharedPct: run.asr.agreement.sharedPct, differences: run.asr.agreement.differences, medicalDifferences: run.asr.agreement.medicalDifferences }, topDifferences: run.asr.agreement.spans.slice(0, 10), engineNotes: [e.chirp.note, e.gemini.note].filter(Boolean) };
      const result = await steps.compare({ mp3, textA: e.chirp.text, textB: e.gemini.text, facts });
      touch(run, 'compare', { status: 'done', stage: '', result, audioAttached: !!mp3, model: JUDGE, finishedAt: new Date().toISOString(), ms: Date.now() - t0 });
    })().catch((e) => touch(run, 'compare', { status: 'error', error: String(e.message).slice(0, 300), finishedAt: new Date().toISOString() }));
    res.json(view(run));
  }));

  // 3 · the note, then its audit (one chain)
  app.post('/superrun/:id/note', wrap(async (req, res) => {
    const run = RUN_RX.test(req.params.id) ? load(req.params.id) : null; if (!run) return res.status(404).json({ error: 'not found' });
    if (run.compare?.status !== 'done') return res.status(409).json({ error: 'compare the transcripts first' });
    if (run.note.status === 'done' && run.audit.status === 'error') {   // the note is fine, only the audit failed: run just the audit again
      const text = run.asr.engines[run.note.sourceKey].text; await note(req, 'admin_super_run', { consultId: run.consultId, step: 'audit-retry' });
      (async () => { const t1 = Date.now(); touch(run, 'audit', { status: 'running', error: '', stage: 'The auditor is checking the note against the transcript', startedAt: new Date().toISOString() }); const result = await auditAdhoc({ transcript: text, note: run.note.rendered }); touch(run, 'audit', { status: 'done', stage: '', result, model: JUDGE, finishedAt: new Date().toISOString(), ms: Date.now() - t1 }); })()
        .catch((e2) => touch(run, 'audit', { status: 'error', error: String(e2.message).slice(0, 300), finishedAt: new Date().toISOString() }));
      return res.json(view(run));
    }
    if (['running', 'done'].includes(run.note.status) || run.audit.status === 'running') return res.json(view(run));
    const win = run.compare.result?.winner; const use = ['chirp', 'gemini'].includes(req.body?.use) ? req.body.use : win === 'A' ? 'chirp' : 'gemini';   // tie or unknown: Gemini (cheaper, and as accurate or better in the benchmarks)
    const e = run.asr.engines; const text = e[use].text; const sourceLabel = ENGINE_INFO[use].label;
    await note(req, 'admin_super_run', { consultId: run.consultId, step: 'note', source: use });
    (async () => {
      const t0 = Date.now(); const log = []; touch(run, 'note', { status: 'running', stage: 'The note pipeline is writing the SOAP note', sourceKey: use, sourceLabel, startedAt: new Date().toISOString(), transcriptWords: words(text).length });
      const n = await steps.note(text, (l) => { if (log.length < 60) log.push(String(l).slice(0, 160)); });
      if (!String(n.rendered || '').trim()) throw new Error('the pipeline returned an empty note');
      const warn = (n.flags || []).filter((f) => ['warning', 'critical'].includes(f?.severity)).length;
      touch(run, 'note', { status: 'done', stage: '', rendered: n.rendered, flags: (n.flags || []).slice(0, 30), toCheck: warn, seconds: +((Date.now() - t0) / 1000).toFixed(1), pipeline: n.trace || null, pipelineLog: log.filter((l) => /writer|retry|loop|rejected|failed|fallback|timed out|coverage|complete/i.test(l) && !/tokens]/.test(l)).slice(0, 14), finishedAt: new Date().toISOString() });
      const t1 = Date.now(); touch(run, 'audit', { status: 'running', stage: 'The auditor is checking the note against the transcript', startedAt: new Date().toISOString() });
      try { const result = await auditAdhoc({ transcript: text, note: n.rendered }); touch(run, 'audit', { status: 'done', stage: '', result, model: JUDGE, finishedAt: new Date().toISOString(), ms: Date.now() - t1 }); }
      catch (e2) { touch(run, 'audit', { status: 'error', error: String(e2.message).slice(0, 300), finishedAt: new Date().toISOString() }); }
    })().catch((e2) => touch(run, 'note', { status: 'error', error: String(e2.message).slice(0, 300), finishedAt: new Date().toISOString() }));
    res.json(view(run));
  }));

  // download of the whole run for the record
  app.get('/superrun/:id/report', wrap(async (req, res) => {
    const run = RUN_RX.test(req.params.id) ? load(req.params.id) : null; if (!run) return res.status(404).json({ error: 'not found' });
    const clean = view(run); res.setHeader('Content-Disposition', `attachment; filename="super-run-${run.id}.json"`); res.json(clean);
  }));
}
