// Lab tab: evaluate → compare (blind judge) → improve (LLM proposes a better prompt) → validate A/B + fresh sample → promote.
// Talks to the lab service on the VM through the Worker (/lab/*, admin-session gated) and to the production console
// (/backend/api/console/prompts*) for promote / rollback. `ctx` carries the helpers from app.js.
let T = null;   // refresh timer

export async function labView(ctx) {
  const { $, esc, ago, fmtDate, table, head, toast, openDrawer, closeDrawer, api, mdToHtml } = ctx;
  const lab = async (path, opts = {}) => {
    const res = await fetch('/lab' + path, { credentials: 'same-origin', ...opts, headers: { ...(opts.json ? { 'Content-Type': 'application/json' } : {}) }, body: opts.json ? JSON.stringify(opts.json) : undefined });
    const txt = await res.text(); let d = null; try { d = txt ? JSON.parse(txt) : null; } catch { d = { error: txt.slice(0, 120) }; }
    if (!res.ok) throw new Error((d && d.error) || `HTTP ${res.status}`);
    return d;
  };
  const sel = []; let lastJudge = null; let busy = '';
  const f3 = (x) => (x == null ? '—' : Number(x).toFixed(3));
  const stat = (r, k) => (r.summary ? r.summary[k] : null);

  $('#view').innerHTML = head('Lab', 'Evaluate on gold notes, compare blind, let a stronger model propose a better prompt, validate it, then promote', '<button class="btn" id="lrf">Refresh</button>') + '<div id="lab-root" class="card empty">Loading…</div>';
  $('#lrf').onclick = () => draw();

  async function draw() {
    if (!$('#lab-root')) return;
    let info, base, runs, cands, prod;
    try { [info, base, runs, cands, prod] = await Promise.all([lab('/info'), lab('/baseline'), lab('/runs'), lab('/candidates'), api('/api/console/prompts')]); }
    catch (e) { $('#lab-root').innerHTML = `<div class="err">The lab is not reachable: ${esc(e.message)}</div>`; return; }
    const R = runs.runs; const running = R.some((r) => r.status === 'running') || busy;
    const opts = (arr) => arr.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    $('#lab-root').className = '';
    $('#lab-root').innerHTML = `
    <div class="cards">
      <div class="card stat"><div class="l">GOLD NOTES</div><div class="n">${info.usable.toLocaleString()}</div><div class="s">usable of ${info.fixtures.toLocaleString()} (transcript → expert note)</div></div>
      <div class="card stat"><div class="l">WRITER MODEL</div><div class="n" style="font-size:18px;margin-top:8px">${esc(info.writerModel)}</div><div class="s">judge/improver ${esc(info.models.judge)}</div></div>
      <div class="card stat"><div class="l">PRODUCTION PROMPT</div><div class="n" style="font-size:18px;margin-top:8px">${prod.using_default ? 'code default' : 'promoted v' + (prod.versions.find((v) => v.active)?.version ?? '?')}</div><div class="s">${base.chars.toLocaleString()} chars · ${prod.versions.length} saved versions</div></div>
    </div>
    <div class="card" style="margin-bottom:18px"><h3 style="margin-bottom:10px">New evaluation</h3>
      <div class="tools"><label>Notes <select class="select" id="ln">${opts([[10, '10'], [20, '20'], [40, '40'], [80, '80']])}</select></label>
        <label>Prompt <select class="select" id="lp">${opts([['active', 'Production (active)'], ['default', 'Code default'], ...cands.candidates.map((c) => [c.id, 'Candidate ' + c.id.slice(-6)])])}</select></label>
        <label>Writer model <select class="select" id="lm">${opts([['', 'Default'], ['gemini-2.5-flash', 'gemini-2.5-flash'], ['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite'], ['gemini-2.5-pro', 'gemini-2.5-pro']])}</select></label>
        <label>Temp <input class="input" id="lt" type="number" step="0.1" min="0" max="1" placeholder="0.3" style="width:70px"></label>
        <label>topP <input class="input" id="ltp" type="number" step="0.05" min="0.1" max="1" placeholder="0.9" style="width:70px"></label>
        <label>Seed <input class="input" id="ls" type="number" value="${Math.floor(Math.random() * 9000) + 1}" style="width:80px"></label>
        <input class="input" id="ll" placeholder="Label (optional)" style="width:160px"><button class="btn primary" id="lgo">Start run</button></div>
      <p style="color:var(--ink-3);margin:8px 0 0">Same seed + same count = the same notes, so two runs are directly comparable. A run of 20 takes about 2 minutes.</p></div>
    <div class="head" style="margin:0 0 8px"><h3>Runs</h3><div class="tools"><span style="color:var(--ink-3)">${sel.length}/2 selected</span><button class="btn sm primary" id="jg" ${sel.length === 2 ? '' : 'disabled'}>Judge blind: ${sel.length === 2 ? 'A vs B' : 'select two'}</button></div></div>
    <div id="lj"></div>
    <div id="lruns">${table([
      { h: '', f: (r) => `<input type="checkbox" data-sel="${r.id}" ${sel.includes(r.id) ? 'checked' : ''} ${r.status === 'running' ? 'disabled' : ''}>` },
      { h: 'Run', f: (r) => `<b>${esc(r.label || r.id.slice(-8))}</b><div class="sub">${ago(r.createdAt)} · ${esc(r.id.slice(-8))}</div>` },
      { h: 'Status', f: (r) => r.status === 'running' ? `<span class="pill acc">running ${r.progress.done}/${r.progress.total}</span>` : `<span class="pill ${r.status === 'done' ? 'ok' : r.status === 'error' || r.status === 'interrupted' ? 'bad' : ''}">${esc(r.status)}</span>` },
      { h: 'Prompt', f: (r) => `<span class="sub">${esc(r.config.promptSource)}${r.config.writerModel ? ' · ' + esc(r.config.writerModel) : ''}${r.config.writerTemp != null ? ' · T' + r.config.writerTemp : ''}</span>` },
      { h: 'N', num: 1, f: (r) => r.config.n }, { h: 'Similarity', num: 1, f: (r) => f3(stat(r, 'avg_similarity_to_gold')) }, { h: 'Omission', num: 1, f: (r) => f3(stat(r, 'avg_omission_rate')) },
      { h: 'Flow', num: 1, f: (r) => f3(stat(r, 'avg_story_flow')) }, { h: 'p50', num: 1, f: (r) => (stat(r, 'p50_s') != null ? stat(r, 'p50_s') + 's' : '—') }, { h: 'Fail', num: 1, f: (r) => stat(r, 'failed') ?? '—' },
      { h: '', f: (r) => `<button class="btn sm" data-open="${r.id}">Open</button>` },
    ], R)}</div>
    <div class="head" style="margin:22px 0 8px"><h3>Prompt candidates</h3><span style="color:var(--ink-3)">Created by “Improve” from a run’s worst failures</span></div>
    ${cands.candidates.length ? table([{ h: 'Candidate', f: (c) => `<b>${esc(c.id.slice(-8))}</b><div class="sub">${ago(c.createdAt)}</div>` }, { h: 'From run', f: (c) => `<span class="mono">${esc(c.basedOnRun.slice(-8))}</span>` }, { h: 'Length', num: 1, f: (c) => `${c.chars.toLocaleString()} <span class="sub">(was ${c.basePromptChars.toLocaleString()})</span>` }, { h: 'Patterns found', num: 1, f: (c) => c.patterns.length }, { h: '', f: (c) => `<button class="btn sm" data-cand="${c.id}">Review</button>` }], cands.candidates) : '<div class="card empty">No candidates yet. Open a run and press “Improve prompt”.</div>'}
    <div class="head" style="margin:22px 0 8px"><h3>Production prompt versions</h3><div class="tools"><button class="btn sm" id="pdef">Use code default</button></div></div>
    ${prod.versions.length ? table([{ h: 'Version', f: (v) => `<b>v${v.version}</b> ${v.active ? '<span class="pill ok">active</span>' : ''}<div class="sub">${esc(v.note || '')}</div>` }, { h: 'By', f: (v) => esc(v.created_by || '') }, { h: 'When', f: (v) => fmtDate(v.created_at) }, { h: 'Length', num: 1, f: (v) => v.chars.toLocaleString() }, { h: '', f: (v) => v.active ? '' : `<button class="btn sm" data-act="${v.id}">Make active (rollback)</button>` }], prod.versions) : '<div class="card empty">Production is using the built-in prompt. Promote a validated candidate to create version 1.</div>'}`;

    $('#lgo').onclick = async () => {
      const p = $('#lp').value; const body = { n: Number($('#ln').value), seed: Number($('#ls').value) || 1, label: $('#ll').value.trim(), writerModel: $('#lm').value || undefined };
      if ($('#lt').value !== '') body.writerTemp = Number($('#lt').value); if ($('#ltp').value !== '') body.writerTopP = Number($('#ltp').value);
      if (p === 'default') body.prompt = 'default'; else if (p !== 'active') body.candidateId = p;
      try { await lab('/runs', { method: 'POST', json: body }); toast('Run started'); draw(); } catch (e) { toast(e.message, true); }
    };
    document.querySelectorAll('[data-sel]').forEach((c) => { c.onchange = () => { const id = c.dataset.sel; const i = sel.indexOf(id); if (i >= 0) sel.splice(i, 1); else { if (sel.length >= 2) sel.shift(); sel.push(id); } draw(); }; });
    document.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openRun(b.dataset.open); });
    document.querySelectorAll('[data-cand]').forEach((b) => { b.onclick = () => openCand(b.dataset.cand); });
    document.querySelectorAll('[data-act]').forEach((b) => { b.onclick = async () => { if (!confirm('Make this prompt version the one production uses? Takes effect within a minute.')) return; try { await api(`/api/console/prompts/${b.dataset.act}/activate`, { method: 'POST' }); toast('Version activated'); draw(); } catch (e) { toast(e.message, true); } }; });
    const pd = $('#pdef'); if (pd) pd.onclick = async () => { if (!confirm('Switch production back to the built-in prompt?')) return; try { await api('/api/console/prompts/reset-default', { method: 'POST' }); toast('Production uses the code default'); draw(); } catch (e) { toast(e.message, true); } };
    const jg = $('#jg'); if (jg) jg.onclick = () => judge(sel[0], sel[1], R);
    if (lastJudge) renderJudge(lastJudge, R);
    clearTimeout(T); if (running) T = setTimeout(() => { if ($('#lab-root') && !document.querySelector('#drawer')) draw(); else if ($('#lab-root')) T = setTimeout(draw, 6000); }, 5000);
  }

  async function judge(a, b, R) {
    const j = $('#jg'); j.disabled = true; j.textContent = 'Judging…';
    try {
      const { id } = await lab('/judge', { method: 'POST', json: { a, b, limit: 30 } });
      for (let i = 0; i < 120; i++) { await new Promise((r) => setTimeout(r, 4000)); const d = await lab('/judge/' + id); if (j) j.textContent = `Judging ${d.progress.done}/${d.progress.total}…`; if (d.status === 'done') { lastJudge = d; break; } if (d.status === 'error') throw new Error(d.error); }
      draw();
    } catch (e) { toast(e.message, true); draw(); }
  }
  function renderJudge(d, R) {
    const A = R.find((r) => r.id === d.a), B = R.find((r) => r.id === d.b); if (!d.summary) return;
    const s = d.summary; const dl = (x, y, inv) => { const v = y - x; return `<span class="pill ${(inv ? v < 0 : v > 0) ? 'ok' : v === 0 ? '' : 'bad'}">${v > 0 ? '+' : ''}${v.toFixed(2)}</span>`; };
    const sim = A && B ? B.summary.avg_similarity_to_gold - A.summary.avg_similarity_to_gold : 0, om = A && B ? B.summary.avg_omission_rate - A.summary.avg_omission_rate : 0;
    const better = s.wins.B > s.wins.A && (s.B.accuracy >= s.A.accuracy - 0.25) && s.B.completeness >= s.A.completeness;
    $('#lj').innerHTML = `<div class="card" style="margin-bottom:14px"><b>Blind judge — A: ${esc(A?.label || d.a.slice(-8))} vs B: ${esc(B?.label || d.b.slice(-8))}</b> <span class="sub">(${s.n} notes, order randomised)</span>
      <div class="cards" style="margin:10px 0 0"><div class="card stat"><div class="l">WINS</div><div class="n" style="font-size:20px">A ${s.wins.A} · B ${s.wins.B} · tie ${s.wins.tie}</div></div>
      <div class="card stat"><div class="l">COMPLETENESS</div><div class="n" style="font-size:20px">${s.A.completeness} → ${s.B.completeness}</div><div class="s">${dl(s.A.completeness, s.B.completeness)}</div></div>
      <div class="card stat"><div class="l">ACCURACY</div><div class="n" style="font-size:20px">${s.A.accuracy} → ${s.B.accuracy}</div><div class="s">${dl(s.A.accuracy, s.B.accuracy)}</div></div>
      <div class="card stat"><div class="l">CONCISION</div><div class="n" style="font-size:20px">${s.A.concision} → ${s.B.concision}</div><div class="s">${dl(s.A.concision, s.B.concision)}</div></div>
      <div class="card stat"><div class="l">SIMILARITY / OMISSION</div><div class="n" style="font-size:20px">${dl(0, sim)} / ${dl(0, om, true)}</div><div class="s">B minus A vs gold</div></div></div>
      <p style="margin:10px 0 0"><b>${better ? 'B looks better' : 'No clear win for B'}</b> — ${better ? 'more wins, completeness not lower, accuracy within 0.25.' : 'it did not clearly beat A on wins, completeness and accuracy together. Do not promote on this evidence.'}</p></div>`;
  }

  async function openRun(id) {
    openDrawer('<div class="drawer-body"><div class="empty">Loading…</div></div>');
    const r = await lab('/runs/' + id); const rows = [...r.rows].map((x) => ({ ...x, bad: (x.omission_rate || 0) * 0.6 + (1 - (x.similarity_to_gold || 0)) * 0.4 })).sort((a, b) => b.bad - a.bad);
    openDrawer(`<div class="drawer-head"><div><h2>${esc(r.label || r.id.slice(-8))}</h2><div style="color:var(--ink-3)">${esc(r.status)} · ${r.config.n} notes · prompt ${esc(r.config.promptSource)} · ${(r.config.promptChars || 0).toLocaleString()} chars</div></div><div class="tools"><button class="btn primary sm" id="imp" ${r.status === 'running' ? 'disabled' : ''}>Improve prompt from this run</button><button class="btn sm" data-close>Close</button></div></div>
      <div class="drawer-body"><p style="color:var(--ink-3)">Sorted worst first (high omission, low similarity). Click a note to compare it with the clinician's gold note.</p>
      ${table([{ h: 'Note', f: (x) => `<span class="mono">${esc(x.id)}</span>${x.error ? `<div class="sub" style="color:var(--bad)">${esc(x.error)}</div>` : ''}` }, { h: 'Sim', num: 1, f: (x) => f3(x.similarity_to_gold) }, { h: 'Omission', num: 1, f: (x) => f3(x.omission_rate) }, { h: 'Flow', num: 1, f: (x) => f3(x.story_flow) }, { h: 'Words', num: 1, f: (x) => x.note_words ?? '—' }, { h: 'Time', num: 1, f: (x) => (x.ms / 1000).toFixed(1) + 's' }], rows, (x) => `data-row="${x.id}"`)}</div>`);
    document.querySelectorAll('[data-row]').forEach((tr) => { tr.onclick = () => openRow(id, tr.dataset.row, rows.find((x) => x.id === tr.dataset.row)); });
    $('#imp').onclick = async () => { const b = $('#imp'); b.disabled = true; b.textContent = 'Analysing failures… (1–2 min)'; busy = 'improve'; try { const c = await lab('/improve', { method: 'POST', json: { runId: id, k: 6 } }); busy = ''; toast('Candidate created'); closeDrawer(); await draw(); openCand(c.id); } catch (e) { busy = ''; toast(e.message, true); b.disabled = false; b.textContent = 'Improve prompt from this run'; } };
  }
  async function openRow(runId, fid, row) {
    const d = await lab(`/runs/${runId}/rows/${encodeURIComponent(fid)}`);
    const draw2 = (tab) => {
      const body = { note: `<div class="note">${mdToHtml(d.note || '(no note)')}</div>`, gold: `<pre class="raw">${esc(d.gold)}</pre>`, transcript: `<div style="white-space:pre-wrap;line-height:1.6">${esc(d.transcript)}</div>` }[tab];
      openDrawer(`<div class="drawer-head"><div><h2 class="mono">${esc(fid)}</h2><div style="color:var(--ink-3)">similarity ${f3(row?.similarity_to_gold)} · omission ${f3(row?.omission_rate)}</div></div><div class="tools"><button class="btn sm" id="bk">Back to run</button><button class="btn sm" data-close>Close</button></div></div>
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
      <div class="card" style="margin:16px 0"><b>Validate before promoting</b><p style="color:var(--ink-3);margin:4px 0 10px">A prompt tuned on a few failures can overfit. Test it on the same notes (A/B) and on a fresh sample it has never seen, then judge both.</p>
        <div class="tools"><button class="btn" id="vab">Test on the same notes</button><button class="btn" id="vfr">Test on 40 fresh notes (+ baseline)</button><button class="btn primary" id="vpr">Promote to production…</button></div></div>
      <details><summary style="cursor:pointer;color:var(--ink-3)">Full prompt text</summary><pre class="raw" style="margin-top:8px">${esc(c.text)}</pre></details></div>`);
    $('#vab').onclick = async () => { try { const base = await lab('/runs/' + c.basedOnRun); await lab('/runs', { method: 'POST', json: { ids: base.rows.map((r) => r.id), candidateId: id, label: 'A/B ' + id.slice(-6) } }); toast('Started: same notes with the candidate. Then select it and its base run and press Judge.'); closeDrawer(); draw(); } catch (e) { toast(e.message, true); } };
    $('#vfr').onclick = async () => { try { const base = await lab('/runs/' + c.basedOnRun); const seed = Math.floor(Math.random() * 9000) + 100; const ex = base.rows.map((r) => r.id).concat(c.usedFixtures || []); await lab('/runs', { method: 'POST', json: { n: 40, seed, exclude: ex, label: 'fresh baseline ' + seed } }); await lab('/runs', { method: 'POST', json: { n: 40, seed, exclude: ex, candidateId: id, label: 'fresh candidate ' + seed } }); toast('Started baseline + candidate on the same 40 unseen notes'); closeDrawer(); draw(); } catch (e) { toast(e.message, true); } };
    $('#vpr').onclick = async () => {
      if (!confirm('Promote this prompt to PRODUCTION?\n\nEvery new note will use it within about a minute. You can roll back to any earlier version from this page.\n\nOnly continue if the blind judge and the fresh-sample run both favoured it.')) return;
      try { const r = await api('/api/console/prompts/promote', { method: 'POST', json: { text: c.text, note: `from candidate ${id.slice(-6)} (run ${c.basedOnRun.slice(-6)})` } }); toast('Promoted as version ' + r.version); closeDrawer(); draw(); } catch (e) { toast(e.message, true); }
    };
  }

  await draw();
}
export function labStop() { clearTimeout(T); T = null; }
