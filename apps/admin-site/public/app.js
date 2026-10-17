// Notera admin site — vanilla ES module, no build step. Talks only to its own origin (/backend/* → API on the Google VM).
const API = '/backend';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (t) => t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const ago = (t) => { if (!t) return '—'; const s = Math.max(0, (Date.now() - new Date(t)) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ico = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  overview: ico('<path d="M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10"/>'), users: ico('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 7M18 14a6 6 0 013.5 5.5"/>'),
  consults: ico('<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6M8 13h8M8 17h5"/>'), audio: ico('<path d="M4 10v4M8 6v12M12 3v18M16 8v8M20 11v2"/>'),
  activity: ico('<path d="M3 12h4l3-8 4 16 3-8h4"/>'), pipeline: ico('<path d="M4 6h6v4H4zM14 14h6v4h-6zM10 8h4a2 2 0 012 2v4"/>'), lab: ico('<path d="M12 3v4M12 17v4M4.2 7.5l3.5 2M16.3 14.5l3.5 2M4.2 16.5l3.5-2M16.3 9.5l3.5-2"/><circle cx="12" cy="12" r="3"/>'), system: ico('<rect x="3" y="4" width="7" height="6" rx="1.5"/><rect x="14" y="14" width="7" height="6" rx="1.5"/><path d="M10 7h4a3 3 0 013 3v4"/>'), prompts: ico('<path d="M4 5h16M4 10h16M4 15h10M4 20h6"/>'), settings: ico('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'), compare: ico('<path d="M8 3v18M16 3v18M3 8h5M16 16h5"/>'), optimize: ico('<path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z"/>'), trends: ico('<path d="M3 17l5-6 4 3 8-9M16 5h4v4"/>'), bench: ico('<path d="M9 3h6M10 3v6l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3"/>'),
};
const NAV = [
  ['Monitor', [['overview', 'Overview'], ['users', 'Users'], ['consults', 'Notes'], ['audio', 'Audio'], ['activity', 'Activity']]],
  ['Control', [['system', 'System'], ['prompts', 'Prompts'], ['settings', 'Settings']]],
  ['Lab', [['lab', 'Evaluate'], ['compare', 'Compare'], ['optimize', 'Optimize'], ['trends', 'Trends']]],
  ['Tools', [['pipeline', 'Pipeline log'], ['bench', 'Test bench']]],
];
const NAVKEYS = NAV.flatMap(([, items]) => items.map(([k]) => k));

import { labView, labStop } from './lab.js';
import { systemView, systemStop } from './system.js';
import { settingsView } from './settings.js';
import { promptsView } from './prompts.js';
import { compareView } from './compare.js';
import { optimizeView } from './optimize.js';
import { trendsView } from './trends.js';
const S = { user: null, view: 'overview', toastT: 0 };

function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : ''); clearTimeout(S.toastT); S.toastT = setTimeout(() => { t.className = ''; }, 2800); }

async function api(path, opts = {}) {
  const res = await fetch(API + path, { credentials: 'same-origin', ...opts, headers: { ...(opts.json ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });
  let data = null; const txt = await res.text(); try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if (res.status === 401 && !opts.noAuthRedirect) { S.user = null; renderLogin(); throw new Error('Signed out'); }
  if (!res.ok) { const e = new Error((data && (data.error || data.message)) || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

// markdown → html for notes (headings, bullets, bold)
function mdToHtml(md) {
  const out = []; let list = false;
  for (const raw of esc(md || '').split('\n')) {
    const ln = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const num = ln.match(/^\s*(\d+)\.\s+<b>(.+)<\/b>\s*$/);
    if (num) { if (list) { out.push('</ul>'); list = false; } out.push(`<p class="ap">${num[1]}. ${num[2]}</p>`); continue; }
    if (/^\s*[-*]\s+/.test(ln)) { if (!list) { out.push('<ul>'); list = true; } out.push('<li>' + ln.replace(/^\s*[-*]\s+/, '') + '</li>'); continue; }
    if (list) { out.push('</ul>'); list = false; }
    if (/^#{1,6}\s/.test(ln)) { out.push('<h3>' + ln.replace(/^#+\s/, '') + '</h3>'); continue; }
    if (ln.trim()) out.push('<p>' + ln + '</p>');
  }
  if (list) out.push('</ul>');
  return out.join('');
}

/* ───────────── login ───────────── */
function renderLogin(err = '') {
  $('#app').innerHTML = `<div class="login"><form class="card" id="lf"><h1>Notera Admin</h1><p>Sign in with an administrator account.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <div class="field"><label for="em">Email</label><input class="input" id="em" type="email" autocomplete="username" required autofocus></div>
    <div class="field"><label for="pw">Password</label><input class="input" id="pw" type="password" autocomplete="current-password" required></div>
    <button class="btn primary" style="width:100%;justify-content:center" id="go">Sign in</button></form></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault(); const b = $('#go'); b.disabled = true; b.textContent = 'Signing in…';
    try {
      const d = await api('/api/auth/login', { method: 'POST', json: { email: $('#em').value.trim(), password: $('#pw').value }, noAuthRedirect: true });
      if (d.user?.role !== 'admin') { await api('/api/auth/logout', { method: 'POST', noAuthRedirect: true }).catch(() => {}); return renderLogin('This account is not an administrator.'); }
      S.user = d.user; shell();
    } catch (er) { renderLogin(er.status === 401 ? 'Invalid email or password.' : er.status === 423 ? 'Account locked. Try again later.' : er.message); }
  };
}

/* ───────────── shell ───────────── */
function shell() {
  $('#app').innerHTML = `<div class="shell"><aside class="side"><div class="brand"><i>N</i><div>Notera<small>Admin console</small></div></div>
    ${NAV.map(([g, items]) => `<div class="navgrp">${g}</div>${items.map(([k, l]) => `<button class="nav${S.view === k ? ' on' : ''}" data-nav="${k}">${ICONS[k] || ''}${l}</button>`).join('')}`).join('')}
    <div class="grow"></div><div class="who"><b>${esc(S.user?.fullName || S.user?.email || 'Admin')}</b>${esc(S.user?.email || '')}<br><button class="btn sm" id="lo" style="margin-top:8px">Sign out</button></div></aside>
    <main class="main" id="view"></main></div>`;
  document.querySelectorAll('[data-nav]').forEach((b) => { b.onclick = () => go(b.dataset.nav); });
  $('#lo').onclick = async () => { await api('/api/auth/logout', { method: 'POST', noAuthRedirect: true }).catch(() => {}); S.user = null; renderLogin(); };
  go(S.view);
}
function go(v) {
  labStop(); systemStop(); if (!NAVKEYS.includes(v)) v = 'overview'; S.view = v; history.replaceState(null, '', '#' + v);
  document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === v));
  const fn = { overview, users, consults: () => consults(), audio: () => consults(true), activity, pipeline, bench, lab: () => labView(CTX), system: () => systemView(CTX), prompts: () => promptsView(CTX), settings: () => settingsView(CTX), compare: () => compareView(CTX), optimize: () => optimizeView(CTX), trends: () => trendsView(CTX) }[v] || overview;
  fn().catch((e) => { if (e.message !== 'Signed out') $('#view').innerHTML = `<div class="card empty">Could not load: ${esc(e.message)}</div>`; });
}
const head = (t, sub, tools = '') => `<div class="head"><div><h1>${t}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="tools">${tools}</div></div>`;
const table = (cols, rows, rowAttr = () => '') => rows.length
  ? `<div class="tbl-wrap"><table><thead><tr>${cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${c.h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr class="${rowAttr(r) ? 'click' : ''}" ${rowAttr(r)}>${cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  : '<div class="card empty">Nothing here yet.</div>';

/* ───────────── overview ───────────── */
async function overview() {
  $('#view').innerHTML = head('Overview', 'Live numbers from the production database') + '<div class="card empty">Loading…</div>';
  const d = await api('/api/console/overview');
  const u = d.users || {}, c = d.consults || {}, r = d.runs_7d || {};
  const bars = (rows) => { const max = Math.max(1, ...rows.map((x) => x.n)); return `<div class="bars">${rows.map((x) => `<div title="${x.day}: ${x.n}" style="height:${Math.max(4, (x.n / max) * 100)}%"><span>${x.n || ''}</span></div>`).join('')}</div><div class="bars-x">${rows.map((x) => `<span>${x.day.slice(8)}</span>`).join('')}</div>`; };
  $('#view').innerHTML = head('Overview', 'Live numbers from the production database', '<button class="btn" id="rf">Refresh</button>') + `
  <div class="cards">
    <div class="card stat"><div class="l">USERS</div><div class="n">${u.total ?? '—'}</div><div class="s">${u.full ?? 0} full · ${u.free ?? 0} free</div></div>
    <div class="card stat"><div class="l">NEW SIGN-UPS</div><div class="n">${u.new_7d ?? 0}</div><div class="s">${u.new_24h ?? 0} in 24h · 7d total</div></div>
    <div class="card stat"><div class="l">NOTES</div><div class="n">${c.total ?? 0}</div><div class="s">${c.d1 ?? 0} today · ${c.d7 ?? 0} in 7d</div></div>
    <div class="card stat"><div class="l">WITH AUDIO</div><div class="n">${c.with_audio ?? 0}</div><div class="s">recordings stored</div></div>
    <div class="card stat"><div class="l">NOTE RUNS (7D)</div><div class="n">${r.runs ?? 0}</div><div class="s">p50 ${r.p50 ? (r.p50 / 1000).toFixed(1) + 's' : '—'} · ${r.errors ?? 0} errors · $${(r.cost || 0).toFixed(2)}</div></div>
    <div class="card stat"><div class="l">FREE USERS AT LIMIT</div><div class="n">${d.free_at_limit}</div><div class="s">of ${d.free_limit} free notes used — upgrade candidates</div></div>
  </div>
  <div class="two"><div class="card"><b>Sign-ups, last 14 days</b>${bars(d.users_by_day || [])}</div><div class="card"><b>Notes, last 14 days</b>${bars(d.consults_by_day || [])}</div></div>`;
  $('#rf').onclick = () => overview();
}

/* ───────────── users ───────────── */
async function users() {
  let q = '', plan = '';
  const draw = async () => {
    const d = await api(`/api/console/users?q=${encodeURIComponent(q)}&plan=${plan}`);
    $('#tb').innerHTML = table([
      { h: 'User', f: (x) => `<b>${esc(x.full_name || x.email)}</b><div class="sub">${esc(x.email)}</div>` },
      { h: 'Plan', f: (x) => x.role === 'admin' ? '<span class="pill acc">admin</span>' : x.plan === 'free' ? `<span class="pill warn">free · ${x.free_notes_used}/${d.free_limit}</span>` : '<span class="pill ok">full</span>' },
      { h: 'Notes', num: 1, f: (x) => x.consults }, { h: 'Audio', num: 1, f: (x) => x.audio },
      { h: 'Last note', f: (x) => ago(x.last_consult) }, { h: 'Last login', f: (x) => ago(x.last_login_at) }, { h: 'Joined', f: (x) => fmtDate(x.created_at) },
    ], d.users, (x) => `data-user="${x.id}"`);
    document.querySelectorAll('[data-user]').forEach((tr) => { tr.onclick = () => userDrawer(tr.dataset.user, draw); });
  };
  $('#view').innerHTML = head('Users', 'Everyone who has an account — click a row for notes and plan controls', `<input class="input" id="q" placeholder="Search name or email" style="width:220px"><select class="select" id="pl"><option value="">All plans</option><option value="free">Free</option><option value="full">Full</option></select>`) + '<div id="tb"></div>';
  let t; $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); draw(); }, 250); };
  $('#pl').onchange = (e) => { plan = e.target.value; draw(); };
  await draw();
}
async function userDrawer(id, onChange) {
  const d = await api('/api/console/users/' + id); const u = d.user;
  openDrawer(`<div class="drawer-head"><div><h2>${esc(u.full_name || u.email)}</h2><div class="sub" style="color:var(--ink-3)">${esc(u.email)}</div></div><button class="btn sm" data-close>Close</button></div>
    <div class="drawer-body"><dl class="kv"><dt>Role</dt><dd>${esc(u.role)}</dd><dt>Plan</dt><dd>${u.plan === 'free' ? `free (${u.free_notes_used} notes used)` : 'full (unlimited)'}</dd><dt>Joined</dt><dd>${fmtDate(u.created_at)}</dd><dt>Last login</dt><dd>${fmtDate(u.last_login_at)}</dd><dt>Failed logins</dt><dd>${u.failed_logins}</dd></dl>
    <div class="tools" style="margin-bottom:16px">${u.plan === 'free' ? '<button class="btn primary sm" data-plan="full">Upgrade to full</button><button class="btn sm" data-plan="free" data-reset="1">Reset free quota</button>' : '<button class="btn sm danger" data-plan="free">Move to free plan</button>'}</div>
    <h3 style="margin:8px 0">Notes (${d.consults.length})</h3>${consultTable(d.consults)}</div>`);
  document.querySelectorAll('[data-plan]').forEach((b) => { b.onclick = async () => {
    if (!confirm(`Change ${u.email} to ${b.dataset.plan}${b.dataset.reset ? ' and reset the free quota' : ''}?`)) return;
    try { await api('/api/auth/users/plan', { method: 'POST', json: { email: u.email, plan: b.dataset.plan, reset: !!b.dataset.reset } }); toast('Plan updated'); closeDrawer(); onChange && onChange(); } catch (e) { toast(e.message, true); }
  }; });
  wireConsultRows();
}

/* ───────────── notes / audio ───────────── */
const consultTable = (rows) => table([
  { h: 'When', f: (x) => fmtDate(x.created_at) }, { h: 'Note', f: (x) => `<b>${esc(x.title || x.specialty || 'Consult')}</b><div class="sub">${esc((x.specialty || '').replace(/_/g, ' '))}</div>` },
  { h: 'User', f: (x) => esc(x.email || x.clinician_id || '—') }, { h: 'Status', f: (x) => `<span class="pill ${x.status === 'ready' || x.status === 'approved' ? 'ok' : x.status === 'error' ? 'bad' : ''}">${esc(x.status)}</span>` },
  { h: 'Audio', f: (x) => x.has_audio ? '<span class="pill acc">audio</span>' : '<span class="sub">—</span>' }, { h: 'Transcript', num: 1, f: (x) => x.transcript_chars ? x.transcript_chars.toLocaleString() : '—' },
], rows, (x) => `data-consult="${x.consult_id}"`);
function wireConsultRows() { document.querySelectorAll('[data-consult]').forEach((tr) => { tr.onclick = () => consultDrawer(tr.dataset.consult); }); }
async function consults(audioOnly = false) {
  let q = '';
  const draw = async () => { const d = await api(`/api/console/consults?limit=200&audio=${audioOnly ? 1 : 0}&q=${encodeURIComponent(q)}`); $('#tb').innerHTML = consultTable(d.consults); wireConsultRows(); };
  $('#view').innerHTML = head(audioOnly ? 'Audio' : 'Notes', audioOnly ? 'Every stored recording — open a note to play it' : 'Every generated SOAP note across all users — opening one is written to the audit log', `<input class="input" id="q" placeholder="Search title, user, specialty" style="width:240px">`) + '<div id="tb"></div>';
  let t; $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); draw(); }, 250); };
  await draw();
}
async function consultDrawer(id) {
  openDrawer('<div class="drawer-body"><div class="empty">Loading…</div></div>');
  const d = await api('/api/console/consults/' + encodeURIComponent(id)); const c = d.consult; const dr = d.drafts[0];
  const body = (tab) => ({
    note: dr?.rendered_note ? `<div class="note">${mdToHtml(dr.rendered_note)}</div>` : '<div class="empty">No generated note.</div>',
    transcript: `<div style="white-space:pre-wrap;line-height:1.6">${esc(c.transcript || 'No transcript saved.')}</div>`,
    json: `<pre class="raw">${esc(JSON.stringify({ note: dr?.note, flags: dr?.flags, finals: d.finals }, null, 2))}</pre>`,
    runs: (() => { const tr = dr?.note?.metadata?.pipeline_trace; return tr ? `<div class="card" style="margin-bottom:12px"><b>Produced with</b><div class="kv" style="margin-top:6px"><span>Writer</span><code>${esc(tr.config?.writer)}</code><span>Helper</span><code>${esc(tr.config?.helper)}</code><span>Temperature</span><code>${esc(tr.config?.temperature)}</code><span>Top-p</span><code>${esc(tr.config?.topP)}</code></div><div class="kv"><span>Writer prompt</span><code>${esc(tr.prompts?.writer)}</code><span>Checklist prompt</span><code>${esc(tr.prompts?.checklist)}</code><span>Verifier prompt</span><code>${esc(tr.prompts?.verifier)}</code></div></div>` : ''; })() + (d.runs.length ? table([{ h: 'When', f: (x) => fmtDate(x.created_at) }, { h: 'Model', f: (x) => esc(x.model) }, { h: 'Status', f: (x) => `<span class="pill ${x.status === 'ok' ? 'ok' : 'bad'}">${esc(x.status)}</span>` }, { h: 'Time', num: 1, f: (x) => (x.duration_ms / 1000).toFixed(1) + 's' }, { h: 'Tokens', num: 1, f: (x) => (x.total_tokens || 0).toLocaleString() }, { h: 'Cost', num: 1, f: (x) => '$' + Number(x.est_cost_usd || 0).toFixed(4) }], d.runs) : '<div class="empty">No pipeline run recorded.</div>'),
    audio: c.has_audio ? '<div id="au"><button class="btn primary" id="lau">Load recording</button></div>' : '<div class="empty">No audio stored for this note.</div>',
  }[tab]);
  const draw = (tab) => {
    openDrawer(`<div class="drawer-head"><div><h2>${esc(c.title || c.specialty || 'Consult')}</h2><div style="color:var(--ink-3)">${esc(c.email || c.clinician_id || '')} · ${fmtDate(c.created_at)} · ${esc(c.pipeline_version || 'pipeline n/a')}</div></div><div class="tools"><button class="btn sm" id="cp">Copy note</button><button class="btn sm" data-close>Close</button></div></div>
      <div class="tabs">${[['note', 'SOAP note'], ['transcript', 'Transcript'], ['audio', 'Audio'], ['runs', 'Pipeline'], ['json', 'Raw']].map(([k, l]) => `<button class="tab${tab === k ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
      <div class="drawer-body" style="padding-top:16px">${body(tab)}</div>`);
    document.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => draw(b.dataset.tab); });
    $('#cp').onclick = () => { navigator.clipboard.writeText(dr?.rendered_note || ''); toast('Note copied'); };
    const l = $('#lau'); if (l) l.onclick = async () => { l.disabled = true; try { const a = await api(`/api/console/consults/${encodeURIComponent(id)}/audio`); $('#au').innerHTML = `<audio controls autoplay src="${esc(a.url)}" style="width:100%"></audio><p style="color:var(--ink-3)">Link expires in ${Math.round(a.expiresInSec / 60)} min. This play is recorded in the audit log.</p>`; } catch (e) { toast(e.message, true); l.disabled = false; } };
  };
  draw('note');
}
function openDrawer(html) { closeDrawer(); const s = document.createElement('div'); s.className = 'scrim'; s.id = 'scrim'; s.onclick = closeDrawer; const d = document.createElement('div'); d.className = 'drawer'; d.id = 'drawer'; d.innerHTML = html; document.body.append(s, d); d.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeDrawer; }); }
function closeDrawer() { $('#scrim')?.remove(); $('#drawer')?.remove(); }
// re-bind close buttons after a drawer redraw
new MutationObserver(() => { document.querySelectorAll('#drawer [data-close]').forEach((b) => { b.onclick = closeDrawer; }); }).observe(document.body, { childList: true, subtree: true });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

/* ───────────── activity / pipeline ───────────── */
async function activity() {
  let action = '';
  const draw = async () => { const d = await api(`/api/console/audit?limit=300&action=${encodeURIComponent(action)}`);
    $('#tb').innerHTML = table([{ h: 'When', f: (x) => fmtDate(x.at) }, { h: 'Action', f: (x) => `<span class="pill ${/fail|lock/.test(x.action) ? 'bad' : /admin|plan/.test(x.action) ? 'warn' : x.action === 'signup' ? 'ok' : ''}">${esc(x.action)}</span>` }, { h: 'User', f: (x) => esc(x.email || '—') }, { h: 'Detail', f: (x) => `<span class="mono">${esc(x.detail ? JSON.stringify(x.detail).slice(0, 140) : '')}</span>` }, { h: 'IP', f: (x) => `<span class="mono">${esc(x.ip || '')}</span>` }], d.events); };
  $('#view').innerHTML = head('Activity', 'Sign-ups, logins, plan changes and every admin access to patient data', `<select class="select" id="ac"><option value="">All actions</option>${['signup', 'login', 'login_failed', 'plan_change', 'admin_view_consult', 'admin_play_audio', 'password_reset'].map((a) => `<option>${a}</option>`).join('')}</select>`) + '<div id="tb"></div>';
  $('#ac').onchange = (e) => { action = e.target.value; draw(); };
  await draw();
}
async function pipeline() {
  let range = '7d', tab = 'runs';
  const draw = async () => {
    const [sum, d] = await Promise.all([api(`/api/ops/summary?range=${range}`), api(`/api/ops/${tab}?range=${range}`)]);
    const cards = `<div class="cards"><div class="card stat"><div class="l">RUNS</div><div class="n">${sum.runs || 0}</div></div><div class="card stat"><div class="l">ERROR RATE</div><div class="n">${sum.runs ? ((sum.errors / sum.runs) * 100).toFixed(1) : '0.0'}%</div></div><div class="card stat"><div class="l">P50 / P95</div><div class="n">${sum.p50 ? (sum.p50 / 1000).toFixed(1) : '—'}s / ${sum.p95 ? (sum.p95 / 1000).toFixed(1) : '—'}s</div></div><div class="card stat"><div class="l">EST. SPEND</div><div class="n">$${Number(sum.cost || 0).toFixed(2)}</div></div></div>`;
    const t = tab === 'runs' ? table([{ h: 'When', f: (x) => ago(x.created_at) }, { h: 'Model', f: (x) => esc(x.model) }, { h: 'Status', f: (x) => `<span class="pill ${x.status === 'ok' ? 'ok' : 'bad'}">${esc(x.status)}</span>` }, { h: 'Time', num: 1, f: (x) => (x.duration_ms / 1000).toFixed(1) + 's' }, { h: 'Tokens', num: 1, f: (x) => (x.total_tokens || 0).toLocaleString() }, { h: 'Cost', num: 1, f: (x) => '$' + Number(x.est_cost_usd || 0).toFixed(4) }], d.runs || [])
      : tab === 'errors' ? table([{ h: 'When', f: (x) => ago(x.ts) }, { h: 'Source', f: (x) => esc(x.source) }, { h: 'Code', f: (x) => `<span class="mono">${esc(x.code)}</span>` }, { h: 'Agent', f: (x) => esc(x.agent || '') }, { h: 'Message', f: (x) => esc(String(x.message || '').slice(0, 140)) }], d.errors || [])
      : table([{ h: 'Account', f: (x) => esc(x.email) }, { h: 'Runs', num: 1, f: (x) => x.runs }, { h: 'Errors', num: 1, f: (x) => x.errors }, { h: 'Tokens', num: 1, f: (x) => Number(x.total_tokens).toLocaleString() }, { h: 'Cost', num: 1, f: (x) => '$' + Number(x.cost_usd).toFixed(2) }, { h: 'Avg time', num: 1, f: (x) => (x.avg_ms / 1000).toFixed(1) + 's' }, { h: 'Last active', f: (x) => ago(x.last_active) }], d.accounts || []);
    $('#tb').innerHTML = cards + t;
  };
  $('#view').innerHTML = head('Pipeline', 'Note generation health: speed, errors, cost per account', `<select class="select" id="rg">${['24h', '7d', '30d'].map((r) => `<option ${r === range ? 'selected' : ''}>${r}</option>`).join('')}</select><select class="select" id="tab"><option value="runs">Runs</option><option value="errors">Errors</option><option value="accounts">Per account</option></select>`) + '<div id="tb"></div>';
  $('#rg').onchange = (e) => { range = e.target.value; draw(); }; $('#tab').onchange = (e) => { tab = e.target.value; draw(); };
  await draw();
}

/* ───────────── test bench ───────────── */
const HIST_KEY = 'nadm_hist';
const hist = () => { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; } };
const pushHist = (x) => { try { localStorage.setItem(HIST_KEY, JSON.stringify([x, ...hist()].slice(0, 40))); } catch { /* */ } };

// Fixtures with facts the note MUST contain and things it must NEVER contain (deterministic accuracy checks).
const FIXTURES = [
  { name: 'Hypertension renewal', transcript: "Doctor: Hi, how are you? Patient: Good. I need my blood pressure pills renewed. Doctor: You take valsartan 160 milligrams daily and amlodipine 2.5 milligrams daily. Any side effects? Patient: No dizziness and no ankle swelling. Doctor: What are your home readings? Patient: Around 135 over 82. Doctor: That is fine. Continue both medications. I will renew them for six months and send it to Shoppers Drug Mart on Main Street. Come back in six months.",
    must: [/valsartan/i, /160\s?mg/i, /amlodipine/i, /2\.5\s?mg/i, /135\s?\/\s?82/, /shoppers/i, /(six|6) months/i, /dizziness/i], never: [/metformin|insulin|warfarin|lisinopril/i] },
  { name: 'Ankle sprain', transcript: "Doctor: What happened? Patient: I twisted my right ankle playing soccer three days ago. It is swollen and I cannot put full weight on it. Doctor: Any numbness or tingling? Patient: No numbness. Doctor: On exam there is swelling and bruising over the lateral malleolus and it is tender, but the ankle is stable. I would like an X-ray to rule out a fracture. Use ice, elevation and ibuprofen 400 milligrams three times a day with food. Follow up in one week.",
    must: [/right ankle/i, /(three|3) days/i, /x-?ray/i, /ibuprofen/i, /400\s?mg/i, /(one|1) week/i, /lateral malleolus/i, /numbness/i], never: [/fracture (was )?confirmed|surgery|cast/i] },
  { name: 'Chest pain', transcript: "Doctor: What brings you in today? Patient: Sharp chest pain on the left since last night, about seven out of ten. It is worse when I lie down or take a deep breath. Doctor: Any shortness of breath or palpitations? Patient: Yes, my heart is racing. Doctor: Any fever or cough? Patient: No fever and no cough. My dad had a heart attack at 45 and I smoke a pack a day. Doctor: I want an ECG and a troponin today. Please go to the emergency department.",
    must: [/chest pain/i, /(7|seven)\s?(\/|out of)\s?10|7\/10/i, /palpitations|racing/i, /heart attack/i, /45/, /pack/i, /ecg/i, /troponin/i, /emergency/i, /fever/i], never: [/pneumonia|pulmonary embolism confirmed|aspirin/i] },
];
const FORBIDDEN = /none stated|not (stated|mentioned|specified)|n\/a|\blet'?s\b|as per (the )?transcript|\btranscript\b/i;

async function runNote(transcript, { title, specialty = 'auto', save = true } = {}) {
  const t0 = performance.now();
  const start = await api('/api/consults/async', { method: 'POST', json: { transcript, specialty, noteType: 'consultation', clinicianId: S.user.id } });
  let res;
  for (let i = 0; i < 200; i++) { await sleep(i < 4 ? 900 : 1500); const j = await api('/api/consults/job/' + start.jobId); if (j.status === 'done') { res = j.result; break; } if (j.status === 'error') throw new Error(j.error || 'note failed'); }
  if (!res) throw new Error('timed out waiting for the note');
  const ms = performance.now() - t0;
  if (save && res.consultId) await api('/api/library/consults', { method: 'POST', json: { consultId: res.consultId, transcript, renderedNote: res.renderedNote, title: title || '[TEST]', specialty: res.detectedSpecialty || specialty, status: 'ready' } }).catch(() => {});
  return { note: res.renderedNote || '', consultId: res.consultId, ms };
}

// decode any audio file → 16 kHz mono → 20 s WAV chunks (mirrors what the real recorder sends)
async function chunkAudio(file, onProg) {
  const ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const audio = await ac.decodeAudioData(await file.arrayBuffer()); ac.close();
  const n = audio.length, ch = audio.numberOfChannels, mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
  const CH = 16000 * 20, out = [];
  for (let s = 0; s < n; s += CH) { out.push(wav(mono.subarray(s, Math.min(n, s + CH)))); onProg && onProg(out.length); }
  return { chunks: out, seconds: n / 16000 };
}
function wav(f32) {
  const b = new ArrayBuffer(44 + f32.length * 2), v = new DataView(b), w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + f32.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, f32[i])) * 32767, true);
  return new Blob([b], { type: 'audio/wav' });
}
async function asrChunk(blob) {
  for (let a = 0; a < 3; a++) { try { const d = await api('/api/asr', { method: 'POST', body: blob, headers: { 'Content-Type': 'audio/wav' } }); return (d.text || d.transcript || '').trim(); } catch (e) { if (a === 2 || (e.status && e.status < 500 && e.status !== 429)) throw e; await sleep(1200 * (a + 1)); } }
}

async function bench() {
  $('#view').innerHTML = head('Test bench', 'Run audio or text through the real production pipeline, check accuracy, and keep a log') + `
  <div class="two"><div class="card"><h3>Audio → transcript → SOAP note</h3><p style="color:var(--ink-3);margin:4px 0 12px">Any length. The file is split into 20-second chunks exactly like the live recorder, transcribed in order, then written up.</p>
    <div class="drop" id="drop">Drop an audio file here or <label style="color:var(--accent);cursor:pointer;font-weight:600">choose one<input type="file" id="file" accept="audio/*,video/*" hidden></label></div>
    <div class="tools" style="margin-top:12px"><label><input type="checkbox" id="sv" checked> Save to library (with audio)</label></div><div id="run"></div></div>
  <div class="card"><h3>Paste a transcript → SOAP note</h3><textarea id="tx" rows="7" placeholder="Paste a consultation transcript…" style="margin:10px 0"></textarea><button class="btn primary" id="pb">Generate note</button><div id="prun"></div></div></div>
  <div class="card" style="margin-bottom:18px"><div class="head" style="margin:0 0 10px"><div><h3>Smoke &amp; accuracy checks</h3><p style="margin:2px 0 0;color:var(--ink-3)">API, auth, console, speech path, and ${FIXTURES.length} note fixtures with required facts and forbidden phrases</p></div><button class="btn primary" id="smoke">Run all checks</button></div><div id="checks"></div></div>
  <div class="card"><h3 style="margin-bottom:10px">Recent test runs (this browser)</h3><div id="hist"></div></div>`;
  const histDraw = () => { const h = hist(); $('#hist').innerHTML = h.length ? table([{ h: 'When', f: (x) => fmtDate(x.t) }, { h: 'Test', f: (x) => esc(x.name) }, { h: 'Result', f: (x) => `<span class="pill ${x.ok ? 'ok' : 'bad'}">${x.ok ? 'pass' : 'fail'}</span>` }, { h: 'Time', num: 1, f: (x) => x.ms ? (x.ms / 1000).toFixed(1) + 's' : '—' }, { h: 'Detail', f: (x) => esc(x.detail || '') }], h) : '<div class="empty">No runs yet.</div>'; };
  histDraw();

  const drop = $('#drop');
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) audioFlow(f); });
  $('#file').onchange = (e) => { if (e.target.files[0]) audioFlow(e.target.files[0]); };

  async function audioFlow(file) {
    const box = $('#run'); const steps = ['Decoding audio', 'Transcribing', 'Writing note', 'Saving']; let cur = -1;
    const draw = (extra = '', fail = -1) => { box.innerHTML = `<div class="steps">${steps.map((s, i) => `<div class="step ${fail === i ? 'fail' : i < cur ? 'done' : i === cur ? 'now' : ''}"><span class="d"></span>${s}</div>`).join('')}</div><div class="prog"><i id="pr"></i></div>${extra}`; };
    const t0 = performance.now(); const tm = {}; let transcript = '';
    try {
      cur = 0; draw(); const { chunks, seconds } = await chunkAudio(file); tm.decode = performance.now() - t0;
      cur = 1; draw(`<p style="color:var(--ink-3)">${chunks.length} chunks · ${(seconds / 60).toFixed(1)} min of audio</p>`);
      const texts = new Array(chunks.length); let done = 0, next = 0; const t1 = performance.now();
      await Promise.all(Array.from({ length: 3 }, async () => { while (next < chunks.length) { const i = next++; texts[i] = await asrChunk(chunks[i]); done++; $('#pr').style.width = (done / chunks.length * 100) + '%'; } }));
      transcript = texts.filter(Boolean).join('\n'); tm.asr = performance.now() - t1;
      if (!transcript.trim()) throw new Error('No speech was detected in this audio');
      cur = 2; draw(); const r = await runNote(transcript, { title: '[TEST] ' + file.name, save: $('#sv').checked }); tm.note = r.ms;
      if ($('#sv').checked && r.consultId) { cur = 3; draw(); try { await api(`/api/library/consults/${r.consultId}/audio`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'audio/mpeg' } }); } catch (e) { toast('Audio not stored: ' + e.message, true); } }
      cur = 4; draw(); const total = performance.now() - t0;
      box.innerHTML += `<dl class="kv"><dt>Audio</dt><dd>${(seconds / 60).toFixed(1)} min · ${esc(file.name)}</dd><dt>Decode</dt><dd>${(tm.decode / 1000).toFixed(1)}s</dd><dt>Transcribe</dt><dd>${(tm.asr / 1000).toFixed(1)}s (${transcript.split(/\s+/).length} words)</dd><dt>Note</dt><dd>${(tm.note / 1000).toFixed(1)}s</dd><dt>Total</dt><dd><b>${(total / 1000).toFixed(1)}s</b></dd></dl>
        <details><summary style="cursor:pointer;color:var(--ink-3)">Transcript</summary><div style="white-space:pre-wrap;margin-top:8px">${esc(transcript)}</div></details><div class="note" style="margin-top:12px">${mdToHtml(r.note)}</div>`;
      const bad = FORBIDDEN.test(r.note); pushHist({ t: Date.now(), name: 'Audio: ' + file.name, ok: !bad, ms: total, detail: bad ? 'forbidden phrase in note' : `${(seconds / 60).toFixed(1)} min audio` }); histDraw();
    } catch (e) { draw(`<div class="err" style="margin-top:10px">${esc(e.message)}</div>`, Math.max(cur, 0)); pushHist({ t: Date.now(), name: 'Audio: ' + file.name, ok: false, ms: performance.now() - t0, detail: e.message }); histDraw(); }
  }

  $('#pb').onclick = async () => {
    const tx = $('#tx').value.trim(); if (!tx) return toast('Paste a transcript first', true);
    const b = $('#pb'); b.disabled = true; b.textContent = 'Writing…';
    try { const r = await runNote(tx, { title: '[TEST] pasted' }); $('#prun').innerHTML = `<p style="color:var(--ink-3)">Done in <b>${(r.ms / 1000).toFixed(1)}s</b></p><div class="note">${mdToHtml(r.note)}</div>`; pushHist({ t: Date.now(), name: 'Pasted transcript', ok: !FORBIDDEN.test(r.note), ms: r.ms, detail: `${tx.split(/\s+/).length} words` }); histDraw(); }
    catch (e) { $('#prun').innerHTML = `<div class="err" style="margin-top:10px">${esc(e.message)}</div>`; }
    b.disabled = false; b.textContent = 'Generate note';
  };

  $('#smoke').onclick = async () => {
    const b = $('#smoke'); b.disabled = true; const rows = []; const box = $('#checks');
    const paint = () => { box.innerHTML = `<div class="tbl-wrap"><table class="checks"><tbody>${rows.map((r) => `<tr><td><span class="mark ${r.state}">${r.state === 'ok' ? '✓' : r.state === 'bad' ? '✕' : '…'}</span></td><td><b>${esc(r.name)}</b><div class="sub">${esc(r.detail || '')}</div></td><td class="num">${r.ms ? (r.ms / 1000).toFixed(1) + 's' : ''}</td></tr>`).join('')}</tbody></table></div>`; };
    const check = async (name, fn) => { const r = { name, state: 'run', detail: 'running…' }; rows.push(r); paint(); const t = performance.now(); try { r.detail = (await fn()) || 'ok'; r.state = 'ok'; } catch (e) { r.detail = e.message; r.state = 'bad'; } r.ms = performance.now() - t; paint(); pushHist({ t: Date.now(), name, ok: r.state === 'ok', ms: r.ms, detail: r.detail }); };
    await check('API health', async () => { const d = await api('/healthz', { noAuthRedirect: true }); if (!d.ok) throw new Error('healthz not ok'); return `service ${d.service}, pipeline ${d.version}`; });
    await check('Admin session', async () => { const d = await api('/api/auth/me'); if (d.user.role !== 'admin') throw new Error('not an admin'); return d.user.email; });
    await check('Console data', async () => { const [o, u, c] = await Promise.all([api('/api/console/overview'), api('/api/console/users?limit=5'), api('/api/console/consults?limit=5')]); return `${o.users?.total} users, ${o.consults?.total} notes`; });
    await check('Speech path (1 s of silence)', async () => { const t = await asrChunk(wav(new Float32Array(16000))); return t ? `unexpected text: ${t.slice(0, 40)}` : 'accepted, empty transcript (expected)'; });
    for (const f of FIXTURES) {
      await check('Note accuracy — ' + f.name, async () => {
        const r = await runNote(f.transcript, { title: '[TEST] ' + f.name }); const miss = f.must.filter((rx) => !rx.test(r.note)).map(String); const bad = [...f.never, FORBIDDEN].filter((rx) => rx.test(r.note)).map(String);
        if (!/Diagnosis:/i.test(r.note)) bad.push('no Diagnosis line');
        if (miss.length || bad.length) throw new Error(`${miss.length ? 'missing: ' + miss.join(' ') : ''}${bad.length ? ' forbidden: ' + bad.join(' ') : ''}`.trim());
        return `all ${f.must.length} required facts present, nothing forbidden (${(r.ms / 1000).toFixed(1)}s)`;
      });
    }
    const pass = rows.filter((r) => r.state === 'ok').length; toast(`${pass}/${rows.length} checks passed`, pass !== rows.length); b.disabled = false; histDraw();
  };
}

const CTX = { $, esc, ago, fmtDate, table, head, toast, openDrawer, closeDrawer, api, mdToHtml, go };

/* ───────────── boot ───────────── */
(async () => {
  const v = location.hash.slice(1); if (NAVKEYS.includes(v)) S.view = v;
  try { const d = await api('/api/auth/me', { noAuthRedirect: true }); if (d.user?.role === 'admin') { S.user = d.user; shell(); } else { renderLogin(d.user ? 'This account is not an administrator.' : ''); } }
  catch { renderLogin(); }
})();
