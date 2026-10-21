// Review notes: every generated note SIDE BY SIDE with the clinician's gold note, with the audit (what it lacks, what is
// wrong, what is padding), the transcript, and the full pipeline log for that one note.
import { lab, pretty, f3, cur, runLabel, grade, VERDICT } from './kit.js';

const ST = { filter: 'all', tab: 'side', q: '' };
export async function resultsView(ctx) {
  const { $, esc, ago, head, toast, mdToHtml, go } = ctx;
  $('#view').innerHTML = head('Review notes', 'Read each generated note beside the gold note, see what it lacks or got wrong, and inspect how the pipeline produced it', '') + '<div id="rv" class="card empty">Loading…</div>';
  let runs = [], run = null, rows = [], audits = {}, noteId = '', detail = null;

  async function pickRun(id) {
    cur.run = id; run = await lab('/runs/' + id); audits = (await lab(`/runs/${id}/audits`)).audits;
    rows = run.rows.map((x) => ({ ...x, g: grade(x), bad: (x.omission_rate || 0) * 0.6 + (1 - (x.similarity_to_gold || 0)) * 0.4 })).sort((a, b) => b.bad - a.bad);
    noteId = rows.some((r) => r.id === cur.note) ? cur.note : rows[0]?.id || '';
  }
  async function draw() {
    runs = (await lab('/runs')).runs.filter((r) => r.status === 'done' || r.status === 'cancelled' || (r.status === 'running' && r.progress.done));
    if (!runs.length) { $('#rv').className = 'card empty'; $('#rv').innerHTML = 'No runs yet. Start one in <a class="lnk" id="g1">Run &amp; inputs</a>.'; $('#g1').onclick = () => go('lab'); return; }
    const want = runs.some((r) => r.id === cur.run) ? cur.run : runs[0].id; await pickRun(want);
    $('#rv').className = ''; $('#rv').innerHTML = `
      <div class="card rvbar"><label class="lbl" style="flex:1;min-width:280px">Run<select class="select" id="rr">${runs.map((r) => `<option value="${r.id}"${r.id === run.id ? ' selected' : ''}>${esc(runLabel(r))} · ${ago(r.createdAt)}</option>`).join('')}</select></label>
        <div class="rvsum" id="rs"></div>
        <div class="tools"><button class="btn sm" id="tocmp">Compare runs →</button><button class="btn sm" id="todx">Diagnose whole run →</button></div></div>
      <div class="res-grid"><aside class="res-list"><div class="pickbar" style="padding:8px"><input class="input grow" id="rq" type="search" placeholder="Search notes" aria-label="Search notes"></div>
        <div class="segs sm" style="margin:0 8px 8px" id="rf">${[['all', 'All'], ['bad', 'Needs work'], ['audited', 'Audited']].map(([k, l]) => `<button class="seg${ST.filter === k ? ' on' : ''}" data-f="${k}">${l}</button>`).join('')}</div><div id="rl" class="res-items"></div></aside>
        <section class="res-main" id="rm"></section></div>`;
    $('#rr').onchange = async (e) => { await pickRun(e.target.value); drawAll(); };
    $('#tocmp').onclick = () => go('compare'); $('#todx').onclick = () => go('insights');
    $('#rq').oninput = (e) => { ST.q = e.target.value; list(); };
    document.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { ST.filter = b.dataset.f; document.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b)); list(); }; });
    drawAll();
  }
  function drawAll() { summary(); list(); openNote(noteId); }
  function summary() {
    const s = run.summary || {}; const ok = rows.filter((r) => r.g === 'ok').length, bad = rows.filter((r) => r.g === 'bad').length;
    $('#rs').innerHTML = `<span class="pill">${rows.length} notes</span> <span class="pill ok">${ok} good</span> <span class="pill bad">${bad} need work</span> <span class="hint">avg similarity <b>${f3(s.avg_similarity_to_gold)}</b> · omission <b>${f3(s.avg_omission_rate)}</b> · flow <b>${f3(s.avg_story_flow)}</b></span>`;
  }
  function list() {
    const q = ST.q.trim().toLowerCase();
    const items = rows.filter((r) => (!q || r.id.toLowerCase().includes(q)) && (ST.filter === 'all' || (ST.filter === 'bad' && r.g !== 'ok') || (ST.filter === 'audited' && audits[r.id])));
    $('#rl').innerHTML = items.length ? items.map((r) => { const a = audits[r.id]; const v = a && VERDICT[a.verdict];
      return `<button class="res-item${r.id === noteId ? ' on' : ''}" data-n="${esc(r.id)}"><i class="dot ${r.g}"></i><span class="rn"><b>${esc(pretty(r.id))}</b><span class="hint">sim ${f3(r.similarity_to_gold)} · omit ${f3(r.omission_rate)}</span></span>${v ? `<span class="pill ${v[1]}">${v[0]}</span>` : ''}</button>`; }).join('') : '<div class="empty" style="padding:20px">No notes match.</div>';
    document.querySelectorAll('[data-n]').forEach((b) => { b.onclick = () => { openNote(b.dataset.n); }; });
  }
  async function openNote(id) {
    noteId = id; cur.note = id; document.querySelectorAll('[data-n]').forEach((b) => b.classList.toggle('on', b.dataset.n === id));
    const m = $('#rm'); if (!id) { m.innerHTML = '<div class="empty">No notes in this run.</div>'; return; }
    m.innerHTML = '<div class="empty">Loading…</div>';
    try { detail = await lab(`/runs/${run.id}/rows/${encodeURIComponent(id)}`); } catch (e) { m.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    paint();
  }
  const idx = () => rows.findIndex((r) => r.id === noteId);
  function paint() {
    const d = detail, r = d.row || rows[idx()] || {}; const m = $('#rm'); const aud = d.audit;
    const missed = (r.omission_missed || []).slice(0, 14);
    const tabs = [['side', 'Note vs Gold'], ['audit', 'What it lacks / got wrong'], ['transcript', 'Transcript'], ['pipe', 'Pipeline log']];
    m.innerHTML = `
      <div class="res-head"><div><h2>${esc(pretty(noteId))}</h2><div class="hint">similarity <b>${f3(r.similarity_to_gold)}</b> · omission <b>${f3(r.omission_rate)}</b> · flow <b>${f3(r.story_flow)}</b> · ${r.note_words ?? '—'} words · ${((r.ms || 0) / 1000).toFixed(1)}s ${aud ? `· audit <span class="pill ${VERDICT[aud.verdict]?.[1] || ''}">${VERDICT[aud.verdict]?.[0] || aud.verdict} ${aud.score ?? ''}</span>` : ''}</div></div>
        <div class="tools"><button class="btn sm" id="pv" ${idx() <= 0 ? 'disabled' : ''}>← Previous</button><span class="hint">${idx() + 1}/${rows.length}</span><button class="btn sm" id="nx" ${idx() >= rows.length - 1 ? 'disabled' : ''}>Next →</button></div></div>
      ${missed.length ? `<div class="chips"><span class="hint">Gold terms the note missed:</span>${missed.map((t) => `<span class="chip bad">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="subtabs" style="margin-top:8px">${tabs.map(([k, l]) => `<button class="subtab${ST.tab === k ? ' on' : ''}" data-tt="${k}">${l}${k === 'audit' && aud ? ` <span class="pill ${VERDICT[aud.verdict]?.[1] || ''}">${(aud.missing || []).length + (aud.wrong || []).length}</span>` : ''}</button>`).join('')}</div>
      <div id="tb"></div>`;
    document.querySelectorAll('[data-tt]').forEach((b) => { b.onclick = () => { ST.tab = b.dataset.tt; paint(); }; });
    $('#pv').onclick = () => openNote(rows[idx() - 1].id); $('#nx').onclick = () => openNote(rows[idx() + 1].id);
    const tb = $('#tb');
    if (ST.tab === 'side') tb.innerHTML = `<div class="cols2"><div class="card"><div class="colhead"><i class="dot ok"></i>Generated note <span class="hint">what the pipeline wrote</span></div><div class="note">${mdToHtml(d.note || '(no note)')}</div></div>
        <div class="card"><div class="colhead"><i class="dot gold"></i>Gold note <span class="hint">written by the clinician</span></div><pre class="raw goldraw">${esc(d.gold)}</pre></div></div>`;
    else if (ST.tab === 'transcript') tb.innerHTML = `<div class="card"><div style="white-space:pre-wrap;line-height:1.65">${esc(d.transcript)}</div></div>`;
    else if (ST.tab === 'pipe') tb.innerHTML = pipe(d);
    else audit(tb, aud);
  }

  function audit(tb, a) {
    if (!a) { tb.innerHTML = `<div class="card empty"><p>Nobody has audited this note yet.</p><p class="hint">An audit compares the note with the transcript and the gold note and lists what is missing, wrong, or padding. It uses gemini-2.5-pro (about 20 s, cached afterwards).</p><button class="btn primary" id="au">Audit this note</button></div>`;
      $('#au').onclick = async () => { const b = $('#au'); b.disabled = true; b.textContent = 'Auditing…'; try { detail.audit = await lab(`/runs/${run.id}/rows/${encodeURIComponent(noteId)}/audit`, { method: 'POST', json: {} }); audits[noteId] = detail.audit; list(); paint(); } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'Audit this note'; } };
      return; }
    const sev = (s) => (s === 'critical' ? 'bad' : s === 'major' || s === 'important' ? 'warn' : '');
    const pres = (n) => (n >= 85 ? 'ok' : n >= 65 ? 'warn' : 'bad');
    const block = (title, tone, items, f) => `<div class="card auditblk ${tone}"><b>${title} <span class="hint">(${(items || []).length})</span></b>${(items || []).length ? `<ul>${items.map(f).join('')}</ul>` : '<div class="hint">— none —</div>'}</div>`;
    tb.innerHTML = `<div class="card"><div class="tools"><span class="pill ${VERDICT[a.verdict]?.[1] || ''}" style="font-size:13px">${VERDICT[a.verdict]?.[0] || esc(a.verdict)} · ${a.score ?? '—'}/100</span><span>${esc(a.summary)}</span><span class="grow"></span><button class="btn sm" id="re">Re-audit</button></div>
      ${a.root_cause ? `<div class="hint" style="margin-top:8px">Most likely cause: <b>${esc(a.root_cause.stage)}</b> — ${esc(a.root_cause.why)}</div>` : ''}</div>
      <div class="two">${block('What the note lacks', 'warn', a.missing, (x) => `<li><span class="pill ${sev(x.importance)}">${esc(x.importance)}</span> ${esc(x.fact)}</li>`)}
        ${block('Wrong, unsupported or misplaced', 'bad', a.wrong, (x) => `<li><span class="pill ${sev(x.severity)}">${esc(x.severity)}</span> “${esc(x.claim)}” — ${esc(x.problem)}</li>`)}</div>
      <div class="two">${block('Padding, duplicates, commentary', '', a.extra, (x) => `<li>“${esc(x.text)}” — <span class="hint">${esc(x.why)}</span></li>`)}
        ${block('Structure and tone', '', (a.structure || []).map((s) => ({ s })), (x) => `<li>${esc(x.s)}</li>`)}</div>
      ${a.presentation ? `<div class="card"><b>How the note reads</b> <span class="hint">layout against the gold notes, separate from the content score</span><div class="tools" style="margin-top:6px"><span class="pill ${pres(a.presentation.flow)}">Flow ${a.presentation.flow ?? '—'}</span><span class="pill ${pres(a.presentation.readability)}">Easy reading ${a.presentation.readability ?? '—'}</span><span class="pill ${pres(a.presentation.organization)}">Facts organised ${a.presentation.organization ?? '—'}</span><span>${esc(a.presentation.summary || '')}</span></div>${(a.format_metrics?.flags || []).length ? `<ul style="margin:8px 0 0">${a.format_metrics.flags.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>` : ''}
      ${block('Assessment & Plan gaps', 'warn', a.ap_gaps, (x) => `<li><span class="chip">${esc(String(x.kind || '').replace(/_/g, ' '))}</span> <b>${esc(x.where || '')}</b> — ${esc(x.gap || '')} ${x.spec === 'beyond_spec' ? '<span class="pill warn">needs spec change · proposal only</span>' : ''}</li>`)}
      <div class="two">${block('Done well', 'ok', (a.strengths || []).map((s) => ({ s })), (x) => `<li>${esc(x.s)}</li>`)}${block('Reusable fixes it suggests', '', (a.suggestions || []).map((s) => ({ s })), (x) => `<li>${esc(x.s)}</li>`)}</div>`;
    $('#re').onclick = async () => { const b = $('#re'); b.disabled = true; b.textContent = 'Auditing…'; try { detail.audit = await lab(`/runs/${run.id}/rows/${encodeURIComponent(noteId)}/audit`, { method: 'POST', json: { force: true } }); audits[noteId] = detail.audit; paint(); } catch (e) { toast(e.message, true); } };
  }

  // the inside of the pipeline for this one note: timings, prompts used, writer output, checklist, merge, verifier, cleanup
  function pipe(d) {
    const t = d.trace; if (!t) return '<div class="card empty">No pipeline trace was stored for this note (runs made before trace capture have none). Re-run it to capture one.</div>';
    const used = t.used || {}; const tm = t.timings || {}; const w = t.writer_json || {}; const c = t.checklist || {}; const v = t.verifier || {};
    const stages = [['writer+checklist', 'Writer ∥ checklist'], ['verifier', 'Verifier']];
    const nProb = (w.assessment_and_plan || w.problems || []).length;
    const lines = (d.log || []).filter((l) => !/Timing\]/.test(l));
    return `<div class="cards"><div class="card stat"><div class="l">WRITER</div><div class="n" style="font-size:16px">${esc(used.config?.writer || '—')}</div><div class="s">prompt ${esc(used.prompts?.writer || '—')} · T ${esc(used.config?.temperature)}</div></div>
      <div class="card stat"><div class="l">HELPER (CHECKLIST + VERIFIER)</div><div class="n" style="font-size:16px">${esc(used.config?.helper || '—')}</div><div class="s">prompts ${esc(used.prompts?.checklist || '—')} / ${esc(used.prompts?.verifier || '—')}</div></div>
      <div class="card stat"><div class="l">STAGE TIMES</div><div class="n" style="font-size:16px">${stages.map(([k, l]) => `${l.split(' ')[0]} ${tm[k] != null ? (tm[k] / 1000).toFixed(1) + 's' : '—'}`).join(' · ')}</div><div class="s">total ${((d.row?.ms || 0) / 1000).toFixed(1)}s</div></div></div>
      <div class="pipeline-flow">
        <div class="pf"><b>1 · Writer</b><div class="hint">drafted ${nProb} problem${nProb === 1 ? '' : 's'}${w.subjective ? ` · subjective fields: ${Object.values(w.subjective).filter(Boolean).length}` : ''}</div></div><span>→</span>
        <div class="pf"><b>2 · Checklist</b><div class="hint">${(c.medications || []).length} meds · ${(c.results || []).length} results · ${(c.orders || []).length} orders · ${(c.referrals || []).length} referrals${c.follow_up ? ' · follow-up' : ''}</div></div><span>→</span>
        <div class="pf"><b>3 · Merge &amp; cleanup</b><div class="hint">${esc((lines.find((l) => /v2:merge/.test(l)) || 'nothing to add').replace('[v2:merge] ', ''))}</div></div><span>→</span>
        <div class="pf"><b>4 · Verifier</b><div class="hint">${v.dropped ? `removed ${v.dropped} line(s)` : 'removed nothing'}</div></div></div>
      <div class="two"><div class="card"><b>Checklist the helper extracted</b><pre class="raw" style="max-height:300px;overflow:auto">${esc(JSON.stringify(c, null, 2))}</pre></div>
        <div class="card"><b>Writer's raw JSON (before merge &amp; guardrails)</b><pre class="raw" style="max-height:300px;overflow:auto">${esc(JSON.stringify(w, null, 2))}</pre></div></div>
      <div class="card"><b>Log for this note</b> <span class="hint">${lines.length} lines</span><pre class="raw" style="max-height:340px;overflow:auto">${esc(lines.join('\n'))}</pre></div>`;
  }
  await draw();
}
