// Settings: every runtime parameter of the pipeline (models, sampling, timeouts, verifier) — editable, validated server-side,
// audited, with a change history. Changes reach production within ~30 seconds, no redeploy.
export async function settingsView(ctx) {
  const { $, esc, ago, fmtDate, table, head, toast, api } = ctx;
  $('#view').innerHTML = head('Settings', 'Models, sampling and limits the note pipeline runs with. Saved changes go live within about 30 seconds.', '<button class="btn" id="srf">Refresh</button>') + '<div id="st" class="card empty">Loading…</div>';
  $('#srf').onclick = () => draw();
  const input = (s) => {
    const id = 'f_' + s.key.replace(/\W/g, '_'); const v = s.value;
    if (s.type === 'boolean') return `<label class="switch"><input id="${id}" type="checkbox" ${v ? 'checked' : ''}><span></span>${v ? 'On' : 'Off'}</label>`;
    if (s.type === 'number') return `<input class="input" id="${id}" type="number" min="${s.min}" max="${s.max}" step="${s.step || 'any'}" value="${esc(v)}"><span class="hint">range ${s.min}–${s.max}</span>`;
    const opts = (s.options || []); const has = opts.includes(v);
    return `<select class="select" id="${id}">${opts.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}${has ? '' : `<option selected>${esc(v)}</option>`}</select>`;
  };
  async function draw() {
    const [cfg, hist] = await Promise.all([api('/api/console/config'), api('/api/console/config/history?limit=25')]);
    const groups = [...new Set(cfg.settings.map((s) => s.group))]; const over = cfg.settings.filter((s) => s.source === 'override').length;
    $('#st').className = ''; $('#st').innerHTML = `${cfg.settings.some((s) => s.locked) ? '<div class="card" style="margin-bottom:16px;border-color:var(--accent)"><b>🔒 Style Spec v1 is locked.</b> The note format approved by the doctor cannot be changed here. Prompts and spec-shaping settings are read-only until the owner unlocks them; timeouts and limits stay editable.</div>' : ''}
      <div class="card" style="margin-bottom:16px;display:flex;gap:14px;align-items:center;flex-wrap:wrap"><b>${over ? `${over} override${over === 1 ? '' : 's'} active` : 'Everything is on its default'}</b>
        <span class="hint">Resolution order: your override → server environment → built-in default. “Reset” returns a setting to the default. Invalid values are rejected by the server.</span></div>
      ${groups.map((g) => `<h3 class="sect">${esc(g)}</h3><div class="card setcard">${cfg.settings.filter((s) => s.group === g).map((s) => `
        <div class="setrow" data-key="${esc(s.key)}">
          <div class="setinfo"><b>${esc(s.label)}</b> ${s.locked ? '<span class="pill acc">🔒 locked</span>' : ''} <span class="pill ${s.source === 'override' ? 'acc' : ''}">${s.source === 'override' ? 'override' : 'default'}</span>
            <div class="hint">${esc(s.help)}</div>
            <div class="hint">Default <code>${esc(s.default)}</code>${s.updated_by ? ` · changed by ${esc(s.updated_by)} ${ago(s.updated_at)}` : ''}</div></div>
          <div class="setctl">${input(s)}<button class="btn sm primary" data-save="${esc(s.key)}" ${s.locked ? 'disabled title="Locked: Style Spec v1"' : ''}>Save</button><button class="btn sm" data-reset="${esc(s.key)}" ${s.source === 'override' && !s.locked ? '' : 'disabled'}>Reset</button></div>
        </div>`).join('')}</div>`).join('')}
      <h3 class="sect">Change history</h3>
      ${hist.history.length ? table([{ h: 'When', f: (h) => fmtDate(h.changed_at) }, { h: 'Setting', f: (h) => `<code>${esc(h.key)}</code>` }, { h: 'Change', f: (h) => `<code>${esc(h.old_value ?? 'default')}</code> → <code>${esc(h.new_value ?? 'default')}</code>` }, { h: 'By', f: (h) => esc(h.changed_by || '') }, { h: 'Reason', f: (h) => esc(h.reason || '') }], hist.history) : '<div class="card empty">No changes yet.</div>'}`;
    document.querySelectorAll('[data-save]').forEach((b) => { b.onclick = async () => {
      const key = b.dataset.save; const el = $('#f_' + key.replace(/\W/g, '_')); const s = cfg.settings.find((x) => x.key === key);
      const value = s.type === 'boolean' ? el.checked : s.type === 'number' ? Number(el.value) : el.value;
      if (value === s.value) return toast('No change');
      const reason = prompt(`Why change “${s.label}” to ${value}? (optional, kept in the history)`, '');
      if (reason === null) return;
      try { await api('/api/console/config/' + encodeURIComponent(key), { method: 'PUT', json: { value, reason } }); toast(`${s.label} saved — live within 30 s`); draw(); } catch (er) { toast(er.message, true); }
    }; });
    document.querySelectorAll('[data-reset]').forEach((b) => { b.onclick = async () => { if (!confirm('Reset this setting to its default?')) return; try { await api('/api/console/config/' + encodeURIComponent(b.dataset.reset), { method: 'DELETE' }); toast('Reset to default'); draw(); } catch (er) { toast(er.message, true); } }; });
  }
  await draw();
}
