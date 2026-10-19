// Trends: quality and speed across every lab run over time. Every metric name has a hover/focus popover with its range,
// direction (higher/lower is better) and exact formula; a "How to read these numbers" card explains the scales.
import { lab, lineChart, f3, kpi, mtip, METRICS } from './kit.js';

export async function trendsView(ctx) {
  const { $, esc, ago, table, head, toast } = ctx;
  $('#view').innerHTML = head('Trends', 'Every finished evaluation run, oldest to newest. Hover any metric name for its formula.', '<button class="btn" id="trf">Refresh</button>') + '<div id="tr" class="card empty">Loading…</div>';
  $('#trf').onclick = () => draw();
  async function draw() {
    const [t, b] = await Promise.all([lab('/trend'), lab('/baseline-run')]);
    const R = t.runs; const base = b.baseline;
    if (!R.length) { $('#tr').innerHTML = 'No finished runs yet — start one in Run & inputs.'; return; }
    const Q = R.filter((r) => r.quality?.parity_mean != null);   // runs that have a parity score
    const x = (r) => `${R.indexOf(r) + 1}`; const tip = (r) => `${r.label || r.id.slice(-6)} · ${r.writerModel || 'default'} · ${String(r.promptSource).replace('candidate:', 'cand ')} · ${r.n} notes`;
    const ser = (name, key, color, list = R, get = (r) => r[key]) => ({ name, color, points: list.map((r) => ({ x: x(r), y: get(r) == null ? null : get(r), tip: tip(r) })) });
    const last = R[R.length - 1], prev = R.length > 1 ? R[R.length - 2] : null; const lastQ = Q[Q.length - 1];
    const dlt = (k, inv) => { if (!prev || last[k] == null || prev[k] == null) return 'first run'; const d = last[k] - prev[k]; const good = inv ? d < 0 : d > 0; return `<span class="pill ${d === 0 ? '' : good ? 'ok' : 'bad'}">${d > 0 ? '+' : ''}${d.toFixed(3)} vs previous</span>`; };
    const pct = (r) => (r.quality?.parity_n ? Math.round((r.quality.parity_at90 / r.quality.parity_n) * 100) : null);
    $('#tr').className = ''; $('#tr').innerHTML = `
      <div class="cards">
        ${kpi('RUNS', R.length, `latest ${ago(last.createdAt)}`)}
        ${kpi('PARITY SCORE', lastQ ? lastQ.quality.parity_mean.toFixed(1) : '—', lastQ ? `latest scored run · ${pct(lastQ)}% of notes at 90+` : 'press “Score” on a run', '', 'parity')}
        ${kpi('SIMILARITY (AS SHOWN)', f3(last.avg_similarity_rendered ?? last.avg_similarity_to_gold), dlt(last.avg_similarity_rendered != null ? 'avg_similarity_rendered' : 'avg_similarity_to_gold'), '', 'similarity_rendered')}
        ${kpi('OMISSION RATE', f3(last.avg_omission_rate), dlt('avg_omission_rate', true), '', 'omission')}
        ${kpi('STORY / FLOW', f3(last.avg_story_flow), dlt('avg_story_flow'), '', 'flow')}
        ${kpi('LATENCY P50', `${last.p50_s}s <small>/ p95 ${last.p95_s}s</small>`, `${last.failed || 0} failed notes`, '', 'p50')}
      </div>
      <div class="card" style="margin-bottom:16px"><b>How to read these numbers</b>
        <div class="guide">${['parity', 'at90', 'audit', 'critical', 'similarity', 'omission', 'flow', 'coverage'].map((k) => `<div><b>${esc(METRICS[k].label)}</b> <span class="hint">${esc(METRICS[k].range)}</span><div>${esc(METRICS[k].formula)}</div></div>`).join('')}</div>
        <p class="hint" style="margin:8px 0 0">Similarity, omission and flow are cheap <b>word-overlap checks</b> (0–1), good for spotting changes but not accuracy. <b>Parity</b> and <b>Audit</b> are LLM judgements on a 0–100 scale and are the ones to trust for quality. ${R.length - Q.length ? `${R.length - Q.length} of ${R.length} runs have no parity score yet — use “Score” in the table.` : ''}</p></div>
      <div class="two"><div class="card"><b>${mtip('parity')}</b> <span class="hint">scored runs · higher is better</span>${Q.length ? lineChart([ser('Parity', '', '#2d8cff', Q, (r) => r.quality.parity_mean), ser('% notes at 90+', '', '#22b573', Q, pct)], { fmt: (v) => v.toFixed(0), zero: true }) : '<div class="hint" style="padding:30px 0;text-align:center">No parity-scored runs yet</div>'}</div>
        <div class="card"><b>${mtip('omission')}</b> <span class="hint">lower is better</span>${lineChart([ser('Omission', 'avg_omission_rate', '#e5484d')], { fmt: (v) => v.toFixed(2) })}</div></div>
      <div class="two"><div class="card"><b>${mtip('similarity')} &amp; ${mtip('flow')}</b> <span class="hint">higher is better · x = run number</span>${lineChart([ser('Similarity', 'avg_similarity_to_gold', '#2d8cff'), ser('Flow', 'avg_story_flow', '#22b573')], { fmt: (v) => v.toFixed(2) })}</div>
        <div class="card"><b>${mtip('p50', 'Latency per note')}</b> <span class="hint">p50 and ${mtip('p95')}</span>${lineChart([ser('p50', 'p50_s', '#2d8cff'), ser('p95', 'p95_s', '#f5a524')], { fmt: (v) => v.toFixed(0) + 's', zero: true })}</div></div>
      <h3 class="sect">All runs</h3>
      ${table([{ h: '#', num: 1, f: (r) => R.indexOf(r) + 1 }, { h: 'Run', f: (r) => `<b>${esc(r.label || r.id.slice(-8))}</b><div class="sub">${ago(r.createdAt)}</div>` }, { h: 'Writer / prompt', f: (r) => `<span class="sub">${esc(r.writerModel || 'default')} · ${esc(String(r.promptSource).replace('candidate:', 'cand '))}</span>` }, { h: 'N', num: 1, f: (r) => r.n },
        { h: mtip('parity', 'Parity'), num: 1, f: (r) => (r.quality?.parity_mean != null ? `<b>${r.quality.parity_mean.toFixed(1)}</b>` : `<button class="btn sm" data-score="${r.id}">Score</button>`) },
        { h: mtip('at90', '90+'), num: 1, f: (r) => (pct(r) != null ? pct(r) + '%' : '—') },
        { h: mtip('audit', 'Audit'), num: 1, f: (r) => (r.quality?.audit_mean != null ? r.quality.audit_mean.toFixed(1) : '—') },
        { h: mtip('critical', 'Crit/note'), num: 1, f: (r) => (r.quality?.critical_per_note != null ? r.quality.critical_per_note.toFixed(2) : '—') },
        { h: mtip('similarity', 'Sim'), num: 1, f: (r) => f3(r.avg_similarity_to_gold) }, { h: mtip('similarity_rendered', 'Sim shown'), num: 1, f: (r) => f3(r.avg_similarity_rendered) }, { h: mtip('omission', 'Omit'), num: 1, f: (r) => f3(r.avg_omission_rate) }, { h: mtip('flow', 'Flow'), num: 1, f: (r) => f3(r.avg_story_flow) },
        { h: mtip('p50', 'p50'), num: 1, f: (r) => r.p50_s + 's' }, { h: 'Failed', num: 1, f: (r) => r.failed ?? 0 }, { h: '', f: (r) => `<a class="btn sm" href="/lab/runs/${r.id}/export.csv" download>CSV</a>${base?.id === r.id ? ' <span class="pill ok">baseline</span>' : ''}` }], R.slice().reverse())}`;
    document.querySelectorAll('[data-score]').forEach((b) => { b.onclick = async () => { b.disabled = true; b.textContent = 'Scoring…'; try { await lab(`/runs/${b.dataset.score}/parity`, { method: 'POST', json: {} }); toast('Scoring started — refresh in about a minute'); } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'Score'; } }; });
  }
  await draw();
}
