// Audio library: every stored recording in one place. Listen without leaving the page, mark what is a real consultation, delete what is not,
// download one recording, or download a training manifest of the recordings marked real. Every play, download, review, delete and export is
// written to the audit log by the server. Nothing is deleted without a confirmation, and the bucket keeps a deleted file recoverable for 7 days.
export async function audioView(ctx) {
  const { $, esc, ago, fmtDate, head, toast, api } = ctx;
  const mmss = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
  const size = (b) => (b == null ? '—' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');
  const hours = (s) => (s >= 3600 ? (s / 3600).toFixed(1) + ' h' : Math.round(s / 60) + ' min');
  const STATUS = { unreviewed: ['Not reviewed', ''], real: ['Real', 'ok'], not_real: ['Not real', 'bad'] };
  let filter = 'all'; let data = { audio: [], totals: {} }; let open = null; let busy = false;

  $('#view').innerHTML = head('Audio', 'Every stored recording. Listen, mark what is a real consultation, delete what is not, and download the real ones for training.',
    '<button class="btn" id="au-measure" title="Measure length, loudness and words for recordings that have not been measured yet">Measure new</button><button class="btn" id="au-ref">Refresh</button><button class="btn primary" title="Only recordings marked Real whose clinician allowed use for improving Notera are included" id="au-exp" title="One line per recording marked Real: audio link (valid 24 hours), transcript and note">Download training manifest</button>')
    + '<div id="au-stats"></div><div class="segs" id="au-seg"></div><div id="au-tbl"></div>';

  async function load() {
    try { data = await api('/api/console/audio?limit=500'); } catch (e) { $('#au-tbl').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
    draw();
  }

  function draw() {
    const t = data.totals || {}; const rows = data.audio;
    $('#au-stats').innerHTML = `<div class="cards" style="margin-bottom:14px">
      <div class="card stat"><div class="l">RECORDINGS</div><div class="n">${t.total ?? rows.length}</div><div class="s">${size(Number(t.bytes) || null)} · ${t.seconds ? hours(t.seconds) : '—'} of audio</div></div>
      <div class="card stat"><div class="l">REAL</div><div class="n">${t.real ?? 0}</div><div class="s">kept for training</div></div>
      <div class="card stat"><div class="l">NOT REAL</div><div class="n">${t.not_real ?? 0}</div><div class="s">marked, ready to delete</div></div>
      <div class="card stat"><div class="l">NOT REVIEWED</div><div class="n">${t.unreviewed ?? 0}</div><div class="s">${t.flagged ?? 0} flagged to look at first</div></div></div>
      ${t.not_measured ? `<div class="card" style="margin-bottom:14px;display:flex;gap:12px;align-items:center"><span>${t.not_measured} recording${t.not_measured === 1 ? '' : 's'} not measured yet (length, loudness, flags).</span><button class="btn sm primary" id="au-m2">Measure now</button></div>` : ''}`;
    const m2 = $('#au-m2'); if (m2) m2.onclick = measure;
    const seg = [['all', 'All'], ['unreviewed', 'Not reviewed'], ['real', 'Real'], ['not_real', 'Not real'], ['flagged', 'Flagged']];
    $('#au-seg').innerHTML = seg.map(([k, l]) => `<button class="seg${filter === k ? ' on' : ''}" data-f="${k}">${l}</button>`).join('')
      + (t.not_real ? `<button class="btn sm danger" id="au-purge" style="margin-left:12px">Delete all ${t.not_real} marked Not real…</button>` : '')
      + (() => { const owners = new Map(); for (const x of rows) if (x.clinician_id) { const o = owners.get(x.clinician_id) || { email: x.email || x.clinician_id, n: 0 }; o.n++; owners.set(x.clinician_id, o); }
        return owners.size ? `<span style="margin-left:12px;display:inline-flex;gap:6px;align-items:center"><select class="select" id="au-zip-user" aria-label="Clinician">${[...owners].sort((a, b) => b[1].n - a[1].n).map(([id, o]) => `<option value="${esc(id)}">${esc(o.email)} (${o.n})</option>`).join('')}</select><button class="btn sm primary" id="au-zip" title="All stored recordings of this clinician in one zip file, with an index.csv. Recorded in the audit log.">Download all (zip)</button></span>` : ''; })();
    const zp = $('#au-zip'); if (zp) zp.onclick = () => { const u = $('#au-zip-user').value; toast('Preparing the zip — the download starts in a moment'); location.href = `/backend/api/console/audio-zip?user=${encodeURIComponent(u)}`; };
    document.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { filter = b.dataset.f; open = null; draw(); }; });
    const pu = $('#au-purge'); if (pu) pu.onclick = purge;

    const list = rows.filter((x) => filter === 'all' || (filter === 'flagged' ? x.flags?.length : x.status === filter));
    if (!list.length) { $('#au-tbl').innerHTML = '<div class="card empty">No recordings here.</div>'; return; }
    $('#au-tbl').innerHTML = `<div class="tbl-wrap"><table><thead><tr><th></th><th>Note</th><th>Owner</th><th>Recorded</th><th class="num">Length</th><th class="num">Size</th><th class="num">Words</th><th>Look at</th><th>Status</th><th></th></tr></thead><tbody>${list.map((x) => {
      const [sl, sc] = STATUS[x.status] || STATUS.unreviewed;
      const row = `<tr data-id="${esc(x.consult_id)}"><td><button class="btn sm primary" data-act="play" title="Listen here">${open === x.consult_id ? 'Hide' : '▶ Listen'}</button></td>
        <td>${esc(x.title || 'Consult')}<div class="sub" style="color:var(--ink-3);font-size:12px">${esc((x.specialty || '').replace(/_/g, ' '))}</div></td>
        <td>${esc(x.email || x.clinician_id || '—')}${x.owner_role === 'admin' ? ' <span class="pill acc">admin</span>' : ''} ${x.improve ? '<span class="pill ok" title="This clinician allowed Notera to use their recordings to improve Notera">training OK</span>' : '<span class="pill" title="This clinician has not allowed use for improving Notera. The training manifest leaves it out.">no training</span>'}</td><td>${fmtDate(x.created_at)}</td>
        <td class="num">${mmss(x.duration_s)}</td><td class="num">${size(Number(x.bytes) || null)}</td><td class="num">${x.words ?? '—'}</td>
        <td>${x.analysed_at ? ((x.flags || []).length ? x.flags.map((f) => `<span class="pill warn" style="margin:1px">${esc(f)}</span>`).join('') : '<span class="sub" style="color:var(--ink-3)">nothing odd</span>') : '<span class="sub" style="color:var(--ink-3)">not measured</span>'}</td>
        <td><span class="pill ${sc}">${sl}</span>${x.reviewed_by ? `<div class="sub" style="color:var(--ink-3);font-size:11.5px">${esc(x.reviewed_by.split('@')[0])} · ${ago(x.reviewed_at)}</div>` : ''}</td>
        <td style="white-space:nowrap"><button class="btn sm" data-act="real" ${x.status === 'real' ? 'disabled' : ''}>Real</button> <button class="btn sm" data-act="not_real" ${x.status === 'not_real' ? 'disabled' : ''}>Not real</button> <button class="btn sm" data-act="download">Download</button> <button class="btn sm danger" data-act="delete">Delete</button></td></tr>`;
      return row + (open === x.consult_id ? `<tr class="au-open"><td colspan="10"><div id="au-p-${esc(x.consult_id)}" style="padding:6px 4px"><span class="sub" style="color:var(--ink-3)">Loading the recording…</span></div></td></tr>` : '');
    }).join('')}</tbody></table></div>`;
    document.querySelectorAll('#au-tbl [data-act]').forEach((b) => { b.onclick = () => act(b.closest('tr').dataset.id, b.dataset.act); });
    if (open) player(open);
  }

  async function player(id) {
    const box = document.getElementById('au-p-' + id); if (!box) return;
    try {
      const [a, c] = await Promise.all([api(`/api/console/audio/${encodeURIComponent(id)}/url`), api(`/api/console/consults/${encodeURIComponent(id)}`).catch(() => null)]);
      if (open !== id) return;
      const tx = String(c?.consult?.transcript || '').trim();
      box.innerHTML = `<audio controls preload="metadata" src="${esc(a.url)}" style="width:100%;max-width:560px"></audio>
        <div style="margin-top:8px;font-size:12.5px;color:var(--ink-2);max-width:760px;line-height:1.5"><b>Transcript</b> ${tx ? esc(tx.slice(0, 700)) + (tx.length > 700 ? '…' : '') : '<span class="sub">none saved</span>'}</div>
        <div class="sub" style="color:var(--ink-3);font-size:11.5px;margin-top:6px">Opening the recording and the transcript is written to the audit log. The link expires in 10 minutes.</div>`;
      const au = box.querySelector('audio'); if (au) au.play().catch(() => {});
    } catch (e) { box.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
  }

  async function act(id, what) {
    if (busy) return;
    if (what === 'play') { open = open === id ? null : id; draw(); return; }
    if (what === 'download') { try { const a = await api(`/api/console/audio/${encodeURIComponent(id)}/url?download=1`); location.href = a.url; toast('Download started'); } catch (e) { toast(e.message, true); } return; }
    if (what === 'delete') { if (!confirm('Delete this recording?\n\nThe audio file is removed. The note and transcript stay. The file can be recovered from the bucket for 7 days.')) return; return remove([id]); }
    busy = true; try { await api(`/api/console/audio/${encodeURIComponent(id)}/review`, { method: 'PUT', json: { status: what } }); toast(what === 'real' ? 'Marked real' : 'Marked not real'); await load(); } catch (e) { toast(e.message, true); } busy = false;
  }

  async function remove(ids) {
    busy = true; let done = 0;
    try { for (const id of ids) { await api(`/api/console/audio/${encodeURIComponent(id)}`, { method: 'DELETE', json: { confirm: true } }); done++; } toast(`${done} recording${done === 1 ? '' : 's'} deleted`); }
    catch (e) { toast(`${done} deleted, then: ${e.message}`, true); }
    busy = false; open = null; await load();
  }
  function purge() {
    const ids = data.audio.filter((x) => x.status === 'not_real').map((x) => x.consult_id);
    if (!ids.length) return;
    if (!confirm(`Delete the ${ids.length} recording${ids.length === 1 ? '' : 's'} marked Not real?\n\nThe audio files are removed. Notes and transcripts stay. Files can be recovered from the bucket for 7 days.`)) return;
    remove(ids);
  }

  async function measure() {
    if (busy) return; busy = true; const b = $('#au-measure'); b.disabled = true;
    try { for (let i = 0; i < 40; i++) { const r = await api('/api/console/audio/analyse', { method: 'POST', json: { limit: 6 } }); b.textContent = r.remaining ? `Measuring… ${r.remaining} left` : 'Measure new'; if (!r.remaining || !r.done) break; } toast('Recordings measured'); }
    catch (e) { toast(e.message, true); }
    b.textContent = 'Measure new'; b.disabled = false; busy = false; await load();
  }

  async function exportManifest() {
    try {
      const res = await fetch('/backend/api/console/audio-export', { credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const text = await res.text(); const n = text.trim() ? text.trim().split('\n').length : 0;
      if (!n) { toast('No recording is marked Real yet', true); return; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
      a.download = `notera-training-manifest-${new Date().toISOString().slice(0, 10)}.jsonl`; document.body.appendChild(a); a.click(); a.remove();
      toast(`Manifest with ${n} recording${n === 1 ? '' : 's'} downloaded`);
    } catch (e) { toast(e.message, true); }
  }

  $('#au-ref').onclick = load; $('#au-measure').onclick = measure; $('#au-exp').onclick = exportManifest;
  await load();
}
