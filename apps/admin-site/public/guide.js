// Start here: what each part of the console is for, and the order to use it in. Shows live progress on every step.
import { lab } from './kit.js';

export async function guideView(ctx) {
  const { $, head, api, go } = ctx;
  $('#view').innerHTML = head('Start here', 'Two jobs, in order. Each step says what to do and shows whether you have done it.', '') + '<div id="gd" class="card empty">Loading…</div>';
  const safe = async (f, d) => { try { return await f(); } catch { return d; } };
  const [runs, cands, reps, reg, cfg] = await Promise.all([
    safe(() => lab('/runs').then((r) => r.runs), null), safe(() => lab('/candidates').then((r) => r.candidates), []), safe(() => lab('/reports').then((r) => r.reports), []),
    safe(() => api('/api/console/prompts/registry').then((r) => r.prompts), []), safe(() => api('/api/console/config').then((r) => r.settings), []),
  ]);
  const done = (runs || []).filter((r) => r.status === 'done'); const overrides = cfg.filter((s) => s.source === 'override').length; const promoted = reg.filter((p) => p.live !== 'default').length;
  const step = (n, title, what, to, label, status) => `<div class="gstep ${status}"><div class="gn">${status === 'done' ? '✓' : n}</div><div class="gb"><b>${title}</b><div class="hint">${what}</div></div><button class="btn sm${status === 'next' ? ' primary' : ''}" data-go="${to}">${label} →</button></div>`;
  const first = (cond, ...rest) => (cond ? 'done' : 'todo');
  const nextMark = (arr) => { let found = false; return arr.map((s) => { if (s.status === 'todo' && !found) { found = true; return { ...s, status: 'next' }; } return s; }); };
  const harness = nextMark([
    { n: 1, t: 'Run the writer on gold notes', w: 'Pick notes (random, search, range) or paste your own transcript, choose the model and prompt, press Start.', to: 'lab', l: 'Run & inputs', status: first(done.length > 0) },
    { n: 2, t: 'Read the generated notes beside the gold note', w: 'Open any note: generated vs gold side by side, the audit (what it lacks / got wrong), the transcript and the pipeline log.', to: 'results', l: 'Review notes', status: first(false) },
    { n: 3, t: 'Compare two runs (per note and overall)', w: 'Same notes, two versions: paired statistics, per-note winners, and a blind judge that also counts hallucinations.', to: 'compare', l: 'Compare runs', status: first(done.length >= 2 && false) },
    { n: 4, t: 'Diagnose the whole run', w: 'An overall analysis of recurring failures, which stage causes them, and what to change first (with status tracking).', to: 'insights', l: 'Diagnose', status: first(reps.some((r) => r.status === 'done')) },
    { n: 5, t: 'Improve the prompt and prove it', w: 'Generate a better writer prompt, validate it on unseen notes, pass the gate, promote.', to: 'optimize', l: 'Improve', status: first(cands.length > 0) },
    { n: 6, t: 'Watch quality over time', w: 'Trend charts across every run; pin a baseline.', to: 'trends', l: 'Trends', status: first(done.length >= 3) },
  ]);
  const admin = nextMark([
    { n: 1, t: 'See what production is doing', w: 'Every stage of the pipeline with its model, prompt version and settings; volume, latency, failures, cost, errors.', to: 'system', l: 'System', status: 'todo' },
    { n: 2, t: 'Change a prompt', w: 'Writer, checklist and verifier prompts: edit, review the diff, save a version, roll back any time.', to: 'prompts', l: 'Prompts', status: first(promoted > 0) },
    { n: 3, t: 'Change models and limits', w: 'Writer model, temperature, top-p, timeouts, verifier on/off — validated, audited, live in 30 s.', to: 'settings', l: 'Settings', status: first(overrides > 0) },
    { n: 4, t: 'Look at real users, notes and audio', w: 'Users and plans, every generated note with transcript and audio, activity and the pipeline log.', to: 'consults', l: 'Notes', status: 'todo' },
  ]);
  const col = (items) => items.map((s) => step(s.n, s.t, s.w, s.to, s.l, s.status)).join('');
  $('#gd').className = ''; $('#gd').innerHTML = `
    <div class="two" style="align-items:start">
      <div><h3 class="sect" style="margin-top:0">A · Test and improve the note writer <span class="chip">Harness</span></h3><p class="hint">Safe sandbox. Runs on a separate container on the Google VM against the gold notes; <b>never touches clinicians' notes or production settings</b> until you promote.</p><div class="gsteps">${col(harness)}</div></div>
      <div><h3 class="sect" style="margin-top:0">B · Control production <span class="chip">Admin</span></h3><p class="hint">Changes here reach real notes: prompts within ~60 s, settings within ~30 s. Every change is audited and reversible.</p><div class="gsteps">${col(admin)}</div></div>
    </div>
    <h3 class="sect">The usual loop</h3>
    <div class="loop"><span>Run</span>→<span>Review notes</span>→<span>Diagnose</span>→<span>Improve</span>→<span>Validate on unseen notes</span>→<span>Promote</span>→<span>Watch System &amp; Trends</span></div>
    <h3 class="sect">What the parts are for</h3>
    ${[['Gold note', 'A note a clinician wrote for a real consultation. The answer key every score is measured against.'], ['Run', 'One test: N notes through the pipeline with a chosen model and prompt. Stored forever so runs can be compared.'], ['Audit', 'A stronger model reads one note, the transcript and the gold note, and lists what the note lacks, got wrong, or padded.'], ['Blind judge', 'Compares two notes without knowing which version wrote which, in both orders; counts hallucinations and misses.'], ['Diagnosis', 'The overall view: patterns across many audits plus pipeline-log statistics, with prioritised changes.'], ['Gate', 'The server-side checklist a prompt must pass on unseen notes before it can be promoted.'], ['Prompt version', 'An immutable saved copy of a prompt. One is live; older ones are your rollback.'], ['Setting', 'A validated runtime parameter (model, temperature, timeout…). Overrides sit on top of defaults and can be reset.']].map(([t, d]) => `<div class="card" style="margin-bottom:8px"><b>${t}</b> <span class="hint">${d}</span></div>`).join('')}`;
  document.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go); });
}
