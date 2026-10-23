// Notera Studio — the training doctor's review desk, and the owner's control room.
import { $, $$, esc, when, S, toast, studio, backend, busy, pill, scoreTone, head } from './kit.js';
import { reviewView } from './review.js';
import { interviewHome, interviewPart, profileView, interviewsAdmin, personView, compareView } from './interview.js';

const app = $('#app');
const OWNER_NAV = [['queue', 'All notes'], ['proposals', 'Proposals'], ['dashboard', 'Dashboard'], ['interview', 'My interview'], ['interviews', 'Interviews'], ['spec', 'Style Spec'], ['corpus', 'Corpus'], ['tools', 'Tools']];
const DOC_NAV = [['queue', 'My notes to review'], ['proposals', 'My suggestions'], ['interview', 'My interview']];
const INTERVIEW_NAV = [['interview', 'My interview']];
const homeFor = () => (S.me?.access === 'interviewee' ? '#/interview' : '#/queue');

function shell(view) {
  const nav = S.me.access === 'owner' ? OWNER_NAV : S.me.access === 'interviewee' ? INTERVIEW_NAV : DOC_NAV;
  const lock = S.me.spec?.locked ? pill('Style Spec v' + S.me.spec.version + ' · locked', 'acc') : pill('Style Spec unlocked', 'warn');
  app.innerHTML = `<div class="top"><span class="brand">Notera Studio</span><nav class="nav">${nav.map(([k, l]) => `<a href="#/${k}" class="${view === k ? 'on' : ''}">${l}</a>`).join('')}</nav><div class="grow"></div>
    ${lock}<span class="hint">${esc(S.me.name || 'Signed in')} · ${S.me.access === 'owner' ? 'owner' : S.me.access === 'interviewee' ? 'interview' : 'reviewer'}</span><button class="btn sm" id="th" title="Switch between the light and the dark look">${window.NoteraTheme?.get() === 'dark' ? 'Light mode' : 'Dark mode'}</button><button class="btn sm" id="out">Sign out</button></div><main id="view"></main>`;
  $('#th').onclick = () => { const t = window.NoteraTheme?.toggle(); $('#th').textContent = t === 'dark' ? 'Light mode' : 'Dark mode'; };
  $('#out').onclick = async () => { await backend('/api/auth/logout', { method: 'POST', json: {}, quiet: true }).catch(() => {}); S.me = null; location.hash = '#/login'; };
  return $('#view');
}

function loginView(msg = '') {
  app.innerHTML = `<div class="login"><form class="card" id="lf"><h2 style="color:var(--acc)">Notera Studio</h2><p class="hint">Sign in with your Notera account.</p>
    <label class="lbl">Email<input id="em" type="email" autocomplete="username" required></label><label class="lbl">Password<input id="pw" type="password" autocomplete="current-password" required></label>
    <div class="err" id="er">${esc(msg)}</div><button class="btn primary" style="width:100%" id="go">Sign in</button></form></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault(); $('#er').textContent = '';
    await busy($('#go'), 'Signing in…', async () => {
      try { await backend('/api/auth/login', { method: 'POST', json: { email: $('#em').value.trim(), password: $('#pw').value }, quiet: true }); } catch (err) { $('#er').textContent = err.message; return; }
      try { S.me = await studio('/me', { quiet: true }); } catch (err) { await backend('/api/auth/logout', { method: 'POST', json: {}, quiet: true }).catch(() => {}); $('#er').textContent = err.status === 403 ? 'This account has not been given access to Studio.' : err.message; return; }
      location.hash = homeFor(); route();
    });
  };
}

// ── queue ──
async function queueView(root) {
  let filter = 'new';
  const draw = async () => {
    const { items } = await studio('/queue' + (filter === 'all' ? '' : `?status=${filter}`));
    $('#qb').innerHTML = items.length ? `<table><thead><tr><th>Note</th><th>When</th><th>Style check</th><th>AI review</th><th>Your rating</th><th></th></tr></thead><tbody>${items.map((i) => `<tr class="row" data-id="${i.id}">
      <td><b>${esc(i.title || 'Note')}</b><br><small class="hint">${i.source === 'training' ? 'Training case' : 'Created in Notera'} ${i.legacy ? '· before Style Spec v1' : ''}</small></td><td>${esc(when(i.created_at))}</td>
      <td>${i.conformance != null ? pill(Math.round(i.conformance * 100) + '%', scoreTone(i.conformance)) : '—'}</td>
      <td>${i.auto_overall ? pill(i.auto_overall + '/5', Number(i.auto_overall) >= 4 ? 'ok' : 'warn') + (Number(i.auto_major) > 0 ? ' ' + pill(i.auto_major + ' major', 'bad') : '') : (i.evaluated ? '—' : '<small class="hint">not yet</small>')}</td>
      <td>${i.doctor_overall ? pill(i.doctor_overall + '/5', 'acc') : '—'}</td><td>${i.status === 'reviewed' ? pill('reviewed', 'ok') : pill('to review', 'acc')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing here yet. New notes you create in Notera appear within a minute.</div>';
    $$('#qb tr.row').forEach((r) => { r.onclick = () => { location.hash = '#/review/' + r.dataset.id; }; });
  };
  root.innerHTML = head(S.me.access === 'owner' ? 'All notes in the review queue' : 'Notes to review', 'Every note you create in Notera appears here automatically. Open one, tell us how good it is and what you would change.',
    `<select id="flt" style="width:auto"><option value="new">To review</option><option value="reviewed">Reviewed</option><option value="all">All</option></select>`) + '<div class="card" id="qb"><div class="empty"><span class="spin"></span></div></div>';
  $('#flt').onchange = (e) => { filter = e.target.value; draw(); }; await draw();
}

// ── proposals ──
async function proposalsView(root) {
  let st = S.me.access === 'owner' ? 'pending' : '';
  const draw = async () => {
    const { proposals, note } = await studio('/proposals' + (st ? `?status=${st}` : ''));
    $('#pb').innerHTML = `<p class="hint">${esc(note)}</p>` + (proposals.length ? `<table><thead><tr><th>Where</th><th>Proposed rule</th><th>From</th><th>Status</th>${S.me.access === 'owner' ? '<th></th>' : ''}</tr></thead><tbody>${proposals.map((p) => `<tr><td>${esc(p.section || '')}</td>
      <td><b>${esc(p.title)}</b><br>${esc(p.change?.rule || p.detail || '')}${p.change?.replaces ? `<br><small class="hint">replaces rule ${esc(p.change.replaces)}</small>` : ''}</td><td><small class="hint">${esc(p.source)}<br>${esc(when(p.created_at))}</small></td>
      <td>${pill(p.status, p.status === 'accepted' ? 'ok' : p.status === 'rejected' ? 'bad' : p.status === 'parked' ? 'warn' : 'acc')}</td>
      ${S.me.access === 'owner' ? `<td style="white-space:nowrap"><button class="btn sm" data-d="accepted" data-id="${p.id}">Accept</button> <button class="btn sm" data-d="parked" data-id="${p.id}">Park</button> <button class="btn sm danger" data-d="rejected" data-id="${p.id}">Reject</button></td>` : ''}</tr>`).join('')}</tbody></table>` : '<div class="empty">No proposals yet.</div>');
    $$('#pb [data-d]').forEach((b) => { b.onclick = async () => { await studio(`/proposals/${b.dataset.id}/decide`, { method: 'POST', json: { status: b.dataset.d } }); toast('Recorded for the next Style Spec version'); draw(); }; });
  };
  root.innerHTML = head('Proposed style rules', 'Rules suggested by the doctor’s answers, edits and comments. They are kept for the next Style Spec version; the approved v1 does not change.',
    S.me.access === 'owner' ? `<select id="pf" style="width:auto"><option value="pending">Pending</option><option value="accepted">Accepted</option><option value="parked">Parked</option><option value="rejected">Rejected</option><option value="">All</option></select>` : '') + '<div class="card" id="pb"></div>';
  if ($('#pf')) $('#pf').onchange = (e) => { st = e.target.value; draw(); }; await draw();
}

// ── owner: dashboard ──
async function dashboardView(root) {
  const d = await studio('/dashboard'); const n = (v, p = 2) => (v == null ? '—' : Number(v).toFixed(p));
  root.innerHTML = head('Dashboard', 'How the notes are doing, judged as a doctor would — not by comparing with another doctor’s note.') + `
    <div class="cards"><div class="card kpi"><b>${d.items.items}</b><span>notes in the queue (${d.items.reviewed} reviewed)</span></div>
      <div class="card kpi"><b>${d.items.conformance_since_spec != null ? Math.round(d.items.conformance_since_spec * 100) + '%' : '—'}</b><span>style check, notes since Style Spec v1 (${d.items.since_spec} notes)</span></div>
      <div class="card kpi"><b>${n(d.reviews.doctor_overall, 1)}</b><span>doctor’s overall rating (1–5), ${d.reviews.reviews} reviews</span></div>
      <div class="card kpi"><b>${d.reviews.would_sign != null ? Math.round(d.reviews.would_sign * 100) + '%' : '—'}</b><span>“would sign as written”</span></div>
      <div class="card kpi"><b>${d.reviews.edit_rate != null ? Math.round(d.reviews.edit_rate * 100) + '%' : '—'}</b><span>of lines edited by the doctor</span></div>
      <div class="card kpi"><b>${n(d.items.judge_major, 2)}</b><span>major errors per note (AI reviewer)</span></div>
      <div class="card kpi"><b>${d.judge_vs_doctor.within_1_point != null ? Math.round(d.judge_vs_doctor.within_1_point * 100) + '%' : '—'}</b><span>AI vs doctor within 1 point (${d.judge_vs_doctor.paired} paired)</span></div>
      <div class="card kpi"><b>${d.proposals.pending || 0}</b><span>proposed rules waiting</span></div></div>
    <div class="card"><h3>Style rules most often broken (notes since Style Spec v1)</h3>${d.top_failed_rules.length ? `<table><tbody>${d.top_failed_rules.map((r) => `<tr><td style="width:60px"><b>${esc(r.rule)}</b></td><td>${r.n} notes</td></tr>`).join('')}</tbody></table>` : '<p class="hint">None yet.</p>'}</div>`;
}

async function specView(root) {
  const { spec, lock } = await studio('/spec');
  root.innerHTML = head(spec.title, spec.summary, pill(lock.locked ? 'Locked — doctor-approved' : 'Unlocked', lock.locked ? 'acc' : 'warn')) + `
    <div class="card"><p>This is the note format the training doctor approved. It is <b>locked</b>: prompts, settings and guards cannot be changed until the owner says so. Doctor suggestions collect as proposals for the next version.</p>
    <table><thead><tr><th>Rule</th><th>Section</th><th>What the note must do</th><th></th></tr></thead><tbody>${spec.rules.map((r) => `<tr><td><b>${esc(r.id)}</b></td><td>${esc(r.section)}</td><td>${esc(r.text)}</td><td>${pill(r.severity, r.severity === 'major' ? 'bad' : '')}</td></tr>`).join('')}</tbody></table></div>`;
}

async function corpusView(root) {
  const { stats, caution } = await studio('/corpus'); const tbl = (rows) => `<table><thead><tr><th>Cohort</th><th>Notes</th><th>Topic headings</th><th>Subjective lines</th><th>Note words</th><th>Labelled plan</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.cohort)}</td><td>${r.n}</td><td>${Math.round(r.topic_headings * 100)}%</td><td>${r.subjective_lines}</td><td>${r.note_words}</td><td>${Math.round(r.labelled_plan * 100)}%</td></tr>`).join('')}</tbody></table>`;
  root.innerHTML = head('Corpus', `${stats.total} doctor-written reference notes, indexed by date and style.`) + `<div class="card"><p class="pill warn">${esc(caution)}</p>
    <p>Pools: ${Object.entries(stats.pools).map(([k, v]) => pill(`${k}: ${v}`, 'acc')).join(' ')}</p></div><div class="two" style="margin-top:14px"><div class="card"><h3>By encounter month</h3>${tbl(stats.by_month)}</div><div class="card"><h3>By import batch</h3>${tbl(stats.by_batch)}</div></div>`;
}

async function toolsView(root) {
  root.innerHTML = head('Tools', 'Reviewers, training cases, tuning export and the regression gate.') + `<div class="two">
    <div class="card"><h3>Training doctor accounts</h3><div id="rv"></div><div class="sep"></div><label class="lbl">Add a reviewer by email<input id="rv-email" type="email" placeholder="doctor@example.com"></label><button class="btn" id="rv-add">Add reviewer</button></div>
    <div class="card"><h3>Send a training case to the doctor</h3><p class="hint">Notera writes a note from a reference transcript and puts it in the doctor’s queue (same as a note she created).</p>
      <label class="lbl">Reference transcript id<input id="sd-fix" placeholder="e.g. acute-back-pain"></label><label class="lbl">…or paste a transcript<textarea id="sd-tx" style="min-height:70px"></textarea></label><button class="btn primary" id="sd-go">Create the case</button></div>
    <div class="card"><h3>Pull new notes now</h3><p class="hint">New notes are picked up every minute; use this to force it.</p><button class="btn" id="ig">Check for new notes</button></div>
    <div class="card"><h3>Tuning export (experiment)</h3><p class="hint">Writes training files from a cohort. Starts no tuning job; production is not affected.</p><label class="lbl">Cohort<select id="tn-pool"><option>recent_style</option><option>topic_style</option><option>legacy_style</option><option>all</option></select></label><button class="btn" id="tn-go">Create files</button><div id="tn-out" class="hint" style="margin-top:8px"></div></div>
    <div class="card" style="grid-column:1/-1"><h3>Regression gate</h3><p class="hint">Runs the CURRENT production pipeline on a frozen set of reference transcripts and checks every note against the Style Spec. Run it before any release.</p>
      <label class="lbl" style="max-width:200px">Notes<select id="gt-n"><option>10</option><option selected>20</option><option>40</option></select></label><button class="btn primary" id="gt-go">Run the gate</button><div id="gt-out" style="margin-top:12px"></div></div></div>`;
  const rv = async () => { const { reviewers } = await studio('/reviewers'); $('#rv').innerHTML = reviewers.map((r) => `<div class="err-item"><div class="grow"><b>${esc(r.full_name || r.user_id)}</b> ${pill(r.active ? 'active' : 'off', r.active ? 'ok' : '')}</div>${r.active ? `<button class="btn sm danger" data-u="${esc(r.user_id)}">Remove</button>` : ''}</div>`).join('') || '<p class="hint">None.</p>'; $$('#rv [data-u]').forEach((b) => { b.onclick = async () => { await studio('/reviewers/' + b.dataset.u, { method: 'DELETE' }); rv(); }; }); };
  await rv();
  $('#rv-add').onclick = (e) => busy(e.currentTarget, 'Adding…', async () => { await studio('/reviewers', { method: 'POST', json: { email: $('#rv-email').value.trim() } }); toast('Reviewer added'); rv(); });
  $('#sd-go').onclick = (e) => busy(e.currentTarget, 'Writing the note (about 30 s)…', async () => { const r = await studio('/items/seed', { method: 'POST', json: { fixture: $('#sd-fix').value.trim() || undefined, transcript: $('#sd-tx').value.trim() || undefined } }); toast(`Case created (style check ${Math.round(r.conformance * 100)}%)`); });
  $('#ig').onclick = (e) => busy(e.currentTarget, 'Checking…', async () => { const r = await studio('/ingest/run', { method: 'POST', json: {} }); toast(`${r.added} new note(s), ${r.edits_captured} edit(s) captured`); });
  $('#tn-go').onclick = (e) => busy(e.currentTarget, 'Writing files…', async () => { const m = await studio('/tuning/export', { method: 'POST', json: { pool: $('#tn-pool').value } }); $('#tn-out').innerHTML = `train ${m.counts.train} · val ${m.counts.val} · test ${m.counts.test} — ${esc(m.note)}`; });
  const gateDraw = async () => { const { runs } = await studio('/gate/runs'); $('#gt-out').innerHTML = runs.length ? `<table><thead><tr><th>Run</th><th>Status</th><th>Mean style score</th><th>Notes at 90%+</th><th>Median time</th><th>Most failed rules</th></tr></thead><tbody>${runs.map((r) => `<tr><td>#${r.id}<br><small class="hint">${esc(when(r.started_at))}</small></td><td>${pill(r.status === 'done' ? 'done' : r.status === 'error' ? 'error' : `${r.done}/${r.n}`, r.status === 'done' ? 'ok' : r.status === 'error' ? 'bad' : 'acc')}</td>
      <td>${r.summary?.mean_conformance != null ? Math.round(r.summary.mean_conformance * 100) + '%' : '—'}</td><td>${r.summary?.notes_at_90 != null ? Math.round(r.summary.notes_at_90 * 100) + '%' : '—'}</td><td>${r.summary?.p50_ms ? (r.summary.p50_ms / 1000).toFixed(0) + ' s' : '—'}</td><td>${r.summary?.failures_by_rule ? Object.entries(r.summary.failures_by_rule).slice(0, 4).map(([k, v]) => `${k}×${v}`).join(', ') : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">No runs yet.</p>'; if (runs.some((r) => r.status === 'running') && location.hash === '#/tools') setTimeout(gateDraw, 5000); };
  $('#gt-go').onclick = (e) => busy(e.currentTarget, 'Starting…', async () => { await studio('/gate/run', { method: 'POST', json: { n: Number($('#gt-n').value) } }); toast('Gate started'); gateDraw(); });
  await gateDraw();
}

async function route() {
  const h = (location.hash || '#/').replace(/^#\//, ''); const [view, arg, arg2] = h.split('/');
  if (view === 'login') return loginView();
  if (!S.me) { try { S.me = await studio('/me', { quiet: true }); } catch (e) { return loginView(e.status === 403 ? 'This account has not been given access to Studio.' : ''); } }
  const owner = S.me.access === 'owner';
  if (!view || (S.me.access === 'interviewee' && !['interview'].includes(view))) { location.hash = homeFor(); return; }
  const v = view === 'review' ? 'queue' : view; const root = shell(v);
  try {
    root.innerHTML = '<div class="empty"><span class="spin"></span></div>';
    if (view === 'interview') { if (arg === 'part') await interviewPart(root, Number(arg2)); else if (arg === 'profile') await profileView(root); else await interviewHome(root); }
    else if (owner && view === 'interviews') { if (arg === 'person') await personView(root, arg2); else if (arg === 'compare') await compareView(root); else await interviewsAdmin(root); }
    else if (view === 'review') await reviewView(root, arg);
    else if (view === 'proposals') await proposalsView(root);
    else if (owner && view === 'dashboard') await dashboardView(root);
    else if (owner && view === 'spec') await specView(root);
    else if (owner && view === 'corpus') await corpusView(root);
    else if (owner && view === 'tools') await toolsView(root);
    else await queueView(root);
  } catch (e) { if (e.message !== 'Signed out') root.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
}
window.addEventListener('hashchange', route);
route();
