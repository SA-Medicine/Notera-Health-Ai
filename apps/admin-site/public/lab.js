// Evaluate: run the note writer on expert-written gold notes and inspect every result.
// Choose notes (random / pick & search / range / latest) → choose writer + prompt → start → watch progress → open any
// note to read the generated note beside the clinician's gold note and the transcript.
import { lab, pretty, f3, MODELS, opts, cur } from './kit.js';

let T = null;                       // auto-refresh timer
const P = { input: 'gold', own: '', ownGold: '', mode: 'random', n: 20, from: 1, to: 20, last: 20, picked: new Set(), q: '', model: 'gemini-3.5-flash-lite', prompt: 'active', temp: '', topP: '', label: '' };
let FX = null;                      // [[id, transcriptChars, goldChars], …] loaded once

export async function labView(ctx) {
  const { $, esc, ago, table, head, toast, openDrawer, closeDrawer, mdToHtml, go } = ctx;
  let info = null, cands = { candidates: [] }, runsCache = [];
  const stat = (r, k) => (r.summary ? r.summary[k] : null);
  const models = () => (MODELS.some(([v]) => v === P.model) ? MODELS : [...MODELS, [P.model, P.model]]);

  $('#view').innerHTML = head('Run & inputs', 'Step 1 — choose what to test (gold notes, your own transcript or audio), pick the model and prompt, and run it', '<button class="btn" id="lrf">Refresh</button>') + '<div id="lab-root" class="card empty">Loading…</div>';
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
    const upd = () => { const g = $('#lgo'); const k = willRun(); if (g) { g.disabled = k < 1 || k > 400; g.textContent = k > 400 ? 'Over 400 — choose fewer' : `Start run · ${k} note${k === 1 ? '' : 's'}`; } const c = $('#lcnt'); if (c) c.textContent = `${k} note${k === 1 ? '' : 's'} selected`; };
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
    $('#lgo').disabled = true;
    try { await lab('/runs', { method: 'POST', json: body }); toast(`Run started · ${a.length} notes`); } catch (e) { toast(e.message, true); }
    refreshRuns();
  }

  // ───────────── main draw ─────────────
  async function draw() {
    if (!$('#lab-root')) return;
    clearTimeout(T);
    try { [info, cands] = await Promise.all([lab('/info'), lab('/candidates')]); if (!FX) FX = (await lab('/fixtures')).fixtures; }
    catch (e) { $('#lab-root').className = 'card'; $('#lab-root').innerHTML = `<div class="err">The lab is not reachable: ${esc(e.message)}</div>`; return; }
    $('#lab-root').className = '';
    $('#lab-root').innerHTML = `
    <section class="card" style="margin-bottom:18px"><h3 style="margin:0 0 10px">What do you want to test? <span class="hint">${info.usable.toLocaleString()} gold notes available · production writer is ${esc(info.writerModel)}</span></h3>
      <div class="segs" id="inp" role="group" aria-label="Input type"><button type="button" class="seg" data-inp="gold">Gold notes <span class="hint">test many, scored</span></button><button type="button" class="seg" data-inp="own">Paste a transcript <span class="hint">test one</span></button><button type="button" class="seg" data-inp="audio">Upload audio <span class="hint">full pipeline</span></button></div>
      <div id="goldpane">
      <div class="fstep"><div class="stephead"><b>1 · Choose notes</b><span id="lcnt" class="pill acc"></span></div><div id="lsel"></div></div>
      <div class="fstep"><div class="stephead"><b>2 · Writer &amp; prompt</b></div>
        <div class="grid2">
          <label class="lbl">Writer model<select class="select" id="lm">${opts(models(), P.model)}</select></label>
          <label class="lbl">Prompt<select class="select" id="lp">${opts([['active', 'Production (active)'], ['default', 'Built-in default'], ...cands.candidates.map((c) => [c.id, 'Candidate ' + c.id.slice(-6) + ' · ' + ago(c.createdAt)])], P.prompt)}</select></label>
          <label class="lbl">Run name <span class="hint">(optional)</span><input class="input" id="ll" placeholder="e.g. Lite vs Flash" value="${esc(P.label)}"></label>
        </div>
        <details style="margin-top:8px"><summary class="hint" style="cursor:pointer">Advanced: temperature / topP</summary><div class="grid2" style="margin-top:8px"><label class="lbl">Temperature<input class="input" id="lt" type="number" step="0.1" min="0" max="1" placeholder="0.3" value="${esc(P.temp)}"></label><label class="lbl">topP<input class="input" id="ltp" type="number" step="0.05" min="0.1" max="1" placeholder="0.9" value="${esc(P.topP)}"></label></div></details></div>
      <div class="fstep"><div class="stephead"><b>3 · Start</b></div><div class="tools"><button class="btn primary" id="lgo">Start run</button><span class="hint">About 6 s per note, 3 at a time — 20 notes ≈ 1–2 min. Runs on the Google VM.</span></div></div>
      </div>
      <div id="ownpane" style="display:none"></div><div id="audiopane" style="display:none"><div class="card empty">Audio goes through the real pipeline (speech-to-text, then the note) in <a class="lnk" id="toaudio">Test bench</a>. Pick a file there; it is recorded in the Notes list marked [TEST].</div></div>
    </section>
    <div class="head" style="margin:0 0 8px"><h3>Runs <span class="hint">press “Review notes” on a finished run to read every note beside its gold note</span></h3><div class="tools"><button class="btn sm" id="tocmp">Compare runs →</button><button class="btn sm" id="totr">Trends →</button></div></div>
    <div id="lruns"></div>
    <p class="hint">Similarity ↑ better · Omission ↓ better (gold-note facts missing) · Flow ↑ better. To judge which version really wins, use <b>Compare</b>.</p>`;
    drawSelector(); showInput();
    $('#lm').onchange = (e) => { P.model = e.target.value; }; $('#lp').onchange = (e) => { P.prompt = e.target.value; };
    $('#ll').oninput = (e) => { P.label = e.target.value; }; $('#lt').oninput = (e) => { P.temp = e.target.value; }; $('#ltp').oninput = (e) => { P.topP = e.target.value; };
    $('#lgo').onclick = startRun; $('#tocmp').onclick = () => go('compare'); $('#totr').onclick = () => go('trends');
    document.querySelectorAll('[data-inp]').forEach((b) => { b.onclick = () => { P.input = b.dataset.inp; showInput(); }; });
    const ta = $('#toaudio'); if (ta) ta.onclick = () => go('bench');
    await refreshRuns();
  }
  function showInput() {
    document.querySelectorAll('[data-inp]').forEach((b) => b.classList.toggle('on', b.dataset.inp === P.input));
    $('#goldpane').style.display = P.input === 'gold' ? '' : 'none'; $('#audiopane').style.display = P.input === 'audio' ? '' : 'none'; $('#ownpane').style.display = P.input === 'own' ? '' : 'none';
    if (P.input === 'own') drawOwn();
  }
  function drawOwn() {
    const box = $('#ownpane'); if (box.dataset.ready) return; box.dataset.ready = '1';
    box.innerHTML = `<div class="two"><label class="lbl">Transcript <span class="hint">(required — paste the consultation text)</span><textarea class="editor" id="ot" style="min-height:240px;height:240px" placeholder="Doctor: What brings you in today? …">${esc(P.own)}</textarea></label>
      <label class="lbl">Gold note <span class="hint">(optional — adds scores and a side-by-side)</span><textarea class="editor" id="og" style="min-height:240px;height:240px" placeholder="Subjective: …">${esc(P.ownGold)}</textarea></label></div>
      <div class="tools" style="margin-top:8px"><button class="btn primary" id="ogo">Run on this transcript</button><span class="hint">Uses the writer model and prompt chosen below. About 10 s. Not saved as a run.</span></div><div id="ores" style="margin-top:14px"></div>`;
    $('#ot').oninput = (e) => { P.own = e.target.value; }; $('#og').oninput = (e) => { P.ownGold = e.target.value; };
    $('#ogo').onclick = async () => {
      const b = $('#ogo'); b.disabled = true; b.textContent = 'Running…'; const body = { transcript: P.own, gold: P.ownGold, writerModel: P.model };
      if (P.prompt === 'default') body.prompt = 'default'; else if (P.prompt !== 'active') body.candidateId = P.prompt;
      try {
        const r = await lab('/try', { method: 'POST', json: body }); const m = r.metrics;
        $('#ores').innerHTML = `<div class="tools"><span class="pill ok">done in ${(r.ms / 1000).toFixed(1)}s</span><span class="hint">prompt: ${esc(r.promptSource)}</span>${m ? `<span class="pill">similarity ${f3(m.similarity_to_gold)}</span><span class="pill">omission ${f3(m.omission_rate)}</span><span class="pill">flow ${f3(m.story_flow)}</span>` : ''}</div>
          ${m?.omission_missed?.length ? `<div class="chips"><span class="hint">Gold terms missed:</span>${m.omission_missed.slice(0, 14).map((t) => `<span class="chip bad">${esc(t)}</span>`).join('')}</div>` : ''}
          <div class="cols2" style="margin-top:10px"><div class="card"><div class="colhead"><i class="dot ok"></i>Generated note</div><div class="note">${mdToHtml(r.note)}</div></div>
            <div class="card"><div class="colhead"><i class="dot gold"></i>${P.ownGold.trim() ? 'Gold note' : 'Pipeline log'}</div><pre class="raw goldraw">${esc(P.ownGold.trim() ? P.ownGold : r.log.filter((l) => !/Timing\]/.test(l)).join(String.fromCharCode(10)))}</pre></div></div>
          ${P.ownGold.trim() ? `<details style="margin-top:8px"><summary class="hint" style="cursor:pointer">Pipeline log (${r.log.length} lines)</summary><pre class="raw" style="max-height:300px;overflow:auto">${esc(r.log.join(String.fromCharCode(10)))}</pre></details>` : ''}`;
      } catch (e) { toast(e.message, true); }
      b.disabled = false; b.textContent = 'Run on this transcript';
    };
  }

  async function refreshRuns() {
    if (!$('#lruns')) return;
    clearTimeout(T);
    try { runsCache = (await lab('/runs')).runs; } catch { /* transient */ }
    const runs = runsCache; const host = $('#lruns');
    host.innerHTML = table([
      { h: 'Run', f: (r) => `<b>${esc(r.label || r.id.slice(-8))}</b><div class="sub">${ago(r.createdAt)} · ${esc(r.id.slice(-8))}</div>` },
      { h: 'Status', f: (r) => r.status === 'running' ? `<span class="pill acc">running ${r.progress.done}/${r.progress.total}</span>` : `<span class="pill ${r.status === 'done' ? 'ok' : ['error', 'interrupted', 'cancelled'].includes(r.status) ? 'bad' : ''}">${esc(r.status)}</span>` },
      { h: 'Writer / prompt', f: (r) => `<span class="sub">${esc(r.config.writerModel || 'default')} · ${esc(String(r.config.promptSource).replace('candidate:', 'cand '))}${r.config.writerTemp != null ? ' · T' + r.config.writerTemp : ''}</span>` },
      { h: 'N', num: 1, f: (r) => r.config.n }, { h: 'Similarity', num: 1, f: (r) => f3(stat(r, 'avg_similarity_to_gold')) }, { h: 'Omission', num: 1, f: (r) => f3(stat(r, 'avg_omission_rate')) },
      { h: 'Flow', num: 1, f: (r) => f3(stat(r, 'avg_story_flow')) }, { h: 'p50', num: 1, f: (r) => (stat(r, 'p50_s') != null ? stat(r, 'p50_s') + 's' : '—') }, { h: 'Fail', num: 1, f: (r) => stat(r, 'failed') ?? '—' },
      { h: '', f: (r) => `<div class="tools">${r.status === 'running' ? `<button class="btn sm" data-stop="${r.id}">Stop</button>` : `<button class="btn sm" data-rerun="${r.id}" title="Run the same notes again">Re-run</button>`}<button class="btn sm primary" data-open="${r.id}">Review notes</button></div>` },
    ], runs);
    host.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => { cur.run = b.dataset.open; go('results'); }; });
    host.querySelectorAll('[data-stop]').forEach((b) => { b.onclick = async () => { await lab(`/runs/${b.dataset.stop}/cancel`, { method: 'POST' }); toast('Stopping…'); refreshRuns(); }; });
    host.querySelectorAll('[data-rerun]').forEach((b) => { b.onclick = async () => { try { const r = await lab('/runs/' + b.dataset.rerun); const old = runs.find((x) => x.id === b.dataset.rerun); await lab('/runs', { method: 'POST', json: { ids: r.ids || r.rows.map((x) => x.id), writerModel: old?.config.writerModel || P.model, label: 'Re-run ' + (old?.label || b.dataset.rerun.slice(-6)) } }); toast('Re-run started'); refreshRuns(); } catch (e) { toast(e.message, true); } }; });
    if (runs.some((r) => r.status === 'running')) T = setTimeout(refreshRuns, 5000);
    else { const g = $('#lgo'); if (g) g.disabled = willRun() < 1 || willRun() > 400; }
  }

  async function openRun(id) {
    openDrawer('<div class="drawer-body"><div class="empty">Loading…</div></div>');
    const r = await lab('/runs/' + id); const rows = [...r.rows].map((x) => ({ ...x, bad: (x.omission_rate || 0) * 0.6 + (1 - (x.similarity_to_gold || 0)) * 0.4 })).sort((a, b) => b.bad - a.bad);
    openDrawer(`<div class="drawer-head"><div><h2>${esc(r.label || r.id.slice(-8))}</h2><div style="color:var(--ink-3)">${esc(r.status)} · ${r.config.n} notes · ${esc(r.config.writerModel || 'default writer')} · prompt ${esc(r.config.promptSource)} · ${(r.config.promptChars || 0).toLocaleString()} chars</div></div><div class="tools"><a class="btn sm" href="/lab/runs/${r.id}/export.csv" download>CSV</a><button class="btn primary sm" id="imp" ${r.status !== 'done' ? 'disabled' : ''}>Improve prompt from this run →</button><button class="btn sm" data-close>Close</button></div></div>
      <div class="drawer-body"><p style="color:var(--ink-3)">Worst first (high omission, low similarity). Click a note to compare it with the clinician's gold note.</p>
      ${table([{ h: 'Note', f: (x) => `<b>${esc(pretty(x.id))}</b>${x.error ? `<div class="sub" style="color:var(--bad)">${esc(x.error)}</div>` : ''}` }, { h: 'Sim', num: 1, f: (x) => f3(x.similarity_to_gold) }, { h: 'Omission', num: 1, f: (x) => f3(x.omission_rate) }, { h: 'Flow', num: 1, f: (x) => f3(x.story_flow) }, { h: 'Words', num: 1, f: (x) => x.note_words ?? '—' }, { h: 'Time', num: 1, f: (x) => (x.ms / 1000).toFixed(1) + 's' }], rows, (x) => `data-row="${esc(x.id)}"`)}</div>`);
    document.querySelectorAll('[data-row]').forEach((tr) => { tr.onclick = () => openRow(id, tr.dataset.row, rows.find((x) => x.id === tr.dataset.row)); });
    $('#imp').onclick = () => { closeDrawer(); go('optimize'); };
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

  await draw();
}
export function labStop() { clearTimeout(T); T = null; }
