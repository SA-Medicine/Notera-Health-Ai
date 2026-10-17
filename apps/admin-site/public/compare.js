// Compare: two runs on the same notes — paired statistics (mean change, notes improved/regressed, sign-test p),
// per-note winners and losers, and an order-swapped blind judge with hallucination/omission counts and human calibration.
import { lab, pretty, f3, sgn, barChart, kpi } from './kit.js';

const ST = { a: '', b: '', judge: null };
export async function compareView(ctx, mode = 'stats') {
  const { $, esc, ago, table, head, toast, openDrawer, mdToHtml } = ctx;
  $('#view').innerHTML = head(mode === 'stats' ? 'Compare runs' : 'Blind judge', mode === 'stats' ? 'Does version B really beat version A? Paired on the same notes: metric changes, statistics and every note that got better or worse.' : 'A strong model reads both notes without knowing which version wrote them (in both orders), then counts what each lacks and invents.', '<button class="btn" id="crf">Refresh</button>') + '<div id="cmp" class="card empty">Loading…</div>';
  $('#crf').onclick = () => draw();
  let runs = [], pinned = null;
  const label = (r) => `${r.label || r.id.slice(-8)} · ${r.config.writerModel || 'default'} · ${String(r.config.promptSource).replace('candidate:', 'cand ')} · ${r.config.n} notes · ${ago(r.createdAt)}`;

  async function draw() {
    runs = (await lab('/runs')).runs.filter((r) => r.status === 'done' && r.summary);
    pinned = (await lab('/baseline-run')).baseline;
    if (runs.length < 2) { $('#cmp').className = 'card empty'; $('#cmp').innerHTML = 'You need at least two finished runs on the same notes. Start them in Run & inputs (use Re-run to repeat the same notes with another model or prompt).'; return; }
    if (!ST.a || !runs.some((r) => r.id === ST.a)) ST.a = pinned?.id && runs.some((r) => r.id === pinned.id) ? pinned.id : runs[1].id;
    if (!ST.b || !runs.some((r) => r.id === ST.b)) ST.b = runs.find((r) => r.id !== ST.a).id;
    const opt = (cur) => runs.map((r) => `<option value="${r.id}"${r.id === cur ? ' selected' : ''}>${esc(label(r))}</option>`).join('');
    $('#cmp').className = ''; $('#cmp').innerHTML = `
      <div class="card cmpbar"><label class="lbl">A — baseline${pinned?.id === ST.a ? ' <span class="pill ok">pinned</span>' : ''}<select class="select" id="ca">${opt(ST.a)}</select></label>
        <label class="lbl">B — challenger<select class="select" id="cb">${opt(ST.b)}</select></label>
        <div class="tools"><button class="btn sm" id="swap">Swap</button><button class="btn sm" id="pin" title="Use A as the reference every comparison starts from">Pin A as baseline</button></div></div>
      <div id="cstats"></div><div id="cjudge"></div>`;
    $('#ca').onchange = (e) => { ST.a = e.target.value; ST.judge = null; draw(); }; $('#cb').onchange = (e) => { ST.b = e.target.value; ST.judge = null; draw(); };
    $('#swap').onclick = () => { [ST.a, ST.b] = [ST.b, ST.a]; ST.judge = null; draw(); };
    $('#pin').onclick = async () => { try { await lab('/baseline-run', { method: 'PUT', json: { runId: ST.a } }); toast('Pinned as baseline'); draw(); } catch (e) { toast(e.message, true); } };
    if (mode === 'stats') await stats(); else judgeSection();
  }

  async function stats() {
    const c = await lab(`/compare?a=${ST.a}&b=${ST.b}`);
    const same = c.a.config.n === c.b.config.n;
    const tone = (m) => (m.verdict === 'better' ? 'ok' : m.verdict === 'worse' ? 'bad' : '');
    const fmt = (m, v) => (v == null ? '—' : m.key === 'ms' ? (v / 1000).toFixed(1) + 's' : m.key === 'note_words' ? Math.round(v) : v.toFixed(3));
    const head3 = c.metrics.filter((m) => ['similarity_to_gold', 'omission_rate', 'story_flow', 'ms'].includes(m.key));
    $('#cstats').innerHTML = `
      ${c.paired < 2 ? '<div class="card warn">These two runs share fewer than 2 notes, so no paired comparison is possible. Re-run both on the same notes.</div>' : ''}
      <div class="cards">${head3.map((m) => kpi(m.label.toUpperCase(), `${fmt(m, m.a)} → ${fmt(m, m.b)}`, `<span class="pill ${tone(m)}">${m.verdict}</span> ${m.n ? `${m.improved} better · ${m.regressed} worse` : ''}`)).join('')}</div>
      <div class="card" style="margin-bottom:16px"><b>Paired statistics</b> <span class="hint">${c.paired} notes in common${same ? '' : ' · runs differ in size'}${c.paired < 20 ? ' · fewer than 20 notes — treat as a hint, not proof' : ''}</span>
        ${table([{ h: 'Metric', f: (m) => `<b>${esc(m.label)}</b>` }, { h: 'A', num: 1, f: (m) => fmt(m, m.a) }, { h: 'B', num: 1, f: (m) => fmt(m, m.b) }, { h: 'Mean change', num: 1, f: (m) => (m.delta == null ? '—' : m.key === 'ms' ? sgn(m.delta / 1000, 1) + 's' : sgn(m.delta, m.key === 'note_words' ? 0 : 3)) },
          { h: 'Notes better / worse', num: 1, f: (m) => `${m.improved} / ${m.regressed}` }, { h: 'p (sign test)', num: 1, f: (m) => m.p }, { h: 'Verdict', f: (m) => `<span class="pill ${tone(m)}">${m.verdict}</span>${m.underpowered ? ' <span class="sub">low n</span>' : ''}` }], c.metrics)}
        <p class="hint" style="margin:8px 0 0">“Better/worse” counts notes that moved by more than a small noise margin. p is a two-sided exact sign test: below 0.05 means the direction is very unlikely to be chance.</p></div>
      <div class="two"><div class="card"><b>Change in similarity to gold, per note</b> <span class="hint">B minus A · red = B worse</span>${barChart(c.rows.map((r) => ({ label: r.id, value: r.d_sim })), { fmt: (v) => sgn(v) })}</div>
        <div class="card"><b>Change in omission rate, per note</b> <span class="hint">B minus A · red = B omits more</span>${barChart(c.rows.map((r) => ({ label: r.id, value: r.d_om, color: undefined })).map((b) => ({ ...b, color: b.value > 0 ? '#e5484d' : '#22b573' })), { fmt: (v) => sgn(v) })}</div></div>
      <div class="card" style="margin-top:16px"><b>Notes ranked by how much B changed</b> <span class="hint">worst regressions first · click to read A vs B vs gold</span>
        ${table([{ h: 'Note', f: (r) => `<b>${esc(pretty(r.id))}</b>` }, { h: 'Similarity A → B', num: 1, f: (r) => `${f3(r.sim_a)} → ${f3(r.sim_b)} <span class="pill ${r.d_sim > 0 ? 'ok' : r.d_sim < 0 ? 'bad' : ''}">${sgn(r.d_sim)}</span>` }, { h: 'Omission A → B', num: 1, f: (r) => `${f3(r.om_a)} → ${f3(r.om_b)} <span class="pill ${r.d_om < 0 ? 'ok' : r.d_om > 0 ? 'bad' : ''}">${sgn(r.d_om)}</span>` }], c.rows.slice(0, 40), (r) => `data-note="${esc(r.id)}"`)}</div>`;
    document.querySelectorAll('[data-note]').forEach((tr) => { tr.onclick = () => openNote(tr.dataset.note); });
  }

  async function openNote(id) {
    const [x, y] = await Promise.all([lab(`/runs/${ST.a}/rows/${encodeURIComponent(id)}`), lab(`/runs/${ST.b}/rows/${encodeURIComponent(id)}`)]);
    let tab = 'ab';
    const draw2 = () => {
      const pane = (t, b) => `<div class="card"><b>${t}</b><div class="note">${mdToHtml(b || '(none)')}</div></div>`;
      const body = tab === 'ab' ? `<div class="cols3">${pane('A', x.note)}${pane('B', y.note)}<div class="card"><b>Gold</b><pre class="raw goldraw">${esc(x.gold)}</pre></div></div>` : tab === 'gold' ? `<pre class="raw">${esc(x.gold)}</pre>` : `<div style="white-space:pre-wrap;line-height:1.6">${esc(x.transcript)}</div>`;
      openDrawer(`<div class="drawer-head"><div><h2>${esc(pretty(id))}</h2></div><button class="btn sm" data-close>Close</button></div><div class="tabs">${[['ab', 'A vs B'], ['gold', 'Gold note'], ['tx', 'Transcript']].map(([k, l]) => `<button class="tab${tab === k ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div class="drawer-body wide" style="padding-top:14px">${body}</div>`);
      document.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; draw2(); }; });
    };
    draw2();
  }

  // ───────────── blind judge ─────────────
  async function judgeSection() {
    const jl = (await lab('/judges')).judges.filter((j) => j.a === ST.a && j.b === ST.b);
    $('#cjudge').innerHTML = `<h3 class="sect">Blind judge <span class="hint">every note is judged twice with the order swapped — a win only counts if it wins both ways</span></h3>
      <div class="card" style="margin-bottom:12px"><div class="tools"><label class="lbl" style="flex-direction:row;align-items:center;gap:8px">Notes to judge<select class="select" id="jn"><option>10</option><option selected>20</option><option>30</option><option>40</option></select></label><button class="btn primary" id="jgo">Run blind judge</button>
        <span class="hint">Uses gemini-2.5-pro. ~${'20'} notes ≈ 3–4 minutes.</span>${jl.length ? `<span class="grow"></span><select class="select" id="jold">${jl.map((j) => `<option value="${j.id}">${ago(j.createdAt)} · ${j.summary?.n ?? 0} notes</option>`).join('')}</select><button class="btn sm" id="jopen">Open</button>` : ''}</div></div><div id="jres"></div>`;
    $('#jgo').onclick = async () => {
      const b = $('#jgo'); b.disabled = true; b.textContent = 'Judging…';
      try { const { id } = await lab('/judge', { method: 'POST', json: { a: ST.a, b: ST.b, limit: Number($('#jn').value) } });
        for (let i = 0; i < 160; i++) { await new Promise((r) => setTimeout(r, 4000)); if (!$('#jgo')) return; const d = await lab('/judge/' + id); b.textContent = `Judging ${d.progress.done}/${d.progress.total}…`; if (d.status === 'done') { showJudge(d); break; } if (d.status === 'error') throw new Error(d.error); } judgeSection(); }
      catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'Run blind judge'; }
    };
    const jo = $('#jopen'); if (jo) jo.onclick = async () => showJudge(await lab('/judge/' + $('#jold').value));
    if (jl[0]) showJudge(await lab('/judge/' + jl[0].id));
  }
  function showJudge(d) {
    const s = d.summary; if (!s || !$('#jres')) return;
    const better = s.wins.B > s.wins.A && s.B.accuracy >= s.A.accuracy - 0.25 && s.B.completeness >= s.A.completeness - 0.1 && s.B.unsupported <= s.A.unsupported + 0.05;
    const dl = (x, y, inv) => { const v = y - x; return `<span class="pill ${v === 0 ? '' : (inv ? v < 0 : v > 0) ? 'ok' : 'bad'}">${sgn(v, 2)}</span>`; };
    $('#jres').innerHTML = `
      <div class="cards">
        ${kpi('WINS (ORDER-SWAPPED)', `A ${s.wins.A} · B ${s.wins.B} · tie ${s.wins.tie}`, `${s.n} notes judged`)}
        ${kpi('COMPLETENESS', `${s.A.completeness} → ${s.B.completeness}`, dl(s.A.completeness, s.B.completeness))}
        ${kpi('ACCURACY', `${s.A.accuracy} → ${s.B.accuracy}`, dl(s.A.accuracy, s.B.accuracy))}
        ${kpi('UNSUPPORTED CLAIMS / NOTE', `${s.A.unsupported} → ${s.B.unsupported}`, 'hallucination count · ' + dl(s.A.unsupported, s.B.unsupported, true))}
        ${kpi('MISSED FACTS / NOTE', `${s.A.missed} → ${s.B.missed}`, 'omission count · ' + dl(s.A.missed, s.B.missed, true))}
        ${kpi('JUDGE CONSISTENCY', s.swap_consistency == null ? '—' : Math.round(s.swap_consistency * 100) + '%', 'same winner in both orders · ' + (s.human.labelled ? `human agreement ${Math.round(s.human.agreement * 100)}% · κ ${s.human.kappa}` : 'label notes below to calibrate'))}
      </div>
      <div class="card" style="margin-bottom:12px"><b>${better ? 'B looks better' : 'No clear win for B'}</b> — ${better ? 'more wins, completeness and accuracy not lower, and no more hallucinated claims.' : 'B did not clearly beat A across wins, completeness, accuracy and hallucination count together. Do not promote on this evidence.'}
        <span class="hint"> Judge: ${esc(d.model || 'gemini-2.5-pro')} · ties include notes where the two orders disagreed.</span></div>
      <div class="card"><b>Per note</b> <span class="hint">Click A / B / Tie to record YOUR verdict — agreement with the judge tells you whether to trust it (κ above 0.6 is good).</span>
        ${table([{ h: 'Note', f: (i) => `<b>${esc(pretty(i.id))}</b>${i.error ? `<div class="sub" style="color:var(--bad)">${esc(i.error)}</div>` : ''}` }, { h: 'Judge', f: (i) => (i.error ? '' : `<span class="pill ${i.winner === 'B' ? 'ok' : i.winner === 'A' ? 'bad' : ''}">${i.winner}</span>${i.consistent ? '' : ' <span class="sub">orders disagreed</span>'}`) }, { h: 'A: unsupp / missed', num: 1, f: (i) => (i.error ? '' : `${i.A.unsupported} / ${i.A.missed}`) }, { h: 'B: unsupp / missed', num: 1, f: (i) => (i.error ? '' : `${i.B.unsupported} / ${i.B.missed}`) }, { h: 'Why', f: (i) => `<span class="sub">${esc(i.note || '')}</span>` },
          { h: 'Your verdict', f: (i) => (i.error ? '' : `<div class="segs sm" data-item="${esc(i.id)}">${['A', 'B', 'tie'].map((v) => `<button class="seg${i.human === v ? ' on' : ''}" data-h="${v}">${v}</button>`).join('')}</div>`) }, { h: '', f: (i) => `<button class="btn sm" data-note="${esc(i.id)}">Read</button>` }], d.items)}</div>`;
    document.querySelectorAll('[data-item] [data-h]').forEach((b) => { b.onclick = async () => { const id = b.closest('[data-item]').dataset.item; const cur = d.items.find((i) => i.id === id); const human = cur.human === b.dataset.h ? null : b.dataset.h; try { await lab(`/judge/${d.id}/label`, { method: 'POST', json: { item: id, human } }); showJudge(await lab('/judge/' + d.id)); } catch (e) { toast(e.message, true); } }; });
    document.querySelectorAll('#jres [data-note]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); openNote(b.dataset.note); }; });
  }
  await draw();
}
