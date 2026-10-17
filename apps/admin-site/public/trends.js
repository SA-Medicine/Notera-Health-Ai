// Trends: quality and speed across every lab run over time, so you can see whether changes actually moved the needle.
import { lab, lineChart, f3, kpi } from './kit.js';

export async function trendsView(ctx) {
  const { $, esc, ago, table, head } = ctx;
  $('#view').innerHTML = head('Trends', 'Every finished evaluation run, oldest to newest', '<button class="btn" id="trf">Refresh</button>') + '<div id="tr" class="card empty">Loading…</div>';
  $('#trf').onclick = () => draw();
  async function draw() {
    const [t, b] = await Promise.all([lab('/trend'), lab('/baseline-run')]);
    const R = t.runs; const base = b.baseline;
    if (!R.length) { $('#tr').innerHTML = 'No finished runs yet — start one in Run & inputs.'; return; }
    const x = (r, i) => `${i + 1}`; const tip = (r) => `${r.label || r.id.slice(-6)} · ${r.writerModel || 'default'} · ${String(r.promptSource).replace('candidate:', 'cand ')} · ${r.n} notes`;
    const ser = (name, key, color, scale = 1) => ({ name, color, points: R.map((r, i) => ({ x: x(r, i), y: r[key] == null ? null : r[key] * scale, tip: tip(r) })) });
    const last = R[R.length - 1], prev = R.length > 1 ? R[R.length - 2] : null;
    const dlt = (k, inv) => { if (!prev || last[k] == null || prev[k] == null) return 'first run'; const d = last[k] - prev[k]; const good = inv ? d < 0 : d > 0; return `<span class="pill ${d === 0 ? '' : good ? 'ok' : 'bad'}">${d > 0 ? '+' : ''}${d.toFixed(3)} vs previous</span>`; };
    $('#tr').className = ''; $('#tr').innerHTML = `
      <div class="cards">
        ${kpi('RUNS', R.length, `latest ${ago(last.createdAt)}`)}
        ${kpi('SIMILARITY TO GOLD', f3(last.avg_similarity_to_gold), dlt('avg_similarity_to_gold'))}
        ${kpi('OMISSION RATE', f3(last.avg_omission_rate), dlt('avg_omission_rate', true))}
        ${kpi('STORY / FLOW', f3(last.avg_story_flow), dlt('avg_story_flow'))}
        ${kpi('LATENCY P50 / P95', `${last.p50_s}s <small>/ ${last.p95_s}s</small>`, `${last.failed || 0} failed notes`)}
        ${kpi('PINNED BASELINE', base ? esc(base.label || base.id.slice(-8)) : 'none', base ? `similarity ${base.summary?.avg_similarity_to_gold}` : 'pin one on Compare')}
      </div>
      <div class="two"><div class="card"><b>Similarity to gold &amp; story flow</b> <span class="hint">higher is better · x = run number</span>${lineChart([ser('Similarity', 'avg_similarity_to_gold', '#2d8cff'), ser('Flow', 'avg_story_flow', '#22b573')], { fmt: (v) => v.toFixed(2) })}</div>
        <div class="card"><b>Omission rate</b> <span class="hint">lower is better</span>${lineChart([ser('Omission', 'avg_omission_rate', '#e5484d')], { fmt: (v) => v.toFixed(2) })}</div></div>
      <div class="two"><div class="card"><b>Latency per note</b>${lineChart([ser('p50', 'p50_s', '#2d8cff'), ser('p95', 'p95_s', '#f5a524')], { fmt: (v) => v.toFixed(0) + 's', zero: true })}</div>
        <div class="card"><b>Note length</b> <span class="hint">average words</span>${lineChart([ser('Words', 'avg_note_words', '#8e4ec6')], { fmt: (v) => Math.round(v) })}</div></div>
      <h3 class="sect">All runs</h3>
      ${table([{ h: '#', num: 1, f: (r) => R.indexOf(r) + 1 }, { h: 'Run', f: (r) => `<b>${esc(r.label || r.id.slice(-8))}</b><div class="sub">${ago(r.createdAt)}</div>` }, { h: 'Writer / prompt', f: (r) => `<span class="sub">${esc(r.writerModel || 'default')} · ${esc(String(r.promptSource).replace('candidate:', 'cand '))}</span>` }, { h: 'N', num: 1, f: (r) => r.n }, { h: 'Similarity', num: 1, f: (r) => f3(r.avg_similarity_to_gold) }, { h: 'Omission', num: 1, f: (r) => f3(r.avg_omission_rate) }, { h: 'Flow', num: 1, f: (r) => f3(r.avg_story_flow) }, { h: 'p50', num: 1, f: (r) => r.p50_s + 's' }, { h: 'Failed', num: 1, f: (r) => r.failed ?? 0 }, { h: '', f: (r) => `<a class="btn sm" href="/lab/runs/${r.id}/export.csv" download>CSV</a>${base?.id === r.id ? ' <span class="pill ok">baseline</span>' : ''}` }].filter(Boolean), R.slice().reverse())}`;
  }
  await draw();
}
