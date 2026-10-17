// Optimize: the self-improvement loop for the note-writer prompt.
//   1 Improve   — a stronger model reads the worst notes of a run, names the recurring failure patterns, rewrites the prompt.
//   2 Validate  — one click runs baseline vs candidate on 40 notes the candidate never saw, then judges them blind.
//   3 Gate      — server-computed checklist (similarity, omission, failures, latency, judge, hallucination). All must pass.
//   4 Promote   — saves a new production version WITH the evidence attached; roll back any time from Prompts.
import { lab, diffHtml } from './kit.js';

export async function optimizeView(ctx) {
  const { $, esc, ago, table, head, toast, openDrawer, closeDrawer, api, go } = ctx;
  $('#view').innerHTML = head('Optimize', 'Let the system propose a better writer prompt, prove it on unseen notes, then promote it safely', '<button class="btn" id="orf">Refresh</button>') + '<div id="op" class="card empty">Loading…</div>';
  $('#orf').onclick = () => draw();
  let T = null;

  async function draw() {
    clearTimeout(T);
    const [runsR, cands, vals] = await Promise.all([lab('/runs'), lab('/candidates'), lab('/validations')]);
    const done = runsR.runs.filter((r) => r.status === 'done' && r.summary);
    const running = vals.validations.filter((v) => v.status === 'running');
    $('#op').className = ''; $('#op').innerHTML = `
      <div class="steps"><div class="step-n"><b>1</b>Improve<span>from a run's failures</span></div><div class="step-n"><b>2</b>Validate<span>unseen notes + blind judge</span></div><div class="step-n"><b>3</b>Gate<span>all checks must pass</span></div><div class="step-n"><b>4</b>Promote<span>live, with rollback</span></div></div>
      <div class="card" style="margin:16px 0"><b>1 · Improve</b> <span class="hint">Pick a finished run (20+ notes works best). The model studies its worst notes; nothing changes in production.</span>
        <div class="tools" style="margin-top:10px">${done.length ? `<select class="select" id="orun" style="min-width:320px">${done.map((r) => `<option value="${r.id}">${esc(r.label || r.id.slice(-8))} · ${esc(r.config.writerModel || 'default')} · ${r.config.n} notes · similarity ${r.summary.avg_similarity_to_gold} · ${ago(r.createdAt)}</option>`).join('')}</select><button class="btn primary" id="oimp">Analyse failures &amp; propose a prompt</button><span class="hint" id="oimsg">takes 1–2 minutes</span>` : '<span class="hint">No finished runs yet — start one on the Evaluate screen.</span>'}</div></div>
      ${running.length ? `<div class="card" style="margin-bottom:16px;border-color:var(--accent)"><b>Validation in progress</b>${running.map((v) => `<div class="hint">candidate ${esc(v.candidate.slice(-6))} · ${esc(v.stage)} · ${v.ids} fresh notes</div>`).join('')}</div>` : ''}
      <h3 class="sect">Candidates</h3>
      ${cands.candidates.length ? table([{ h: 'Candidate', f: (c) => `<b>${esc(c.id.slice(-8))}</b><div class="sub">${ago(c.createdAt)}</div>` }, { h: 'From run', f: (c) => `<span class="mono">${esc(c.basedOnRun.slice(-8))}</span>` }, { h: 'Length', num: 1, f: (c) => `${c.chars.toLocaleString()} <span class="sub">(was ${c.basePromptChars.toLocaleString()})</span>` }, { h: 'Patterns found', num: 1, f: (c) => c.patterns.length }, { h: '', f: (c) => `<button class="btn sm" data-c="${c.id}">Review · validate · promote</button>` }], cands.candidates, (c) => `data-c="${c.id}"`) : '<div class="card empty">No candidates yet.</div>'}`;
    document.querySelectorAll('[data-c]').forEach((el) => { el.onclick = () => openCand(el.dataset.c); });
    const imp = $('#oimp'); if (imp) imp.onclick = async () => { imp.disabled = true; imp.textContent = 'Analysing…'; try { const c = await lab('/improve', { method: 'POST', json: { runId: $('#orun').value, k: 6 } }); toast('Candidate created'); await draw(); openCand(c.id); } catch (e) { toast(e.message, true); imp.disabled = false; imp.textContent = 'Analyse failures & propose a prompt'; } };
    if (running.length) T = setTimeout(() => { if ($('#op')) draw(); }, 6000);
  }

  async function openCand(id) {
    openDrawer('<div class="drawer-body"><div class="empty">Loading…</div></div>');
    const [c, g, live] = await Promise.all([lab('/candidates/' + id), lab(`/candidates/${id}/gate`), api('/api/console/prompts/active?name=v2-writer')]);
    const asText = (x) => (typeof x === 'string' ? x : Object.values(x || {}).join(' — '));
    const vals = (await lab('/validations')).validations.filter((v) => v.candidate === id); const busy = vals.find((v) => v.status === 'running');
    openDrawer(`<div class="drawer-head"><div><h2>Candidate ${esc(id.slice(-8))}</h2><div class="hint">${c.chars.toLocaleString()} chars (live ${live.text.length.toLocaleString()}) · from run ${esc(c.basedOnRun.slice(-8))}</div></div><button class="btn sm" data-close>Close</button></div>
      <div class="drawer-body" style="max-width:none">
        <h3 class="sect" style="margin-top:0">What it found</h3><ul>${c.patterns.map((p) => `<li>${esc(asText(p))}</li>`).join('')}</ul>
        <h3 class="sect">What it changed</h3><ul>${c.changes.map((p) => `<li>${esc(asText(p))}</li>`).join('')}</ul>
        <h3 class="sect">Exact text difference vs the live prompt</h3><div class="card">${diffHtml(live.text, c.text)}</div>
        <h3 class="sect">2 · Validate</h3>
        <div class="card"><div class="tools"><button class="btn primary" id="val" ${busy ? 'disabled' : ''}>${busy ? esc(busy.stage) + '…' : 'Run validation on 40 unseen notes'}</button><span class="hint">Runs the live prompt and this candidate on the same notes the candidate never saw, then judges them blind (order-swapped). About 8–10 minutes.</span></div>
          ${vals.length ? `<div class="hint" style="margin-top:8px">${vals.slice(0, 3).map((v) => `${ago(v.createdAt)}: ${esc(v.status === 'error' ? 'failed — ' + v.error : v.status)}`).join(' · ')}</div>` : ''}</div>
        <h3 class="sect">3 · Gate <span class="hint">computed on the server from stored runs and judgements</span></h3>
        <div class="card gate">${g.checks.length ? g.checks.map((k) => `<div class="gk ${k.pass ? 'pass' : 'fail'}"><i>${k.pass ? '✓' : '✗'}</i><b>${esc(k.label)}</b><span class="hint">${esc(k.detail)}</span></div>`).join('') : '<div class="hint">No evidence yet — run the validation.</div>'}
          <div class="gk ${g.ready ? 'pass' : 'fail'} total"><i>${g.ready ? '✓' : '·'}</i><b>${g.ready ? 'All checks passed — safe to promote' : 'Not ready to promote'}</b></div></div>
        <h3 class="sect">4 · Promote</h3>
        <div class="card"><div class="tools"><button class="btn primary" id="pro" ${g.ready ? '' : 'disabled'}>Promote to production</button>${g.ready ? '' : '<button class="btn" id="proa">Promote anyway (override)…</button>'}<button class="btn" id="pedit">Open in Prompts editor</button></div>
          <p class="hint" style="margin:8px 0 0">Creates a new version in the production database with this evidence attached. Roll back any time from Prompts → History.</p></div>
        <details style="margin-top:16px"><summary class="hint" style="cursor:pointer">Full candidate text</summary><pre class="raw" style="margin-top:8px">${esc(c.text)}</pre></details>
      </div>`);
    const v = $('#val'); if (v) v.onclick = async () => { try { await lab(`/candidates/${id}/validate`, { method: 'POST', json: { n: 40 } }); toast('Validation started'); closeDrawer(); await draw(); } catch (e) { toast(e.message, true); } };
    const promote = async (override, reason) => {
      try { const r = await api('/api/console/prompts/promote', { method: 'POST', json: { name: 'v2-writer', text: c.text, note: `from candidate ${id.slice(-6)} (run ${c.basedOnRun.slice(-6)})${override ? ' — OVERRIDE: ' + reason : ''}`, evalSummary: { candidate: id, ready: g.ready, override: !!override, reason: reason || null, checks: g.checks, runs: g.runs } } }); toast(`Promoted as v${r.version} — live`); closeDrawer(); go('prompts'); } catch (e) { toast(e.message, true); }
    };
    $('#pro').onclick = () => { if (confirm('Promote this prompt to PRODUCTION?\n\nEvery new note uses it within about a minute. All gate checks passed.')) promote(false); };
    const pa = $('#proa'); if (pa) pa.onclick = () => { const r = prompt('The gate has not passed. Type the reason you are promoting anyway (kept in the audit trail):'); if (r && r.trim().length > 5 && confirm('Promote WITHOUT a passing gate?')) promote(true, r.trim()); };
    $('#pedit').onclick = () => { localStorage.setItem('nadm_prompt', 'v2-writer'); closeDrawer(); go('prompts'); };
  }
  await draw();
}
