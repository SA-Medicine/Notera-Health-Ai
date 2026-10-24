// QUALITY: how the production notes are doing, day by day, from the quality data stored with every note (fact ledger, medicines, checks, time).
// One page instead of five: the trend, and the latest notes that need a look.


export async function qualityView(ctx) {
  const { $, esc, head, ago } = ctx; const api = ctx.api;
  let days = 14;
  $('#view').innerHTML = head('Quality', 'How the notes are doing in real use: time, lines to check, medicines to check, facts the fact ledger had to add.',
    '<div class="segs" id="q-days">' + [7, 14, 30].map((d) => `<button class="seg${d === days ? ' on' : ''}" data-d="${d}">${d} days</button>`).join('') + '</div>') + '<div id="q-body"><div class="card empty">Loading…</div></div>';
  const bar = (v, max, cls = '') => `<div class="q-bar"><i class="${cls}" style="width:${max ? Math.max(3, Math.round((v / max) * 100)) : 0}%"></i><span>${v ?? '—'}</span></div>`;
  async function load() {
    let d; try { d = await api(`/api/console/quality?days=${days}`); } catch (e) { $('#q-body').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
    const t = d.totals; const maxN = Math.max(1, ...d.days.map((x) => x.notes)); const maxS = Math.max(1, ...d.days.map((x) => x.avgSeconds || 0)); const maxC = Math.max(1, ...d.days.map((x) => x.toCheckPerNote));
    $('#q-body').innerHTML = `
      <div class="q-cards">
        <div class="card stat"><small>Notes</small><b>${t.notes}</b></div>
        <div class="card stat"><small>Average time</small><b>${t.avgSeconds ?? '—'} s</b></div>
        <div class="card stat"><small>Lines to check per note</small><b>${t.toCheckPerNote ?? '—'}</b></div>
        <div class="card stat ${t.notesWithDrugIssues ? 'warn' : ''}"><small>Notes with a medicine to check</small><b>${t.notesWithDrugIssues}</b></div>
        <div class="card stat ${t.factsMissing ? 'bad' : ''}"><small>Facts still missing</small><b>${t.factsMissing}</b></div>
      </div>
      <div class="card"><h3 style="margin:0 0 8px">Day by day</h3>${d.days.length ? `<div class="tbl-wrap"><table><thead><tr><th>Day</th><th>Notes</th><th>Average time</th><th>Lines to check per note</th><th>Medicine checks</th><th>Facts added by the ledger</th><th>Still missing</th></tr></thead><tbody>
        ${d.days.map((x) => `<tr><td>${esc(x.day)}</td><td>${bar(x.notes, maxN)}</td><td>${bar(x.avgSeconds, maxS)}</td><td>${bar(x.toCheckPerNote, maxC, 'warn')}</td><td>${x.notesWithDrugIssues}</td><td>${x.notesWithLedger ? `${x.factsAdded} of ${x.factsRequired}` : '—'}</td><td>${x.factsMissing ? `<span class="pill bad">${x.factsMissing}</span>` : '0'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No notes in this period.</div>'}</div>
      <div class="card"><h3 style="margin:0 0 8px">Latest notes</h3><div class="tbl-wrap"><table><thead><tr><th>Note</th><th>Clinician</th><th>When</th><th>Time</th><th>To check</th><th>Medicines</th><th>Facts</th><th>Pipeline</th></tr></thead><tbody>
        ${d.recent.map((n) => `<tr><td>${esc(n.title)}</td><td>${esc(n.clinician)}</td><td>${ago(n.at)}</td><td>${n.seconds != null ? n.seconds + ' s' : '—'}</td><td>${n.toCheck ? `<span class="pill warn">${n.toCheck}</span>` : '<span class="pill ok">0</span>'}</td><td>${n.drugs && (n.drugs.unknown || n.drugs.doseChecks) ? `<span class="pill warn">${(n.drugs.unknown || 0) + (n.drugs.doseChecks || 0)} to check</span>` : n.drugs?.total ? `<span class="pill ok">${n.drugs.total} ok</span>` : '—'}</td><td>${n.ledger ? `${n.ledger.added} added${n.ledger.missing ? `, <b>${n.ledger.missing} missing</b>` : ''}` : '—'}</td><td>${esc(n.mode)}</td></tr>`).join('')}</tbody></table></div></div>`;
  }
  document.querySelectorAll('#q-days [data-d]').forEach((b) => { b.onclick = () => { days = Number(b.dataset.d); document.querySelectorAll('#q-days .seg').forEach((s) => s.classList.toggle('on', s === b)); load(); }; });
  await load();
}
