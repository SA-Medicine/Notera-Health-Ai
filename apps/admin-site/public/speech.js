// Speech to text: the engine chain (primary + fallbacks), live health of every engine, and the measured comparison on the same recordings.
// Changes are saved to the production database and reach the very next recording (settings are cached for 30 s).
export async function speechView(ctx) {
  const { $, esc, ago, head, toast, api } = ctx;
  $('#view').innerHTML = head('Speech to text', 'Which engine turns the recording into text, what happens when it fails, and how the engines compare on the same audio.', '<button class="btn" id="srf">Refresh</button>') + '<div id="sp" class="card empty">Loading…</div>';
  $('#srf').onclick = () => draw();
  const pct = (v, d = 1) => (v == null ? '—' : (v * 100).toFixed(d) + '%');
  const usd = (v) => (v == null ? '—' : '$' + (v < 0.1 ? v.toFixed(3) : v.toFixed(2)));

  async function draw() {
    const d = await api('/api/console/asr'); const S = d.settings; const E = d.engines; const names = Object.keys(E); const H = d.health || {}; const B = d.benchmark;
    const bench = (n) => (B?.summary || []).find((x) => x.model === n);
    const opt = (sel, none) => `${none ? '<option value="">— none —</option>' : ''}${names.map((n) => `<option value="${esc(n)}"${n === sel ? ' selected' : ''}>${esc(E[n].label)}</option>`).join('')}`;
    const fb = [S.fallbacks[0] || '', S.fallbacks[1] || '', S.fallbacks[2] || ''];
    $('#sp').className = ''; $('#sp').innerHTML = `
      <div class="card" style="margin-bottom:14px"><h3 style="margin:0 0 8px">Engine chain</h3>
        <p class="hint">Every recording goes to the <b>primary</b> engine. If it fails, times out, or returns nothing for audio that clearly contains speech, the next engine is tried automatically. An engine that keeps failing is skipped for a few minutes (circuit breaker).</p>
        <div class="grid2"><label class="lbl">Primary<select class="select" id="a-p">${opt(S.primary)}</select></label>
          <label class="lbl">Fallback 1<select class="select" id="a-f0">${opt(fb[0], true)}</select></label>
          <label class="lbl">Fallback 2<select class="select" id="a-f1">${opt(fb[1], true)}</select></label>
          <label class="lbl">Fallback 3<select class="select" id="a-f2">${opt(fb[2], true)}</select></label>
          <label class="lbl">Give up on an engine after (seconds)<input class="input" id="a-t" type="number" min="5" max="180" value="${Math.round(S.timeoutMs / 1000)}"></label>
          <label class="lbl">Open the breaker after N failures in a row<input class="input" id="a-b" type="number" min="1" max="20" value="${S.breakerFailures}"></label></div>
        <label class="switch" style="margin:6px 0"><input id="a-s" type="checkbox" ${S.speechCheck ? 'checked' : ''}><span></span>Treat “no text for clear speech” as a failure and try the next engine</label>
        <label class="switch" style="margin:6px 0"><input id="a-x" type="checkbox" ${S.crossCheck ? 'checked' : ''}><span></span>Second opinion: a different engine hears the same audio at the same time; a medical word it heard better (calf, not class) replaces the look-alike, and a sentence the first engine dropped is added (about $0.002 a minute; if it fails the first transcript is used as it is)</label>
        <div class="tools" style="margin-top:10px"><button class="btn primary" id="a-save">Save</button><button class="btn" id="a-reset">Reset to the built-in default</button>
          <span class="hint">${d.meta ? `Saved by ${esc(d.meta.updated_by || '')} ${ago(d.meta.updated_at)}` : `Built-in default: ${esc(E[d.defaults.primary].label)}${d.defaults.fallbacks.length ? ' → ' + d.defaults.fallbacks.map((f) => esc(E[f].label)).join(' → ') : ''}`}</span></div></div>

      <div class="card" style="margin-bottom:14px"><h3 style="margin:0 0 8px">Same audio, every engine ${B ? `<span class="hint">${B.files} recordings with human transcripts · ${esc(String(B.date || '').slice(0, 10))}</span>` : ''}</h3>
        ${B ? `<div class="tbl-wrap"><table><thead><tr><th>Engine</th><th class="num">Word errors</th><th class="num">Words missed</th><th class="num">Key terms right</th><th class="num">Speed (× real time)</th><th class="num">Cost / 10 min</th><th>Notes</th></tr></thead><tbody>
          ${B.summary.map((s) => `<tr><td><b>${esc(E[s.model]?.label || s.model)}</b>${S.primary === s.model ? ' <span class="pill acc">primary</span>' : S.fallbacks.includes(s.model) ? ' <span class="pill">fallback</span>' : ''}</td><td class="num"><b>${pct(s.wer_mean)}</b><div class="sub">worst ${pct(s.wer_worst, 0)}</div></td><td class="num">${pct(s.deletions_pct)}</td><td class="num">${pct(s.key_recall, 0)}</td><td class="num">${s.rtf == null ? '—' : s.rtf.toFixed(2)}</td><td class="num">${usd(s.cost_per_10min)}</td><td class="sub">${esc(s.note || E[s.model]?.note || '')}${s.failed ? ` · ${s.failed} failed run(s)` : ''}</td></tr>`).join('')}</tbody></table></div>
          <p class="hint" style="margin-top:8px">Word errors = substitutions + deletions + insertions against the human transcript, with fillers (“uh”), speaker labels and number spelling normalised. Key terms = numbers and drug-like words. Lower errors are better. ${esc(B.method || '')}</p>` : '<p class="hint">No benchmark saved yet. Run <code>node tools/asr-benchmark.mjs</code> in the backend container.</p>'}</div>

      <div class="card"><h3 style="margin:0 0 8px">Live health <span class="hint">since the last restart of the backend</span></h3>
        <div class="tbl-wrap"><table><thead><tr><th>Engine</th><th class="num">Calls</th><th class="num">OK</th><th class="num">Failed</th><th class="num">Empty for speech</th><th class="num">Used as fallback</th><th class="num">Avg time</th><th>State</th></tr></thead><tbody>
          ${names.map((n) => { const h = H[n] || {}; return `<tr><td>${esc(E[n].label)}</td><td class="num">${h.calls || 0}</td><td class="num">${h.ok || 0}</td><td class="num">${h.fail || 0}</td><td class="num">${h.empty || 0}</td><td class="num">${h.fallbackServed || 0}</td><td class="num">${h.avgMs ? (h.avgMs / 1000).toFixed(1) + ' s' : '—'}</td><td>${h.breakerOpen ? `<span class="pill bad">skipped for ${Math.ceil(h.openForMs / 1000)} s</span>` : (h.lastError ? `<span class="pill warn" title="${esc(h.lastError)}">last error</span>` : '<span class="pill ok">healthy</span>')}</td></tr>`; }).join('')}</tbody></table></div>
        <div class="tools" style="margin-top:8px"><button class="btn sm" id="a-hr">Clear counters and re-enable skipped engines</button></div></div>`;

    $('#a-save').onclick = async () => {
      const fallbacks = ['a-f0', 'a-f1', 'a-f2'].map((i) => $('#' + i).value).filter(Boolean);
      try { await api('/api/console/asr/settings', { method: 'PUT', json: { primary: $('#a-p').value, fallbacks, timeoutMs: Number($('#a-t').value) * 1000, breakerFailures: Number($('#a-b').value), speechCheck: $('#a-s').checked, crossCheck: $('#a-x').checked } }); toast('Saved — the next recording uses it'); draw(); } catch (e) { toast(e.message, true); }
    };
    $('#a-reset').onclick = async () => { if (!confirm('Go back to the built-in default engine chain?')) return; try { await api('/api/console/asr/settings', { method: 'DELETE' }); toast('Back to the default'); draw(); } catch (e) { toast(e.message, true); } };
    $('#a-hr').onclick = async () => { try { await api('/api/console/asr/health/reset', { method: 'POST', json: {} }); toast('Counters cleared'); draw(); } catch (e) { toast(e.message, true); } };
  }
  await draw();
}
