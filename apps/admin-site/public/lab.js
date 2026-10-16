// Lab: evaluate → compare (blind judge) → improve (a stronger model proposes a better prompt) → validate → promote.
// Talks to the lab service on the VM through the Worker (/lab/*, admin-session gated) and to the production console
// (/backend/api/console/prompts*) for promote / rollback. `ctx` carries the helpers from app.js.
let T = null;                       // auto-refresh timer
const P = { tab: 'run', mode: 'random', n: 20, from: 1, to: 20, last: 20, picked: new Set(), q: '', model: 'gemini-3.5-flash-lite', prompt: 'active', temp: '', topP: '', label: '' };
let FX = null;                      // [[id, transcriptChars, goldChars], …] loaded once

const MODELS = [
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite (default, cheapest)'],
  ['gemini-2.5-flash', 'Gemini 2.5 Flash (current production writer)'],
  ['gemini-2.5-pro', 'Gemini 2.5 Pro (highest quality)'],
];
const pretty = (id) => id.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

export async function labView(ctx) {
  const { $, esc, ago, fmtDate, table, head, toast, openDrawer, closeDrawer, api, mdToHtml } = ctx;
  const lab = async (path, opts = {}) => {
    const res = await fetch('/lab' + path, { credentials: 'same-origin', method: opts.method, headers: opts.json ? { 'Content-Type': 'application/json' } : {}, body: opts.json ? JSON.stringify(opts.json) : undefined });
    const txt = await res.text(); let d = null; try { d = txt ? JSON.parse(txt) : null; } catch { d = { error: txt.slice(0, 120) }; }
    if (!res.ok) throw new Error((d && d.error) || `HTTP ${res.status}`);
    return d;
  };
  const sel = []; let lastJudge = null; let busy = false; let info = null, cands = { candidates: [] }, prod = { versions: [] }, base = { chars: 0 };
  const f3 = (x) => (x == null ? '—' : Number(x).toFixed(3));
  const stat = (r, k) => (r.summary ? r.summary[k] : null);
  const models = () => (MODELS.some(([v]) => v === P.model) ? MODELS : [...MODELS, [P.model, P.model]]);
  const opts = (arr, cur) => arr.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`).join('');

  $('#view').innerHTML = head('Lab', 'Test the note writer on expert-written gold notes, compare versions blind, and let a stronger model improve the prompt', '<button class="btn" id="lrf">Refresh</button>')
    + `<div id="lab-root" class="card empty">Loading…</div>`;
  $('#lrf').onclick = () => draw();

  // ───────────── selection ─────────────
  const ids = () => (FX || []).map((f) => f[0]);
  const chosen = () => {
    const all = ids();
    if (P.mode === 'range') { const a = Math.max(1, Math.min(P.from, P.to)), b = Math.min(all.length, Math.max(P.from, P.to)); return all.slice(a - 1, b); }
    if (P.mode === 'last') return all.slice(-Math.min(P.last, all.length));
    if (P.mode === 'pick') return [...P.picked];
    return null;   // random: drawn at start time
  };
  const willRun = () => (P.mode === 'random' ? Math.min(P.n, ids().length) : chosen().length);
  const filtered = () => { const s = P.q.trim().toLowerCase(); return (FX || []).map((f, i) => ({ id: f[0], t: f[1], g: f[2], pos: i + 1 })).filter((x) => !s || x.id.toLowerCase().includes(s) || pretty(x.id).toLowerCase().includes(s)); };
  const pickRandom = (n) => { const a = ids().slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };

  function drawSelector() {
    const box = $('#lsel'); if (!box) return;
    const total = ids().length;
    const modeBtn = (m, l) => `<button type="button" class="seg${P.mode === m ? ' on' : ''}" data-mode="${m}" aria-pressed="${P.mode === m}">${l}</button>`;
    let body = '';
    if (P.mode === 'random') body = `<label class="lbl">How many random notes<input class="input" id="lnum" type="number" min="1" max="${Math.min(total, 400)}" value="${P.n}" style="width:90px"></label><span class="hint">Drawn fresh each run from all ${total.toLocaleString()} usable gold notes. Every run records exactly which notes it used.</span>`;
    else if (P.mode === 'last') body = `<label class="lbl">How many from the end of the list<input class="input" id="llast" type="number" min="1" max="${Math.min(total, 400)}" value="${P.last}" style="width:90px"></label><span class="hint">The most recently added gold notes (the list is in file order).</span>`;
    else if (P.mode === 'range') body = `<label class="lbl">From #<input class="input" id="lfrom" type="number" min="1" max="${total}" value="${P.from}" style="width:90px"></label><label class="lbl">to #<input class="input" id="lto" type="number" min="1" max="${total}" value="${P.to}" style="width:90px"></label><span class="hint">Positions 1–${total.toLocaleString()} in the gold list (max 400 per run).</span>`;
    else {
      const list = filtered();
      body = `<div class="pickbar"><input class="input grow" id="lq" type="search" placeholder="Search ${total.toLocaleString()} gold notes… (e.g. diabetes, chest pain, knee)" value="${esc(P.q)}" aria-label="Search gold notes">
        <button type="button" class="btn sm" id="lall">Select all${P.q.trim() ? ` (${Math.min(list.length, 400)})` : ' shown'}</button><button type="button" class="btn sm" id="lclr" ${P.picked.size ? '' : 'disabled'}>Clear</button></div>
        <div class="picklist" role="group" aria-label="Gold notes">${list.length ? list.slice(0, 300).map((x) => `<label class="prow${P.picked.has(x.id) ? ' on' : ''}"><input type="checkbox" data-pick="${esc(x.id)}" ${P.picked.has(x.id) ? 'checked' : ''}><span class="pn">${x.pos}</span><span class="pt">${esc(pretty(x.id))}</span><span class="pm">${Math.round(x.t / 1000)}k transcript</span></label>`).join('') : `<div class="empty">No gold notes match “${esc(P.q)}”.</div>`}${list.length > 300 ? `<div class="empty" style="padding:8px">Showing the first 300 of ${list.length} — type to narrow the search.</div>` : ''}</div>`;
    }
    box.innerHTML = `<div class="segs" role="group" aria-label="How to choose notes">${modeBtn('random', 'Random')}${modeBtn('pick', 'Pick &amp; search')}${modeBtn('range', 'Range')}${modeBtn('last', 'Latest')}</div><div class="selbody">${body}</div>`;
    const upd = () => { const g = $('#lgo'); const k = willRun(); if (g) { g.disabled = k < 1 || k > 400 || busy; g.textContent = k > 400 ? 'Over 400 — choose fewer' : `Start run · ${k} note${k === 1 ? '' : 's'}`; } const c = $('#lcnt'); if (c) c.textContent = `${k} note${k === 1 ? '' : 's'} selected`; };
    box.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { P.mode = b.dataset.mode; drawSelector(); }; });
    const num = (id, key, lo, hi) => { const e = $(id, box); if (e) e.oninput = () => { P[key] = Math.max(lo, Math.min(hi, Number(e.value) || lo)); upd(); }; };
    num('#lnum', 'n', 1, 400); num('#llast', 'last', 1, 400); num('#lfrom', 'from', 1, total); num('#lto', 'to', 1, total);
    const q = $('#lq', box); if (q) { q.oninput = () => { P.q = q.value; const pos = q.selectionStart; drawSelector(); const q2 = $('#lq'); q2.focus(); q2.setSelectionRange(pos, pos); }; }
    box.querySelectorAll('[data-pick]').forEach((c) => { c.onchange = () => { if (c.checked) P.picked.add(c.dataset.pick); else P.picked.delete(c.dataset.pick); c.closest('.prow').classList.toggle('on', c.checked); const clr = $('#lclr'); if (clr) clr.disabled = !P.picked.size; upd(); }; });
    const all = $('#lall', box); if (all) all.onclick = () => { filtered().slice(0, 400).forEach((x) => P.picked.add(x.id)); drawSelector(); };
    const clr = $('#lclr', box); if (clr) clr.onclick = () => { P.picked.clear(); drawSelector(); };
    upd();
  }

  async function startRun() {
    const body = { writerModel: P.model, label: P.label.trim() };
    const a = chosen() || pickRandom(P.n); body.ids = a;
    if (P.temp !== '') body.writerTemp = Number(P.temp); if (P.topP !== '') body.writerTopP = Number(P.topP);
    if (P.prompt === 'default') body.prompt = 'default'; else if (P.prompt !== 'active') body.candidateId = P.prompt;
    busy = true; $('#lgo').disabled = true;
    try { await lab('/runs', { method: 'POST', json: body }); toast(`Run started · ${a.length} notes`); } catch (e) { toast(e.message, true); }
    busy = false; draw();
  }

  // ───────────── main draw ─────────────
  async function load() {
    [info, base, cands, prod] = await Promise.all([lab('/info'), lab('/baseline'), lab('/candidates'), api('/api/console/prompts')]);
    if (!FX) FX = (await lab('/fixtures')).fixtures;
  }

  async function draw() {
    if (!$('#lab-root')) return;
    clearTimeout(T);
    try { await load(); } catch (e) { $('#lab-root').className = 'card'; $('#lab-root').innerHTML = `<div class="err">The lab is not reachable: ${esc(e.message)}</div>`; return; }
    $('#lab-root').className = '';
    const activeV = prod.versions.find((v) => v.active);
    $('#lab-root').innerHTML = `
    <div class="cards">
      <div class="card stat"><div class="l">GOLD NOTES</div><div class="n">${info.usable.toLocaleString()}</div><div class="s">usable of ${info.fixtures.toLocaleString()} · transcript → expert note</div></div>
      <div class="card stat"><div class="l">PRODUCTION WRITER</div><div class="n" style="font-size:18px;margin-top:8px">${esc(info.writerModel)}</div><div class="s">fallback ${esc(info.writerFallback || '—')} · judge ${esc(info.models.judge)}</div></div>
      <div class="card stat"><div class="l">PRODUCTION PROMPT</div><div class="n" style="font-size:18px;margin-top:8px">${activeV ? 'Promoted v' + activeV.version : 'Built-in default'}</div><div class="s">${base.chars.toLocaleString()} chars · ${prod.versions.length} saved version${prod.versions.length === 1 ? '' : 's'}</div></div>
    </div>
    <div class="subtabs" role="tablist">${[['run', 'Run &amp; results'], ['improve', 'Improve prompt'], ['prod', 'Production prompt']].map(([k, l]) => `<button class="subtab${P.tab === k ? ' on' : ''}" role="tab" aria-selected="${P.tab === k}" data-t="${k}">${l}</button>`).join('')}</div>
    <div id="ltab"></div>`;
    document.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => { P.tab = b.dataset.t; draw(); }; });
    if (P.tab === 'run') await drawRun(); else if (P.tab === 'improve') drawImprove(); else drawProd();
  }

  const runCols = [
    { h: '', f: (r) => `<input type="checkbox" aria-label="Select run for comparison" data-sel="${r.id}" ${sel.includes(r.id) ? 'checked' : ''} ${r.status === 'running' ? 'disabled' : ''}>` },
    { h: 'Run', f: (r) => `<b>${esc(r.label || r.id.slice(-8))}</b><div class="sub">${ago(r.createdAt)} · ${esc(r.id.slice(-8))}</div>` },
    { h: 'Status', f: (r) => r.status === 'running' ? `<span class="pill acc">running ${r.progress.done}/${r.progress.total}</span>` : `<span class="pill ${r.status === 'done' ? 'ok' : ['error', 'interrupted', 'cancelled'].includes(r.status) ? 'bad' : ''}">${esc(r.status)}</span>` },
    { h: 'Writer / prompt', f: (r) => `<span class="sub">${esc(r.config.writerModel || 'default')} · ${esc(String(r.config.promptSource).replace('candidate:', 'cand '))}${r.config.writerTemp != null ? ' · T' + r.config.writerTemp : ''}</span>` },
    { h: 'N', num: 1, f: (r) => r.config.n }, { h: 'Similarity', num: 1, f: (r) => f3(stat(r, 'avg_similarity_to_gold')) }, { h: 'Omission', num: 1, f: (r) => f3(stat(r, 'avg_omission_rate')) },
    { h: 'Flow', num: 1, f: (r) => f3(stat(r, 'avg_story_flow')) }, { h: 'p50', num: 1, f: (r) => (stat(r, 'p50_s') != null ? stat(r, 'p50_s') + 's' : '—') }, { h: 'Fail', num: 1, f: (r) => stat(r, 'failed') ?? '—' },
    { h: '', f: (r) => `<div class="tools">${r.status === 'running' ? `<button class="btn sm" data-stop="${r.id}">Stop</button>` : `<button class="btn sm" data-rerun="${r.id}" title="Run the same notes again">Re-run</button>`}<button class="btn sm" data-open="${r.id}">Open</button></div>` },
  ];

  async function drawRun() {
    $('#ltab').innerHTML = `
    <section class="card" style="margin-bottom:18px"><h3 style="margin:0 0 12px">New evaluation</h3>
      <div class="step"><div class="stephead"><b>1 · Choose notes</b><span id="lcnt" class="pill acc"></span></div><div id="lsel"></div></div>
      <div class="step"><div class="stephead"><b>2 · Writer &amp; prompt</b></div>
        <div class="grid2">
          <label class="lbl">Writer model<select class="select" id="lm">${opts(models(), P.model)}</select></label>
          <label class="lbl">Prompt<select class="select" id="lp">${opts([['active', 'Production (active)'], ['default', 'Built-in default'], ...cands.candidates.map((c) => [c.id, 'Candidate ' + c.id.slice(-6) + ' · ' + ago(c.createdAt)])], P.prompt)}</select></label>
          <label class="lbl">Run name <span class="hint">(optional)</span><input class="input" id="ll" placeholder="e.g. Lite vs Flash" value="${esc(P.label)}"></label>
        </div>
        <details style="margin-top:8px"><summary class="hint" style="cursor:pointer">Advanced: temperature / topP</summary><div class="grid2" style="margin-top:8px"><label class="lbl">Temperature<input class="input" id="lt" type="number" step="0.1" min="0" max="1" placeholder="0.3" value="${esc(P.temp)}"></label><label class="lbl">topP<input class="input" id="ltp" type="number" step="0.05" min="0.1" max="1" placeholder="0.9" value="${esc(P.topP)}"></label></div></details></div>
      <div class="step"><div class="stephead"><b>3 · Start</b></div><div class="tools"><button class="btn primary" id="lgo">Start run</button><span class="hint">About 6 s per note, 3 at a time — 20 notes ≈ 1–2 min. Runs on the Google VM backend.</span></div></div>
    </section>
    <div class="head" style="margin:0 0 8px"><h3>Runs</h3><div class="tools"><span class="hint" id="lselc"></span><button class="btn sm primary" id="jg" disabled>Compare blind (A vs B)</button></div></div>
    <div id="lj"></div><div id="lruns"></div>
    <p class="hint">Similarity ↑ better · Omission ↓ better (gold-note facts missing) · Flow ↑ better. Tick two runs on the same notes, then compare blind to see which prompt/model really wins.</p>`;
    drawSelector();
    $('#lm').onchange = (e) => { P.model = e.target.value; }; $('#lp').onchange = (e) => { P.prompt = e.target.value; };
    $('#ll').oninput = (e) => { P.label = e.target.value; }; $('#lt').oninput = (e) => { P.temp = e.target.value; }; $('#ltp').oninput = (e) => { P.topP = e.target.value; };
    $('#lgo').onclick = startRun;
    await refreshRuns();
  }

  let runsCache = [];
  async function refreshRuns() {
    if (!$('#lruns')) return;
    clearTimeout(T);
    try { runsCache = (await lab('/runs')).runs; } catch { /* transient */ }
    renderRuns();
    if (runsCache.some((r) => r.status === 'running')) T = setTimeout(refreshRuns, 5000);
  }
  function renderRuns() {
    const host = $('#lruns'); if (!host) return; const runs = runsCache;
    host.innerHTML = table(runCols, runs);
    $('#lselc').textContent = `${sel.length}/2 selected`;
    const jg = $('#jg'); jg.disabled = sel.length !== 2; jg.onclick = () => judge(sel[0], sel[1]);
    host.querySelectorAll('[data-sel]').forEach((c) => { c.onchange = () => { const id = c.dataset.sel; const i = sel.indexOf(id); if (i >= 0) sel.splice(i, 1); else { if (sel.length >= 2) sel.shift(); sel.push(id); } renderRuns(); }; });
    host.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openRun(b.dataset.open); });
    host.querySelectorAll('[data-stop]').forEach((b) => { b.onclick = async () => { await lab(`/runs/${b.dataset.stop}/cancel`, { method: 'POST' }); toast('Stopping…'); refreshRuns(); }; });
    host.querySelectorAll('[data-rerun]').forEach((b) => { b.onclick = async () => { try { const r = await lab('/runs/' + b.dataset.rerun); const old = runs.find((x) => x.id === b.dataset.rerun); await lab('/runs', { method: 'POST', json: { ids: r.ids || r.rows.map((x) => x.id), writerModel: old?.config.writerModel || P.model, label: 'Re-run ' + (old?.label || b.dataset.rerun.slice(-6)) } }); toast('Re-run started'); refreshRuns(); } catch (e) { toast(e.message, true); } }; });
    if (lastJudge) renderJudge(lastJudge);
  }

  async function judge(a, b) {
    const j = $('#jg'); j.disabled = true; j.textContent = 'Judging…';
    try {
      const { id } = await lab('/judge', { method: 'POST', json: { a, b, limit: 30 } });
      for (let i = 0; i < 120; i++) { await new Promise((r) => setTimeout(r, 4000)); const d = await lab('/judge/' + id); if ($('#jg')) $('#jg').textContent = `Judging ${d.progress.done}/${d.progress.total}…`; if (d.status === 'done') { lastJudge = d; break; } if (d.status === 'error') throw new Error(d.error); }
      renderJudge(lastJudge);
    } catch (e) { toast(e.message, true); }
    if ($('#jg')) { $('#jg').textContent = 'Compare blind (A vs B)'; $('#jg').disabled = sel.length !== 2; }
  }
  function renderJudge(d) {
    if (!d || !d.summary || !$('#lj')) return;
    const R = runsCache; const A = R.find((r) => r.id === d.a), B = R.find((r) => r.id === d.b);
    const s = d.summary; const dl = (x, y, inv) => { const v = y - x; return `<span class="pill ${(inv ? v < 0 : v > 0) ? 'ok' : v === 0 ? '' : 'bad'}">${v > 0 ? '+' : ''}${v.toFixed(2)}</span>`; };
    const sim = A?.summary && B?.summary ? B.summary.avg_similarity_to_gold - A.summary.avg_similarity_to_gold : 0, om = A?.summary && B?.summary ? B.summary.avg_omission_rate - A.summary.avg_omission_rate : 0;
    const better = s.wins.B > s.wins.A && (s.B.accuracy >= s.A.accuracy - 0.25) && s.B.completeness >= s.A.completeness;
    $('#lj').innerHTML = `<div class="card" style="margin-bottom:14px"><b>Blind judge — A: ${esc(A?.label || d.a.slice(-8))} vs B: ${esc(B?.label || d.b.slice(-8))}</b> <span class="sub">(${s.n} notes, order randomised)</span>
      <div class="cards" style="margin:10px 0 0"><div class="card stat"><div class="l">WINS</div><div class="n" style="font-size:20px">A ${s.wins.A} · B ${s.wins.B} · tie ${s.wins.tie}</div></div>
      <div class="card stat"><div class="l">COMPLETENESS</div><div class="n" style="font-size:20px">${s.A.completeness} → ${s.B.completeness}</div><div class="s">${dl(s.A.completeness, s.B.completeness)}</div></div>
      <div class="card stat"><div class="l">ACCURACY</div><div class="n" style="font-size:20px">${s.A.accuracy} → ${s.B.accuracy}</div><div class="s">${dl(s.A.accuracy, s.B.accuracy)}</div></div>
      <div class="card stat"><div class="l">CONCISION</div><div class="n" style="font-size:20px">${s.A.concision} → ${s.B.concision}</div><div class="s">${dl(s.A.concision, s.B.concision)}</div></div>
      <div class="card stat"><div class="l">SIMILARITY / OMISSION</div><div class="n" style="font-size:20px">${dl(0, sim)} / ${dl(0, om, true)}</div><div class="s">B minus A vs gold</div></div></div>
      <p style="margin:10px 0 0"><b>${better ? 'B looks better' : 'No clear win for B'}</b> — ${better ? 'more wins, completeness not lower, accuracy within 0.25.' : 'it did not clearly beat A on wins, completeness and accuracy together. Do not promote on this evidence.'}</p></div>`;
  }

  // ───────────── improve tab ─────────────
  function drawImprove() {
    $('#ltab').innerHTML = `<div class="card" style="margin-bottom:16px"><b>How improving works</b><ol class="hint" style="margin:6px 0 0 18px;padding:0;line-height:1.7"><li>Run an evaluation on the “Run &amp; results” tab.</li><li>Open that run and press <b>Improve prompt from this run</b>. A stronger model reads the worst notes, finds repeated failure patterns and rewrites the prompt.</li><li>Review the candidate here, then test it on the same notes (A/B) and on fresh unseen notes, and compare blind.</li><li>Only if it clearly wins: <b>Promote to production</b> (reversible).</li></ol></div>
    ${cands.candidates.length ? table([{ h: 'Candidate', f: (c) => `<b>${esc(c.id.slice(-8))}</b><div class="sub">${ago(c.createdAt)}</div>` }, { h: 'From run', f: (c) => `<span class="mono">${esc(c.basedOnRun.slice(-8))}</span>` }, { h: 'Length', num: 1, f: (c) => `${c.chars.toLocaleString()} <span class="sub">(was ${c.basePromptChars.toLocaleString()})</span>` }, { h: 'Patterns', num: 1, f: (c) => c.patterns.length }, { h: '', f: (c) => `<button class="btn sm" data-cand="${c.id}">Review &amp; test</button>` }], cands.candidates) : '<div class="card empty">No candidates yet. Open a finished run and press “Improve prompt from this run”.</div>'}`;
    document.querySelectorAll('[data-cand]').forEach((b) => { b.onclick = () => openCand(b.dataset.cand); });
  }

  // ───────────── production tab ─────────────
  function drawProd() {
    $('#ltab').innerHTML = `<div class="head" style="margin:0 0 8px"><h3>Production prompt versions</h3><div class="tools"><button class="btn sm" id="pdef">Use built-in default</button></div></div>
    <p class="hint" style="margin:0 0 10px">The active version is what every clinician's note uses (within ~1 minute of a change). Activate any earlier version to roll back.</p>
    ${prod.versions.length ? table([{ h: 'Version', f: (v) => `<b>v${v.version}</b> ${v.active ? '<span class="pill ok">active</span>' : ''}<div class="sub">${esc(v.note || '')}</div>` }, { h: 'By', f: (v) => esc(v.created_by || '') }, { h: 'When', f: (v) => fmtDate(v.created_at) }, { h: 'Length', num: 1, f: (v) => v.chars.toLocaleString() }, { h: '', f: (v) => v.active ? '' : `<button class="btn sm" data-act="${v.id}">Make active (rollback)</button>` }], prod.versions) : '<div class="card empty">Production is using the built-in prompt. Promote a validated candidate to create version 1.</div>'}`;
    document.querySelectorAll('[data-act]').forEach((b) => { b.onclick = async () => { if (!confirm('Make this prompt version the one production uses? Takes effect within a minute.')) return; try { await api(`/api/console/prompts/${b.dataset.act}/activate`, { method: 'POST' }); toast('Version activated'); draw(); } catch (e) { toast(e.message, true); } }; });
    $('#pdef').onclick = async () => { if (!confirm('Switch production back to the built-in prompt?')) return; try { await api('/api/console/prompts/reset-default', { method: 'POST' }); toast('Production uses the built-in prompt'); draw(); } catch (e) { toast(e.message, true); } };
  }

  // ───────────── drawers ─────────────
  async function openRun(id) {
    openDrawer('<div class="drawer-body"><div class="empty">Loading…</div></div>');
    const r = await lab('/runs/' + id); const rows = [...r.rows].map((x) => ({ ...x, bad: (x.omission_rate || 0) * 0.6 + (1 - (x.similarity_to_gold || 0)) * 0.4 })).sort((a, b) => b.bad - a.bad);
    openDrawer(`<div class="drawer-head"><div><h2>${esc(r.label || r.id.slice(-8))}</h2><div style="color:var(--ink-3)">${esc(r.status)} · ${r.config.n} notes · ${esc(r.config.writerModel || 'default writer')} · prompt ${esc(r.config.promptSource)} · ${(r.config.promptChars || 0).toLocaleString()} chars</div></div><div class="tools"><button class="btn primary sm" id="imp" ${r.status === 'running' ? 'disabled' : ''}>Improve prompt from this run</button><button class="btn sm" data-close>Close</button></div></div>
      <div class="drawer-body"><p style="color:var(--ink-3)">Worst first (high omission, low similarity). Click a note to compare it with the clinician's gold note.</p>
      ${table([{ h: 'Note', f: (x) => `<b>${esc(pretty(x.id))}</b>${x.error ? `<div class="sub" style="color:var(--bad)">${esc(x.error)}</div>` : ''}` }, { h: 'Sim', num: 1, f: (x) => f3(x.similarity_to_gold) }, { h: 'Omission', num: 1, f: (x) => f3(x.omission_rate) }, { h: 'Flow', num: 1, f: (x) => f3(x.story_flow) }, { h: 'Words', num: 1, f: (x) => x.note_words ?? '—' }, { h: 'Time', num: 1, f: (x) => (x.ms / 1000).toFixed(1) + 's' }], rows, (x) => `data-row="${esc(x.id)}"`)}</div>`);
    document.querySelectorAll('[data-row]').forEach((tr) => { tr.onclick = () => openRow(id, tr.dataset.row, rows.find((x) => x.id === tr.dataset.row)); });
    $('#imp').onclick = async () => { const b = $('#imp'); b.disabled = true; b.textContent = 'Analysing failures… (1–2 min)'; try { const c = await lab('/improve', { method: 'POST', json: { runId: id, k: 6 } }); toast('Candidate created'); P.tab = 'improve'; closeDrawer(); await draw(); openCand(c.id); } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'Improve prompt from this run'; } };
  }
  async function openRow(runId, fid, row) {
    const d = await lab(`/runs/${runId}/rows/${encodeURIComponent(fid)}`);
    const draw2 = (tab) => {
      const body = { note: `<div class="note">${mdToHtml(d.note || '(no note)')}</div>`, gold: `<pre class="raw">${esc(d.gold)}</pre>`, transcript: `<div style="white-space:pre-wrap;line-height:1.6">${esc(d.transcript)}</div>` }[tab];
      openDrawer(`<div class="drawer-head"><div><h2>${esc(pretty(fid))}</h2><div style="color:var(--ink-3)">similarity ${f3(row?.similarity_to_gold)} · omission ${f3(row?.omission_rate)}</div></div><div class="tools"><button class="btn sm" id="bk">Back to run</button><button class="btn sm" data-close>Close</button></div></div>
        ${row?.omission_missed?.length ? `<div style="padding:0 22px 8px;color:var(--ink-2)"><b>Gold terms the note missed:</b> ${esc(row.omission_missed.join(', '))}</div>` : ''}
        <div class="tabs">${[['note', 'Generated note'], ['gold', 'Gold note'], ['transcript', 'Transcript']].map(([k, l]) => `<button class="tab${tab === k ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div class="drawer-body" style="padding-top:14px">${body}</div>`);
      document.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => draw2(b.dataset.tab); }); $('#bk').onclick = () => openRun(runId);
    };
    draw2('note');
  }

  async function openCand(id) {
    openDrawer('<div class="drawer-body"><div class="empty">Loading…</div></div>');
    const c = await lab('/candidates/' + id); const asText = (x) => (typeof x === 'string' ? x : Object.values(x || {}).join(' — '));
    openDrawer(`<div class="drawer-head"><div><h2>Candidate ${esc(id.slice(-8))}</h2><div style="color:var(--ink-3)">${c.chars.toLocaleString()} chars (current ${c.basePromptChars.toLocaleString()}) · from run ${esc(c.basedOnRun.slice(-8))}</div></div><button class="btn sm" data-close>Close</button></div>
      <div class="drawer-body"><h3 style="margin:6px 0">Failure patterns found</h3><ul>${c.patterns.map((p) => `<li>${esc(asText(p))}</li>`).join('')}</ul>
      <h3 style="margin:14px 0 6px">What it changed</h3><ul>${c.changes.map((p) => `<li>${esc(asText(p))}</li>`).join('')}</ul>
      <div class="card" style="margin:16px 0"><b>Validate before promoting</b><p style="color:var(--ink-3);margin:4px 0 10px">A prompt tuned on a few failures can overfit. Test it on the same notes (A/B) and on fresh notes it has never seen, then compare blind on the Run tab.</p>
        <div class="tools"><button class="btn" id="vab">Test on the same notes</button><button class="btn" id="vfr">Test on 40 fresh notes (+ baseline)</button><button class="btn primary" id="vpr">Promote to production…</button></div></div>
      <details><summary style="cursor:pointer;color:var(--ink-3)">Full prompt text</summary><pre class="raw" style="margin-top:8px">${esc(c.text)}</pre></details></div>`);
    const baseRun = async () => lab('/runs/' + c.basedOnRun);
    $('#vab').onclick = async () => { try { const b = await baseRun(); await lab('/runs', { method: 'POST', json: { ids: b.ids || b.rows.map((r) => r.id), candidateId: id, writerModel: b.config.writerModel || P.model, label: 'A/B ' + id.slice(-6) } }); toast('Started. When done, tick it and its base run on the Run tab and press Compare.'); P.tab = 'run'; closeDrawer(); draw(); } catch (e) { toast(e.message, true); } };
    $('#vfr').onclick = async () => { try { const b = await baseRun(); const used = new Set((b.ids || b.rows.map((r) => r.id)).concat(c.usedFixtures || [])); const fresh = pickRandom(ids().length).filter((x) => !used.has(x)).slice(0, 40); const wm = b.config.writerModel || P.model; await lab('/runs', { method: 'POST', json: { ids: fresh, writerModel: wm, label: 'fresh baseline ' + id.slice(-6) } }); await lab('/runs', { method: 'POST', json: { ids: fresh, candidateId: id, writerModel: wm, label: 'fresh candidate ' + id.slice(-6) } }); toast('Started baseline + candidate on the same 40 unseen notes'); P.tab = 'run'; closeDrawer(); draw(); } catch (e) { toast(e.message, true); } };
    $('#vpr').onclick = async () => {
      if (!confirm('Promote this prompt to PRODUCTION?\n\nEvery new note will use it within about a minute. You can roll back from the Production prompt tab.\n\nOnly continue if the blind judge and the fresh-sample run both favoured it.')) return;
      try { const r = await api('/api/console/prompts/promote', { method: 'POST', json: { text: c.text, note: `from candidate ${id.slice(-6)} (run ${c.basedOnRun.slice(-6)})` } }); toast('Promoted as version ' + r.version); P.tab = 'prod'; closeDrawer(); draw(); } catch (e) { toast(e.message, true); }
    };
  }

  await draw();
}
export function labStop() { clearTimeout(T); T = null; }
