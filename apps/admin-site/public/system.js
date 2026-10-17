// System: the whole note pipeline on one screen (what runs, which model, which prompt version, which settings)
// plus live production health — volume, latency, failures, cost, errors — for real clinician notes.
import { lineChart, barChart, kpi } from './kit.js';

let TM = null;
export async function systemView(ctx) {
  const { $, esc, table, head, api, go, ago } = ctx;
  let days = 14;
  $('#view').innerHTML = head('System', 'Every stage of the pipeline, what is live right now, and how production is performing', '<select class="select" id="sd" aria-label="Period"><option value="7">7 days</option><option value="14" selected>14 days</option><option value="30">30 days</option></select><button class="btn" id="srf">Refresh</button>') + '<div id="sys" class="card empty">Loading…</div>';
  $('#sd').onchange = (e) => { days = Number(e.target.value); draw(); }; $('#srf').onclick = () => draw();

  async function draw() {
    const [sys, live] = await Promise.all([api('/api/console/system'), api('/api/console/live?days=' + days)]);
    const rt = sys.runtime; const t = live.totals; const last = live.daily[live.daily.length - 1];
    const day = (d) => String(d).slice(5, 10);
    const stage = (s, i) => {
      const llm = s.kind === 'llm'; const off = s.enabled === false;
      return `<div class="stage ${s.kind}${off ? ' off' : ''}">
        <div class="sk">${i + 1}<span>${llm ? 'LLM' : s.kind === 'model' ? 'MODEL' : s.kind === 'client' ? 'BROWSER' : 'CODE'}</span></div>
        <div class="sb"><b>${esc(s.label)}</b>${off ? ' <span class="pill bad">disabled</span>' : ''}
          ${s.detail ? `<div class="hint">${esc(s.detail)}</div>` : ''}
          ${s.model ? `<div class="kv"><span>Model</span><code>${esc(s.model)}</code>${s.fallback ? `<span>Fallback</span><code>${esc(s.fallback)}</code>` : ''}</div>` : ''}
          ${s.params ? `<div class="kv">${Object.entries(s.params).map(([k, v]) => `<span>${esc(k)}</span><code>${esc(v)}</code>`).join('')}</div>` : ''}
          ${s.prompt ? `<div class="kv"><span>Prompt</span><code>${esc(s.prompt)} · ${esc(s.prompt_live)}</code><a class="lnk" data-go="prompts">edit prompt</a>${s.model ? '<a class="lnk" data-go="settings">edit settings</a>' : ''}</div>` : ''}
        </div></div>`;
    };
    $('#sys').className = ''; $('#sys').innerHTML = `
      <div class="cards">
        ${kpi('NOTES GENERATED', t.runs.toLocaleString(), `last ${live.days} days`)}
        ${kpi('FAILURE RATE', (t.fail_rate * 100).toFixed(1) + '%', `${t.failed} failed`, t.fail_rate > 0.05 ? 'bad' : '')}
        ${kpi('LATENCY P50 / P95', last ? `${(last.p50_ms / 1000).toFixed(1)}s <small>/ ${(last.p95_ms / 1000).toFixed(1)}s</small>` : '—', last ? 'latest day' : 'no runs')}
        ${kpi('MODEL COST', '$' + t.cost_usd.toFixed(2), `$${t.runs ? (t.cost_usd / t.runs).toFixed(4) : '0'} per note`)}
        ${kpi('BACKEND', rt.db_ok ? 'Healthy' : 'DB down', `pipeline ${esc(rt.pipeline)} · ${esc(rt.backend)}/${esc(rt.region)} · up ${Math.round(rt.uptime_s / 3600)}h · ${rt.rss_mb} MB`, rt.db_ok ? 'ok' : 'bad')}
      </div>
      <h3 class="sect">Pipeline <span class="hint">in the order a note is produced · click a link to change what a stage uses</span></h3>
      <div class="stages">${sys.stages.map(stage).join('')}</div>
      <h3 class="sect">Production health</h3>
      <div class="two"><div class="card"><b>Notes per day</b>${barChart(live.daily.map((d) => ({ label: day(d.day), value: Number(d.runs) })))}</div>
        <div class="card"><b>Failures per day</b>${barChart(live.daily.map((d) => ({ label: day(d.day), value: Number(d.failed), color: '#e5484d' })))}</div></div>
      <div class="two"><div class="card"><b>Latency</b>${lineChart([{ name: 'p50', points: live.daily.map((d) => ({ x: day(d.day), y: d.p50_ms / 1000 })) }, { name: 'p95', points: live.daily.map((d) => ({ x: day(d.day), y: d.p95_ms / 1000 })) }], { fmt: (v) => v.toFixed(0) + 's', zero: true })}</div>
        <div class="card"><b>Cost per day</b>${lineChart([{ name: 'USD', points: live.daily.map((d) => ({ x: day(d.day), y: d.cost_usd })) }], { fmt: (v) => '$' + v.toFixed(2), zero: true })}</div></div>
      <div class="two"><div class="card"><b>By model</b>${table([{ h: 'Model', f: (r) => `<code>${esc(r.model)}</code>` }, { h: 'Notes', num: 1, f: (r) => r.runs }, { h: 'p50', num: 1, f: (r) => (r.p50_ms / 1000).toFixed(1) + 's' }, { h: 'p95', num: 1, f: (r) => (r.p95_ms / 1000).toFixed(1) + 's' }, { h: 'Failed', num: 1, f: (r) => r.failed }, { h: 'Cost', num: 1, f: (r) => '$' + Number(r.cost_usd).toFixed(2) }], live.by_model)}</div>
        <div class="card"><b>Errors</b>${live.errors.length ? table([{ h: 'Where', f: (r) => `${esc(r.source)}${r.agent ? ' · ' + esc(r.agent) : ''}` }, { h: 'Code', f: (r) => `<code>${esc(r.code)}</code>` }, { h: 'Count', num: 1, f: (r) => r.n }, { h: 'Last', f: (r) => ago(r.last) }], live.errors) : '<div class="hint" style="padding:24px 0;text-align:center">No errors logged in this period 🎉</div>'}</div></div>
      <div class="two"><div class="card"><b>Sign-ups per day</b>${barChart(live.signups.map((d) => ({ label: day(d.day), value: Number(d.n), color: '#22b573' })))}</div>
        <div class="card"><b>Consults saved per day</b>${barChart(live.notes.map((d) => ({ label: day(d.day), value: Number(d.n) })))}</div></div>`;
    document.querySelectorAll('[data-go]').forEach((a) => { a.onclick = () => go(a.dataset.go); });
  }
  await draw();
  clearInterval(TM); TM = setInterval(() => { if ($('#sys')) draw().catch(() => {}); else clearInterval(TM); }, 60000);
}
export function systemStop() { clearInterval(TM); TM = null; }
