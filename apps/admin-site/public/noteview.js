// Full-screen note viewer + on-demand AI review (owner, 2026-11-12).
//   - the note is drawn with the SAME renderer and the SAME look as the doctor's app (class "appnote", rules in style.css copied from the app's .note-body)
//   - the note and the transcript sit side by side on a full screen; Back returns to the page underneath (the user's note list stays open), Esc = Back, arrows = previous/next
//   - "AI review" never runs by itself: the stored review is shown for free when one exists, a new one is made only when the admin presses the button
// H = helpers from app.js: { api, esc, toast, fmtDate, noteHtml, copyNote, installNoteCopy, table }
const VERDICT = { good: ['ok', 'Good'], needs_work: ['warn', 'Needs work'], unsafe: ['bad', 'Unsafe'] };
const list = (items, f) => (items && items.length ? `<ul class="rvl">${items.map((x) => `<li>${f(x)}</li>`).join('')}</ul>` : '<p class="rv-none">Nothing to report.</p>');

export function reviewHtml(H, rv, meta = {}) {
  const { esc } = H; const [cls, label] = VERDICT[rv.verdict] || VERDICT.needs_work;
  return `<div class="rv"><div class="rv-top"><span class="pill ${cls}">${label}</span><span class="rv-reason">${esc(rv.verdict_reason)}</span></div>
    ${rv.summary ? `<p class="rv-sum">${esc(rv.summary)}</p>` : ''}
    <h4>What the note says</h4><p>${esc(rv.what_it_says)}</p>
    <h4>Captured correctly</h4>${list(rv.captured, (x) => esc(x))}
    <h4>Missed from the recording</h4>${list(rv.missed, (m) => `<b>${esc(m.item)}</b>${m.transcript ? `<div class="rv-q">“${esc(m.transcript)}”</div>` : ''}`)}
    <h4>In the note but not supported by the recording</h4>${list(rv.not_supported, (m) => `<b>${esc(m.note)}</b>${m.why ? `<div class="rv-q">${esc(m.why)}</div>` : ''}`)}
    <h4>Plan quality</h4>${list(rv.plan_quality, (x) => esc(x))}
    <h4>Format</h4>${list(rv.format, (x) => esc(x))}
    ${rv.strengths?.length ? `<h4>Strengths</h4>${list(rv.strengths, (x) => esc(x))}` : ''}
    <p class="rv-meta">${meta.model ? `Reviewed by ${esc(meta.model)}` : ''}${meta.at ? ` · ${esc(H.fmtDate(meta.at))}` : ''}${meta.cached ? ' · saved earlier (no new charge)' : ''}</p></div>`;
}

/** Runs ONE review (one model call) because the admin pressed a button. */
export async function runReview(H, id, force = false) { return H.api('/api/console/review', { method: 'POST', json: { consultId: id, force } }); }

let nvKeys = null;
export function closeNoteScreen() { document.getElementById('nv')?.remove(); document.body.classList.remove('nv-open'); if (nvKeys) { document.removeEventListener('keydown', nvKeys, true); nvKeys = null; } }

export async function openNoteScreen(H, ids, startId, onClose) {
  const { api, esc, toast, fmtDate, noteHtml } = H; closeNoteScreen();
  let idx = Math.max(0, ids.indexOf(startId)); let mode = 'split', tab = 'note'; let data = null; let removeCopy = null;
  const root = document.createElement('div'); root.id = 'nv'; root.className = 'nv'; document.body.append(root); document.body.classList.add('nv-open');
  const back = () => { removeCopy?.(); closeNoteScreen(); onClose && onClose(); };
  nvKeys = (e) => {
    if (e.key === 'Escape') { if (document.getElementById('rvpop')) return; e.preventDefault(); e.stopPropagation(); back(); return; }
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || document.getElementById('rvpop')) return;
    if (e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); go(idx - 1); } if (e.key === 'ArrowRight' && idx < ids.length - 1) { e.preventDefault(); go(idx + 1); }
  };
  document.addEventListener('keydown', nvKeys, true);

  async function go(i) {
    idx = i; tab = 'note'; root.innerHTML = '<div class="nv-load">Loading…</div>';
    try { data = await api('/api/console/consults/' + encodeURIComponent(ids[idx])); } catch (e) { toast(e.message, true); return back(); }
    draw();
  }
  function paneNote(dr) { return dr?.rendered_note ? `<div class="note appnote">${noteHtml(dr.rendered_note)}</div>` : '<div class="empty">No generated note.</div>'; }
  function runsHtml(dr) {
    const tr = dr?.note?.metadata?.pipeline_trace; const t = tr ? `<div class="card" style="margin-bottom:12px"><b>Produced with</b><div class="kv" style="margin-top:6px"><span>Writer</span><code>${esc(tr.config?.writer)}</code><span>Helper</span><code>${esc(tr.config?.helper)}</code><span>Temperature</span><code>${esc(tr.config?.temperature)}</code></div></div>` : '';
    return t + (data.runs.length ? H.table([{ h: 'When', f: (x) => fmtDate(x.created_at) }, { h: 'Model', f: (x) => esc(x.model) }, { h: 'Status', f: (x) => `<span class="pill ${x.status === 'ok' ? 'ok' : 'bad'}">${esc(x.status)}</span>` }, { h: 'Time', num: 1, f: (x) => (x.duration_ms / 1000).toFixed(1) + 's' }, { h: 'Cost', num: 1, f: (x) => '$' + Number(x.est_cost_usd || 0).toFixed(4) }], data.runs) : '<div class="empty">No pipeline run recorded.</div>');
  }
  function draw() {
    const c = data.consult; const dr = data.drafts[0];
    const tx = `<div class="nv-tx">${esc(c.transcript || 'No transcript saved.')}</div>`;
    const body = tab === 'note'
      ? `<div class="nv-grid ${mode}">${mode !== 'transcript' ? `<section class="nv-col"><div class="nv-coltitle">SOAP note — as the doctor sees it</div><div class="nv-scroll">${paneNote(dr)}</div></section>` : ''}${mode !== 'note' ? `<section class="nv-col"><div class="nv-coltitle">Transcript${c.transcript ? ` · ${c.transcript.split(/\s+/).length.toLocaleString()} words` : ''}</div><div class="nv-scroll">${tx}</div></section>` : ''}</div>`
      : `<div class="nv-single"><div class="nv-scroll">${{
        audio: c.has_audio ? '<div id="au"><button class="btn primary" id="lau">Load recording</button></div>' : '<div class="empty">No audio stored for this note.</div>',
        runs: runsHtml(dr), json: `<pre class="raw">${esc(JSON.stringify({ note: dr?.note, flags: dr?.flags, finals: data.finals }, null, 2))}</pre>`,
        review: '<div id="rvbox"><div class="empty">Loading…</div></div>',
      }[tab]}</div></div>`;
    root.innerHTML = `<header class="nv-head"><button class="btn" id="nvback">← Back</button>
      <div class="nv-title"><b>${esc(c.title || c.specialty || 'Consult')}</b><span>${esc(c.full_name || c.email || c.clinician_id || '')} · ${fmtDate(c.created_at)} · ${esc((c.specialty || '').replace(/_/g, ' '))}</span></div>
      <div class="nv-nav"><button class="btn sm" id="nvprev" ${idx ? '' : 'disabled'} title="Previous note (←)">‹</button><span>${idx + 1} / ${ids.length}</span><button class="btn sm" id="nvnext" ${idx < ids.length - 1 ? '' : 'disabled'} title="Next note (→)">›</button></div>
      <div class="seg" role="group" aria-label="Layout">${[['split', 'Note + transcript'], ['note', 'Note'], ['transcript', 'Transcript']].map(([k, l]) => `<button class="${mode === k && tab === 'note' ? 'on' : ''}" data-mode="${k}">${l}</button>`).join('')}</div>
      <div class="tools"><button class="btn sm" id="nvcopy">Copy note</button><button class="btn sm primary" id="nvreview" title="Runs one AI review of this note. It only runs when you press this.">AI review</button></div></header>
      <nav class="tabs nv-tabs">${[['note', 'Note'], ['audio', 'Audio'], ['runs', 'Pipeline'], ['json', 'Raw'], ['review', 'AI review']].map(([k, l]) => `<button class="tab${tab === k ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</nav>
      <main class="nv-body">${body}</main>`;
    root.querySelector('#nvback').onclick = back;
    root.querySelector('#nvprev').onclick = () => go(idx - 1); root.querySelector('#nvnext').onclick = () => go(idx + 1);
    root.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { mode = b.dataset.mode; tab = 'note'; draw(); }; });
    root.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; draw(); }; });
    root.querySelector('#nvcopy').onclick = async () => { const ok = await H.copyNote(dr?.rendered_note || ''); toast(ok ? 'Note copied with formatting' : 'Could not copy. Select the note and press Ctrl+C', !ok); };
    root.querySelector('#nvreview').onclick = () => { tab = 'review'; draw(); };
    removeCopy?.(); removeCopy = H.installNoteCopy(() => root.querySelector('.appnote'));
    const l = root.querySelector('#lau'); if (l) l.onclick = async () => { l.disabled = true; try { const a = await api(`/api/console/consults/${encodeURIComponent(ids[idx])}/audio`); root.querySelector('#au').innerHTML = `<audio controls autoplay src="${esc(a.url)}" style="width:100%"></audio><p style="color:var(--ink-3)">Link expires in ${Math.round(a.expiresInSec / 60)} min. This play is recorded in the audit log.</p>`; } catch (e) { toast(e.message, true); l.disabled = false; } };
    if (tab === 'review') loadReview();
  }
  async function loadReview() {
    const box = root.querySelector('#rvbox'); const id = ids[idx];
    const show = (rv, meta) => { box.innerHTML = `<div class="rv-bar"><button class="btn primary" id="rvrun">${rv ? 'Run a new review' : 'Run AI review'}</button><span class="rv-hint">One model call, only when you press the button.</span></div>${rv ? reviewHtml(H, rv, meta) : '<div class="empty">No review yet for this note.</div>'}`; box.querySelector('#rvrun').onclick = async (ev) => { ev.target.disabled = true; ev.target.textContent = 'Reviewing… about 20 seconds'; try { const r = await runReview(H, id, true); if (ids[idx] === id) show(r.review, r); } catch (e) { toast(e.message, true); if (ids[idx] === id) show(rv, meta); } }; };
    try { const old = await api('/api/console/review/' + encodeURIComponent(id)); show(old.review, { model: old.model, at: old.at, cached: true }); } catch { show(null, {}); }
  }
  go(idx);
}

/** The batch pop-up: reviews the selected notes one after the other (each one a model call the admin asked for), then steps through the results. */
export function openReviewBatch(H, ids, titles = {}) {
  const { esc, toast } = H; document.getElementById('rvpop')?.remove();
  const state = ids.map((id) => ({ id, status: 'waiting', rv: null, meta: null, err: '' })); let cur = 0; let stop = false;
  const pop = document.createElement('div'); pop.id = 'rvpop'; pop.className = 'rvpop'; document.body.append(pop);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowLeft' && cur > 0) { cur--; draw(); }
    else if (e.key === 'ArrowRight' && cur < state.length - 1) { cur++; draw(); }
  };
  const close = () => { stop = true; document.removeEventListener('keydown', onKey, true); pop.remove(); };
  document.addEventListener('keydown', onKey, true);
  function draw() {
    const s = state[cur]; const done = state.filter((x) => x.status === 'done').length;
    pop.innerHTML = `<div class="rvpop-card" role="dialog" aria-label="AI review"><div class="rvpop-head"><div><h2>AI review</h2><div class="sub">${done} of ${state.length} done · each review is one model call that you started</div></div><div class="tools"><button class="btn sm" id="rvprev" ${cur ? '' : 'disabled'}>‹ Previous</button><span class="rvpop-n">${cur + 1} / ${state.length}</span><button class="btn sm" id="rvnext" ${cur < state.length - 1 ? '' : 'disabled'}>Next ›</button><button class="btn sm" id="rvopen">Open note</button><button class="btn sm" id="rvx">Close</button></div></div>
      <div class="rvpop-body"><div class="rvpop-list">${state.map((x, i) => `<button class="rvi${i === cur ? ' on' : ''}" data-i="${i}"><span class="pill ${x.status === 'done' ? (VERDICT[x.rv?.verdict]?.[0] || '') : x.status === 'error' ? 'bad' : ''}">${x.status === 'done' ? esc(VERDICT[x.rv?.verdict]?.[1] || 'Done') : x.status === 'running' ? 'Running…' : x.status === 'error' ? 'Error' : 'Waiting'}</span><span>${esc(titles[x.id] || x.id)}</span></button>`).join('')}</div>
      <div class="rvpop-main"><div class="rvpop-title">${esc(titles[s.id] || s.id)}</div>${s.status === 'done' ? reviewHtml(H, s.rv, s.meta) : s.status === 'error' ? `<div class="empty">${esc(s.err)}</div>` : '<div class="empty">Reviewing… this takes about 20 seconds per note.</div>'}</div></div></div>`;
    pop.querySelector('#rvx').onclick = close; pop.querySelector('#rvprev').onclick = () => { cur--; draw(); }; pop.querySelector('#rvnext').onclick = () => { cur++; draw(); };
    pop.querySelector('#rvopen').onclick = () => { const id = s.id; close(); openNoteScreen(H, ids, id, null); };
    pop.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => { cur = Number(b.dataset.i); draw(); }; });
  }
  pop.onclick = (e) => { if (e.target === pop) close(); };
  draw();
  (async () => {
    for (const s of state) {
      if (stop) return; s.status = 'running'; if (document.getElementById('rvpop')) draw();
      try { const r = await runReview(H, s.id, false); s.rv = r.review; s.meta = r; s.status = 'done'; } catch (e) { s.status = 'error'; s.err = e.message; }
      if (document.getElementById('rvpop')) draw();
    }
    if (!stop) toast('AI review finished');
  })();
}
