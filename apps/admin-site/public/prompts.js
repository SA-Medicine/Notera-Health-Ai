// Prompts: every LLM prompt in the pipeline (writer, checklist, verifier). Edit → compare with live → save as a new
// version → it becomes the active prompt in the production database and is used by the next note (≤60 s cache).
// Roll back by activating any older version. The server validates that required parser markers survive an edit.
import { lab, diffHtml, MODELS, opts } from './kit.js';

const SEL = { name: localStorage.getItem('nadm_prompt') || 'v2-writer' };
export async function promptsView(ctx) {
  const { $, esc, ago, fmtDate, table, head, toast, api, go } = ctx;
  $('#view').innerHTML = head('Prompts', 'The instructions each model stage runs on. Saved versions go live in the production database — no redeploy.', '<button class="btn" id="prf">Refresh</button>') + '<div id="pr" class="card empty">Loading…</div>';
  $('#prf').onclick = () => draw();
  let reg = [], live = null, detail = null, vers = [], defaultText = '', draft = '', note = '', tab = 'edit', viewV = null;

  async function load() {
    reg = (await api('/api/console/prompts/registry')).prompts;
    const n = encodeURIComponent(SEL.name);
    const [a, v, d] = await Promise.all([api('/api/console/prompts/active?name=' + n), api('/api/console/prompts?name=' + n), api('/api/console/prompts/default?name=' + n)]);
    live = a; vers = v.versions; defaultText = d.text; detail = reg.find((r) => r.name === SEL.name);
    if (!draft) draft = live.text;
  }
  async function draw(keepDraft) {
    const keep = keepDraft ? draft : null; await load(); if (keep != null) draft = keep;
    const dirty = draft !== live.text;
    $('#pr').className = ''; $('#pr').innerHTML = `
    <div class="pr-grid">
      <aside class="pr-list" role="tablist" aria-label="Prompts">${reg.map((r) => `<button class="pr-item${r.name === SEL.name ? ' on' : ''}" data-p="${r.name}" role="tab"><b>${esc(r.label)}</b><span class="pill ${r.live === 'default' ? '' : 'acc'}">${esc(r.live)}</span><div class="hint">${esc(r.stage)} · ${r.live_chars.toLocaleString()} chars · ${r.versions} version${r.versions === 1 ? '' : 's'}</div></button>`).join('')}
        <div class="card hint" style="margin-top:10px"><b>How it reaches production</b><br>Saving creates an immutable version in the production database and makes it active. The pipeline reads the active version on every note (cached ≤60 s) and records the version it used inside each note.</div></aside>
      <section class="pr-main">
        <div class="pr-head"><div><h2>${esc(detail.label)}</h2><div class="hint">${esc(detail.help)}</div></div>
          <div class="tools"><span class="pill ${live.using_default ? '' : 'ok'}">live: ${live.using_default ? 'built-in default' : 'v' + live.version}</span></div></div>
        <div class="subtabs">${[['edit', 'Edit'], ['history', `History (${vers.length})`], ['diff', 'Compare with default']].map(([k, l]) => `<button class="subtab${tab === k ? ' on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
        <div id="prbody"></div>
      </section></div>`;
    document.querySelectorAll('[data-p]').forEach((b) => { b.onclick = () => { SEL.name = b.dataset.p; localStorage.setItem('nadm_prompt', SEL.name); draft = ''; tab = 'edit'; viewV = null; draw(); }; });
    document.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => { tab = b.dataset.t; viewV = null; body(); document.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === b)); }; });
    body();
  }
  function body() {
    const box = $('#prbody'); const dirty = draft !== live.text;
    if (tab === 'edit') {
      box.innerHTML = `
        <div class="hint" style="margin:0 0 8px">Must keep: ${detail.must.map((m) => `<code>${esc(m)}</code>`).join(' ')} — the code that reads the model's answer depends on them. ${SEL.name === 'v2-writer' ? 'Also keep the strict-JSON/schema instruction.' : ''}</div>
        <textarea class="editor" id="ed" spellcheck="false" aria-label="Prompt text">${esc(draft)}</textarea>
        <div class="pr-bar"><span class="hint" id="cnt"></span><div class="grow"></div>
          <button class="btn sm" id="rl" ${dirty ? '' : 'disabled'}>Discard edits</button>
          <button class="btn sm" id="rd">Load built-in default</button>
          ${SEL.name === 'v2-writer' ? '<button class="btn sm" id="try">Test on 10 gold notes</button>' : ''}
          <button class="btn sm" id="vw" ${dirty ? '' : 'disabled'}>Review changes</button></div>
        <input class="input" id="nt" placeholder="Change note — what and why (like a commit message)" value="${esc(note)}" style="width:100%;margin-top:8px">
        <div class="pr-bar"><span class="hint">${dirty ? '● Unsaved edits' : 'No unsaved edits'}</span><div class="grow"></div><button class="btn primary" id="sv" ${dirty ? '' : 'disabled'}>Save as new version &amp; go live</button></div>`;
      const ed = $('#ed'); const cnt = () => { $('#cnt').textContent = `${draft.length.toLocaleString()} characters · ~${Math.round(draft.length / 4).toLocaleString()} tokens`; }; cnt();
      ed.oninput = () => { draft = ed.value; cnt(); const d = draft !== live.text; $('#sv').disabled = !d; $('#rl').disabled = !d; $('#vw').disabled = !d; };
      $('#nt').oninput = (e) => { note = e.target.value; };
      $('#rl').onclick = () => { draft = live.text; body(); };
      $('#rd').onclick = () => { draft = defaultText; body(); };
      $('#vw').onclick = () => { tab = 'diff'; document.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x.dataset.t === 'diff')); body(); };
      const tr = $('#try'); if (tr) tr.onclick = async () => { try {
        const info = await lab('/info'); const fx = (await lab('/fixtures')).fixtures; const ids = fx.map((f) => f[0]).sort(() => Math.random() - 0.5).slice(0, 10);
        await lab('/runs', { method: 'POST', json: { ids, promptText: draft, promptSource: 'editor-draft', writerModel: info.writerModel, label: 'Prompt editor draft' } }); toast('Test run started — see Evaluate'); go('lab'); } catch (er) { toast(er.message, true); } };
      $('#sv').onclick = async () => {
        if (!note.trim()) { $('#nt').focus(); return toast('Add a short change note first', true); }
        if (!confirm(`Save as a new version of “${detail.label}” and make it LIVE?\n\nThe next note generated in production will use it (within about a minute). You can roll back from History.`)) return;
        try { const r = await api('/api/console/prompts/promote', { method: 'POST', json: { name: SEL.name, text: draft, note } }); toast(`Saved as v${r.version} — live`); note = ''; draft = ''; draw(); } catch (er) { toast(er.message, true); }
      };
    } else if (tab === 'diff') {
      box.innerHTML = `<div class="two"><div class="card"><b>Your edits vs what is live now</b>${dirty ? diffHtml(live.text, draft) : '<div class="hint">No edits yet.</div>'}</div><div class="card"><b>Live vs built-in default</b>${diffHtml(defaultText, live.text)}</div></div>`;
    } else {
      box.innerHTML = vers.length ? `${table([{ h: 'Version', f: (v) => `<b>v${v.version}</b> ${v.active ? '<span class="pill ok">live</span>' : ''}<div class="sub">${esc(v.note || '')}</div>` }, { h: 'By', f: (v) => esc(v.created_by || '') }, { h: 'When', f: (v) => `${fmtDate(v.created_at)} <span class="sub">${ago(v.created_at)}</span>` }, { h: 'Chars', num: 1, f: (v) => v.chars.toLocaleString() }, { h: 'Evidence', f: (v) => (v.eval ? '<span class="pill ok">has eval</span>' : '<span class="sub">—</span>') }, { h: '', f: (v) => `<div class="tools"><button class="btn sm" data-view="${v.id}">View</button>${v.active ? '' : `<button class="btn sm" data-act="${v.id}">Roll back to this</button>`}</div>` }], vers)}
        <div id="vv"></div><div class="tools" style="margin-top:12px"><button class="btn sm" id="rst" ${live.using_default ? 'disabled' : ''}>Switch to built-in default</button><span class="hint">Versions are never deleted — the history is the audit trail.</span></div>` : '<div class="card empty">No saved versions — production is using the built-in default.</div>';
      document.querySelectorAll('[data-act]').forEach((b) => { b.onclick = async () => { if (!confirm('Make this version live? It replaces the current one within a minute.')) return; try { await api(`/api/console/prompts/${b.dataset.act}/activate`, { method: 'POST' }); toast('Rolled back'); draft = ''; draw(); } catch (er) { toast(er.message, true); } }; });
      document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = async () => { const v = (await api('/api/console/prompts/' + b.dataset.view)).version; $('#vv').innerHTML = `<div class="two" style="margin-top:12px"><div class="card"><b>v${v.version} vs live</b>${diffHtml(live.text, v.text)}</div><div class="card"><b>v${v.version} text</b><pre class="raw" style="max-height:420px;overflow:auto">${esc(v.text)}</pre></div></div>${v.eval ? `<div class="card" style="margin-top:12px"><b>Evidence saved with this version</b><pre class="raw">${esc(JSON.stringify(v.eval, null, 2))}</pre></div>` : ''}`; }; });
      const rst = $('#rst'); if (rst) rst.onclick = async () => { if (!confirm('Switch this prompt back to the built-in default?')) return; try { await api('/api/console/prompts/reset-default', { method: 'POST', json: { name: SEL.name } }); toast('Using built-in default'); draft = ''; draw(); } catch (er) { toast(er.message, true); } };
    }
  }
  void MODELS; void opts;
  await draw();
}
