// Diagnose: an overall analysis of a whole run. Audits the worst notes, adds metrics and pipeline-log statistics, and asks a
// stronger model to find the RECURRING patterns, name the pipeline stage to blame, and recommend prioritised fixes
// (prompt / setting / pipeline / guardrail / data) that you can accept, mark done or dismiss.
import { lab, f3, cur, runLabel, barChart, kpi } from './kit.js';

export async function insightsView(ctx) {
  const { $, esc, ago, table, head, toast, go } = ctx;
  $('#view').innerHTML = head('Diagnose', 'Look at the whole run, not one note: recurring failures, which stage causes them, and what to change first', '') + '<div id="ix" class="card empty">Loading…</div>';
  let T = null; let reps = []; let runs = [];

  async function draw() {
    clearTimeout(T);
    [runs, reps] = await Promise.all([lab('/runs').then((r) => r.runs.filter((x) => x.status === 'done')), lab('/reports').then((r) => r.reports)]);
    if (!runs.length) { $('#ix').className = 'card empty'; $('#ix').innerHTML = 'No finished runs yet. Start one in <a class="lnk" id="g1">Run &amp; inputs</a>.'; $('#g1').onclick = () => go('lab'); return; }
    const sel = runs.some((r) => r.id === cur.run) ? cur.run : runs[0].id;
    const running = reps.find((r) => r.status === 'running');
    $('#ix').className = ''; $('#ix').innerHTML = `
      <div class="card cmpbar"><label class="lbl" style="flex:1;min-width:300px">Run to diagnose<select class="select" id="ir">${runs.map((r) => `<option value="${r.id}"${r.id === sel ? ' selected' : ''}>${esc(runLabel(r))} · ${ago(r.createdAt)}</option>`).join('')}</select></label>
        <label class="lbl">Notes to audit<select class="select" id="il"><option>10</option><option selected>15</option><option>25</option><option>40</option></select></label>
        <div class="tools"><button class="btn primary" id="ig" ${running ? 'disabled' : ''}>${running ? 'Diagnosing…' : 'Generate overall diagnosis'}</button></div></div>
      <p class="hint" style="margin:-6px 0 14px">Audits the worst-scoring notes of the run one by one (about 20 s each, 3 at a time), then diagnoses the system. Takes 2–6 minutes. Nothing in production changes.</p>
      ${running ? `<div class="card" style="border-color:var(--accent);margin-bottom:14px"><b>${esc(running.stage)}</b> <span class="hint">${running.progress.done}/${running.progress.total} notes audited</span></div>` : ''}
      <div id="ires"></div>
      <h3 class="sect">Earlier diagnoses</h3>
      ${reps.length ? table([{ h: 'When', f: (r) => ago(r.createdAt) }, { h: 'Run', f: (r) => `<span class="mono">${esc(r.runId.slice(-8))}</span>` }, { h: 'Verdict', f: (r) => (r.status === 'done' ? esc(r.headline || '') : `<span class="pill ${r.status === 'error' ? 'bad' : 'acc'}">${esc(r.status)}</span>`) }, { h: 'Recommendations', num: 1, f: (r) => `${r.open ?? 0} open / ${r.recs ?? 0}` }, { h: '', f: (r) => (r.status === 'done' ? `<button class="btn sm" data-rep="${r.id}">Open</button>` : '') }], reps) : '<div class="card empty">None yet.</div>'}`;
    $('#ir').onchange = (e) => { cur.run = e.target.value; };
    $('#ig').onclick = async () => { cur.run = $('#ir').value; try { await lab(`/runs/${cur.run}/report`, { method: 'POST', json: { limit: Number($('#il').value) } }); toast('Diagnosis started'); draw(); } catch (e) { toast(e.message, true); } };
    document.querySelectorAll('[data-rep]').forEach((b) => { b.onclick = () => show(b.dataset.rep); });
    const latest = reps.find((r) => r.status === 'done' && r.runId === sel) || reps.find((r) => r.status === 'done');
    if (latest) show(latest.id);
    if (running) T = setTimeout(() => { if ($('#ix')) draw(); }, 6000);
  }

  async function show(id) {
    const r = await lab('/reports/' + id); const box = $('#ires'); if (!box || r.status !== 'done') return;
    const ls = r.logStats || {}; const blame = Object.entries(r.stage_blame || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const sevPill = (s) => `<span class="pill ${s === 'critical' ? 'bad' : s === 'major' ? 'warn' : ''}">${esc(s)}</span>`;
    const dest = (rec) => (rec.category === 'prompt' ? ['prompts', 'Open Prompts'] : rec.category === 'setting' ? ['settings', 'Open Settings'] : rec.stage === 'writer' || rec.stage === 'rules' ? ['optimize', 'Improve writer prompt'] : null);
    box.innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="tools"><b style="font-size:16px">${esc(r.headline)}</b><span class="grow"></span><button class="btn sm" id="md">Export .md</button></div><p style="margin:8px 0 0">${esc(r.assessment)}</p>
        <div class="hint" style="margin-top:6px">Based on ${r.audited} audited notes of ${r.config?.n} · writer ${esc(r.config?.writerModel || 'default')} · prompt ${esc(r.config?.promptSource)} · ${ago(r.createdAt)}</div></div>
      <div class="cards">
        ${kpi('AVG SIMILARITY', f3(r.metrics?.avg_similarity_to_gold), 'to gold notes')}${kpi('AVG OMISSION', f3(r.metrics?.avg_omission_rate), 'gold facts missing')}
        ${kpi('VERIFIER REMOVED', ls.verifier_removed ?? 0, `${ls.verifier_refused ?? 0} refused · ${ls.verifier_skipped ?? 0} skipped`)}${kpi('CLEANUP REMOVED', ls.cleanup_removed ?? 0, `${ls.dedupe_removed ?? 0} duplicate lines`)}
        ${kpi('CHECKLIST MERGES', ls.checklist_merged ?? 0, `${ls.checklist_skipped ?? 0} checklist calls skipped`)}${kpi('AVG STAGE TIME', Object.entries(ls.stage_ms || {}).map(([k, v]) => `${k.split('+')[0]} ${(v / 1000).toFixed(1)}s`).join(' · ') || '—', 'from pipeline logs')}
      </div>
      <div class="two"><div class="card"><b>Which stage is to blame</b> <span class="hint">audited notes by root cause</span>${blame.length ? barChart(blame.map(([k, n]) => ({ label: k, value: n })), { h: 130 }) : '<div class="hint">—</div>'}</div>
        <div class="card"><b>What already works</b><ul>${(r.what_works || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="hint">—</li>'}</ul></div></div>
      <h3 class="sect">Recurring patterns</h3>
      ${table([{ h: 'Pattern', f: (p) => `<b>${esc(p.title)}</b><div class="sub">${esc(p.evidence || '')}</div>${p.example ? `<div class="sub">e.g. ${esc(p.example)}</div>` : ''}` }, { h: 'Stage', f: (p) => `<span class="chip">${esc(p.stage)}</span>` }, { h: 'Severity', f: (p) => sevPill(p.severity) }, { h: 'Seen in', num: 1, f: (p) => `${p.count ?? '?'} / ${p.of ?? r.audited}` }], r.patterns || [])}
      <h3 class="sect">Recommended changes <span class="hint">in priority order — track each one</span></h3>
      <div id="recs">${(r.recommendations || []).map((x) => { const d = dest(x); return `<div class="card rec ${x.status}" data-rec="${x.id}"><div class="tools"><b>${esc(x.title)}</b><span class="chip">${esc(x.category)}</span><span class="chip">${esc(x.stage)}</span><span class="pill ${x.impact === 'high' ? 'bad' : x.impact === 'medium' ? 'warn' : ''}">impact ${esc(x.impact)}</span><span class="hint">effort ${esc(x.effort)}</span></div>
        <p style="margin:6px 0">${esc(x.detail)}</p><div class="tools">${['open', 'accepted', 'done', 'dismissed'].map((s) => `<button class="btn sm${x.status === s ? ' primary' : ''}" data-st="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}${d ? `<a class="lnk" data-go="${d[0]}">${d[1]} →</a>` : ''}</div></div>`; }).join('')}</div>`;
    box.querySelectorAll('[data-rec] [data-st]').forEach((b) => { b.onclick = async () => { const rid = b.closest('[data-rec]').dataset.rec; try { await lab(`/reports/${id}/recs/${rid}`, { method: 'PATCH', json: { status: b.dataset.st } }); show(id); } catch (e) { toast(e.message, true); } }; });
    box.querySelectorAll('[data-go]').forEach((a) => { a.onclick = () => go(a.dataset.go); });
    $('#md').onclick = () => {
      const md = [`# Diagnosis — ${r.headline}`, '', r.assessment, '', `Run ${r.runId} · ${r.audited} notes audited`, '', '## Patterns', ...(r.patterns || []).map((p) => `- **${p.title}** (${p.stage}, ${p.severity}, ${p.count}/${p.of}) — ${p.evidence}`), '', '## Recommendations', ...(r.recommendations || []).map((x, i) => `${i + 1}. **${x.title}** [${x.category}/${x.stage}, impact ${x.impact}, effort ${x.effort}, ${x.status}] — ${x.detail}`)].join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' })); a.download = `diagnosis-${r.id}.md`; a.click();
    };
  }
  await draw();
}
