// The review screen: the note beside its transcript, evidence colours on every line, the doctor's rating, edits, error flags, her suggestion,
// and a "Teach Notera" interview. Nothing here changes the app's notes: it records what the doctor thinks (and proposes future rules).
import { $, $$, esc, norm, studio, toast, busy, pill, scoreTone, when } from './kit.js';

const SUBTYPES = { hallucination: ['fabrication', 'negation', 'causality', 'contextual'], omission: ['current_issue', 'history', 'plan'] };
const SUBLABEL = { fabrication: 'Made up (not said)', negation: 'Denial turned into a finding (or reverse)', causality: 'A cause nobody gave', contextual: 'Mixed in from another topic', current_issue: 'Important symptom/result missing', history: 'History/medication missing', plan: 'Plan item missing' };

function findSpan(text, quote) {
  const words = String(quote || '').split(/\W+/).filter(Boolean); if (words.length < 2) return null;
  try { const m = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\W+'), 'i').exec(text); return m ? { at: m.index, len: m[0].length } : null; } catch { return null; }
}

function noteHtml(md, claims) {
  const map = new Map(claims.map((c) => [norm(c.text), c])); const out = []; let list = false; let n = 0;
  const closeList = () => { if (list) { out.push('</ul>'); list = false; } };
  for (const raw of String(md || '').split('\n')) {
    const line = raw.replace(/\s+$/, ''); if (!line.trim()) continue;
    const h = line.match(/^###\s+(.*)$/); if (h) { closeList(); out.push(`<h4>${esc(h[1])}</h4>`); continue; }
    const prob = line.match(/^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*$/); if (prob) { closeList(); const c = map.get(norm(prob[2])); out.push(`<div class="prob">${prob[1]}. ${c ? `<span class="${'cl'}" data-c="${esc(c.id)}">${esc(prob[2])}</span>` : esc(prob[2])}</div>`); continue; }
    const topic = line.match(/^\*\*(.+?)\*\*\s*$/); if (topic) { closeList(); out.push(`<div class="topic">${esc(topic[1])}</div>`); continue; }
    const b = line.match(/^\s*[-*]\s+(.*)$/);
    if (b) {
      if (!list) { out.push('<ul>'); list = true; }
      const txt = b[1]; const c = map.get(norm(txt));
      const lab = txt.match(/^([A-Za-z ]{3,30}):\s+(.*)$/);
      out.push(`<li class="${c ? `cl ${c.verdict}` : ''}" ${c ? `data-c="${esc(c.id)}"` : ''} data-n="${n++}">${lab && /planned|referrals|diagnosis|differential/i.test(lab[1]) ? `<span class="lab">${esc(lab[1])}:</span> ${esc(lab[2])}` : esc(txt)}</li>`);
      continue;
    }
    closeList(); out.push(`<p>${esc(line)}</p>`);
  }
  closeList(); return out.join('');
}

export async function reviewView(root, id) {
  root.innerHTML = '<div class="empty"><span class="spin"></span> Loading…</div>';
  let d = await studio('/items/' + id);
  const it = d.item; const rubric = d.rubric; const me = (await studio('/me')); const isOwner = me.access === 'owner';
  let review = d.review || null; let claims = it.evidence?.claims || [];
  const ratings = { ...(review?.ratings || {}) }; let overall = review?.overall ?? null; let signs = review?.would_sign ?? null; let errors = [...(review?.errors || [])];
  const legacy = new Date(it.created_at) < new Date(me.effective || '2026-10-20T00:00:00Z');

  const auto = it.auto_eval; const conf = it.conformance;
  root.innerHTML = `
    <div class="head"><div><a href="#/queue" class="hint">← Back to the queue</a><h2>${esc(it.title || 'Note')}</h2>
      <p>${esc(when(it.created_at))} · ${it.source === 'training' ? 'Training case' : 'Created in Notera'} ${legacy ? pill('before Style Spec v1', 'warn') : ''} ${pill(it.status === 'reviewed' ? 'Reviewed' : 'Waiting for your review', it.status === 'reviewed' ? 'ok' : 'acc')}</p></div>
      <div class="grow"></div>
      <button class="btn" id="run-ai">${it.evaluated_at ? 'Re-run AI review' : 'Run AI review'}</button></div>
    <div class="review">
      <div class="card"><div class="legend"><span><i style="background:var(--ok)"></i>supported by the transcript</span><span><i style="background:var(--warn)"></i>partly</span><span><i style="background:var(--bad)"></i>not found</span><span><i style="background:var(--ink3)"></i>unverified</span><span class="hint">Click any line to see where it came from.</span></div>
        <div class="note" id="note"></div><div id="pop"></div></div>
      <div class="card"><h3>Transcript</h3><div class="tx" id="tx"></div></div>
    </div>
    <div class="tabs" id="tabs"><button data-t="rate" class="on">Your review</button><button data-t="edit">Edit the note</button><button data-t="teach">Teach Notera</button><button data-t="ai">AI review & style check</button></div>
    <div id="tab"></div>`;

  const tx = $('#tx'); const setTx = (mark) => {
    const t = it.transcript || ''; if (!mark) { tx.textContent = t; return; }
    tx.innerHTML = `${esc(t.slice(0, mark.at))}<mark id="mk">${esc(t.slice(mark.at, mark.at + mark.len))}</mark>${esc(t.slice(mark.at + mark.len))}`; $('#mk')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  setTx(null);
  const drawNote = () => {
    $('#note').innerHTML = noteHtml(it.rendered, claims);
    $$('#note [data-c]').forEach((el) => { el.onclick = () => {
      const c = claims.find((x) => x.id === el.dataset.c); if (!c) return;
      const tone = { supported: 'ok', partial: 'warn', unsupported: 'bad', unverified: '' }[c.verdict];
      $('#pop').innerHTML = `<div class="pop">${pill(c.verdict, tone)} ${c.quote ? `Transcript says: <i>“${esc(c.quote)}”</i>` : 'No supporting words were found in the transcript.'} <button class="btn sm" id="flag">Flag as an error</button></div>`;
      setTx(c.quote ? findSpan(it.transcript || '', c.quote) : null);
      $('#flag').onclick = () => { switchTab('rate'); $('#e-text').value = c.text; $('#e-text').scrollIntoView({ block: 'center' }); };
    }; });
  };
  drawNote();

  $('#run-ai').onclick = (ev) => busy(ev.currentTarget, 'Reviewing (about a minute)…', async () => {
    const r = await studio(`/items/${id}/evaluate`, { method: 'POST', json: {} }); it.auto_eval = r.auto_eval; it.conformance = r.conformance; it.evidence = r.evidence; it.evaluated_at = new Date().toISOString();
    claims = r.evidence?.claims || []; drawNote(); toast('AI review ready'); switchTab(cur);
  });

  let cur = 'rate';
  const tabs = $('#tabs'); const switchTab = (t) => { cur = t; $$('button', tabs).forEach((b) => b.classList.toggle('on', b.dataset.t === t)); ({ rate: rateTab, edit: editTab, teach: teachTab, ai: aiTab })[t](); };
  $$('button', tabs).forEach((b) => { b.onclick = () => switchTab(b.dataset.t); });

  // ── tab: the doctor's own review ──
  function rateTab() {
    const showAi = !!review && auto?.scores;
    $('#tab').innerHTML = `<div class="card"><div class="two"><div>
        <h3>How good is this note?</h3><p class="hint">Rate each point from 1 (poor) to 5 (I would sign it as it is). ${showAi ? 'The grey number is what the AI reviewer said.' : 'The AI reviewer’s scores appear after you save, so they do not influence you.'}</p>
        ${rubric.map((r) => `<div class="rate"><div class="nm">${esc(r.label)}<small>${esc(r.help)}</small></div><div class="stars" data-r="${r.id}">${[1, 2, 3, 4, 5].map((n) => `<button data-v="${n}" class="${ratings[r.id] === n ? 'on' : ''}">${n}</button>`).join('')}</div>${showAi && auto.scores[r.id] ? `<span class="hint">AI ${auto.scores[r.id]}</span>` : ''}</div>`).join('')}
        <div class="sep"></div>
        <div class="rate"><div class="nm"><b>Overall</b><small>one number for the whole note</small></div><div class="stars" data-r="overall">${[1, 2, 3, 4, 5].map((n) => `<button data-v="${n}" class="${overall === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
        <div class="rate"><div class="nm"><b>Would you sign it as written?</b></div><div class="stars" data-r="sign"><button data-v="1" class="${signs === true ? 'on' : ''}" style="width:64px">Yes</button><button data-v="0" class="${signs === false ? 'on' : ''}" style="width:64px">No</button></div></div>
      </div><div>
        <h3>Anything wrong or missing?</h3><p class="hint">Flag each real mistake. “Made up” = in the note but never said. “Missing” = said but not in the note.</p>
        <div id="errs"></div>
        <div class="card" style="margin-top:8px;padding:12px"><div class="two"><label class="lbl">Type<select id="e-kind"><option value="hallucination">Something wrong in the note</option><option value="omission">Something missing from the note</option></select></label>
          <label class="lbl">Kind<select id="e-sub"></select></label><label class="lbl">How serious<select id="e-sev"><option value="minor">Minor</option><option value="major">Major (could change care)</option></select></label>
          <label class="lbl">Where<select id="e-sec"><option>Subjective</option><option>Past Medical History</option><option>Objective</option><option>Assessment &amp; Plan</option></select></label></div>
          <label class="lbl">The line, or the missing fact<textarea id="e-text" style="min-height:60px"></textarea></label><button class="btn sm" id="e-add">Add this flag</button></div>
        <div class="sep"></div>
        <label class="lbl">What should Notera do differently? <span class="hint">(your suggestion — it is saved for the team and becomes a proposed rule)</span><textarea id="comment">${esc(review?.comment || '')}</textarea></label>
      </div></div>
      <div class="sep"></div><button class="btn primary" id="save">Save my review</button> <span class="hint" id="saved">${review ? `Last saved ${esc(when(review.updated_at))}` : ''}</span></div>`;
    $$('.stars').forEach((g) => $$('button', g).forEach((b) => { b.onclick = () => {
      const v = Number(b.dataset.v); const k = g.dataset.r;
      if (k === 'overall') overall = v; else if (k === 'sign') signs = v === 1; else ratings[k] = v;
      $$('button', g).forEach((x) => x.classList.toggle('on', x === b));
    }; }));
    const drawErrs = () => { $('#errs').innerHTML = errors.length ? errors.map((e, i) => `<div class="err-item"><div class="grow">${pill(e.severity, e.severity === 'major' ? 'bad' : 'warn')} ${pill(e.kind === 'omission' ? 'missing' : 'wrong')} <small class="hint">${esc(SUBLABEL[e.subtype] || e.subtype)} · ${esc(e.section)}</small><div>${esc(e.text)}</div></div><button class="btn sm danger" data-i="${i}">Remove</button></div>`).join('') : '<p class="hint">No flags yet.</p>'; $$('#errs [data-i]').forEach((b) => { b.onclick = () => { errors.splice(Number(b.dataset.i), 1); drawErrs(); }; }); };
    drawErrs();
    const fillSub = () => { $('#e-sub').innerHTML = SUBTYPES[$('#e-kind').value].map((s) => `<option value="${s}">${esc(SUBLABEL[s])}</option>`).join(''); }; fillSub(); $('#e-kind').onchange = fillSub;
    $('#e-add').onclick = () => { const text = $('#e-text').value.trim(); if (!text) return toast('Paste or type the line first', true); errors.push({ kind: $('#e-kind').value, subtype: $('#e-sub').value, severity: $('#e-sev').value, section: $('#e-sec').value, text }); $('#e-text').value = ''; drawErrs(); };
    $('#save').onclick = (ev) => busy(ev.currentTarget, 'Saving…', async () => {
      const prev = review?.comment || '';
      const r = await studio(`/items/${id}/review`, { method: 'POST', json: { ratings, overall, would_sign: signs, errors, comment: $('#comment').value, prev_comment: prev, edited_text: review?.edited_text || null } });
      review = { ...(review || {}), ratings, overall, would_sign: signs, errors, comment: $('#comment').value, updated_at: new Date().toISOString() };
      toast('Saved. Thank you.'); $('#saved').textContent = 'Saved just now'; if (!d.review) rateTab();
    });
  }

  // ── tab: edit the note ──
  function editTab() {
    $('#tab').innerHTML = `<div class="card"><h3>Edit the note the way you want it</h3><p class="hint">Change anything. Notera compares your version with its own, and turns the pattern of your edits into suggested style rules for the team to review. The note in the app is not changed.</p>
      <textarea id="edited" style="min-height:420px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px">${esc(review?.edited_text || it.rendered)}</textarea>
      <div style="margin-top:10px"><button class="btn primary" id="save-edit">Save my edited version</button> <button class="btn" id="reset-edit">Reset to the original</button> <span class="hint" id="edit-res"></span></div></div>`;
    $('#reset-edit').onclick = () => { $('#edited').value = it.rendered; };
    $('#save-edit').onclick = (ev) => busy(ev.currentTarget, 'Comparing…', async () => {
      const r = await studio(`/items/${id}/review`, { method: 'POST', json: { ratings, overall, would_sign: signs, errors, comment: review?.comment || '', prev_comment: review?.comment || '', edited_text: $('#edited').value } });
      review = { ...(review || {}), edited_text: $('#edited').value, edit_diff: r.edit_diff, updated_at: new Date().toISOString() };
      const df = r.edit_diff; $('#edit-res').textContent = df ? `${df.removed.length} lines removed, ${df.added.length} added, ${df.reworded.length} reworded. ${r.inferred_proposals} style suggestion(s) created.` : 'No difference from the original.'; toast('Saved');
    });
  }

  // ── tab: Teach Notera ──
  function teachTab() {
    const last = (d.teach || [])[0];
    $('#tab').innerHTML = `<div class="card"><h3>Teach Notera</h3><p>Notera looks at this note and asks you a few short questions about how you would like it written. Your answers become <b>proposed rules</b> for the team; they never change the app on their own.</p>
      <button class="btn primary" id="t-start">${last && last.status === 'open' ? 'Continue the interview' : 'Start a new interview'}</button><div id="t-body" style="margin-top:14px"></div></div>`;
    const render = (sess) => {
      $('#t-body').innerHTML = sess.questions.map((q, qi) => `<div class="q" data-q="${esc(q.id)}"><div class="hint">${esc(q.section)} · question ${qi + 1}</div><p><b>${esc(q.question)}</b></p>${q.evidence ? `<div class="ev">“${esc(q.evidence)}”</div>` : ''}
        ${q.options.map((o) => `<label class="opt"><input type="radio" name="o-${esc(q.id)}" value="${esc(o.id)}"><span><b>${esc(o.label)}</b>${o.meaning ? `<br><small class="hint">${esc(o.meaning)}</small>` : ''}</span></label>`).join('')}
        <label class="lbl" style="margin-top:8px">Or in your own words<textarea style="min-height:56px" data-t="${esc(q.id)}"></textarea></label></div>`).join('') + '<button class="btn primary" id="t-send">Send my answers</button><div id="t-out"></div>';
      $('#t-send').onclick = (ev) => busy(ev.currentTarget, 'Turning your answers into rules…', async () => {
        const answers = {}; for (const q of sess.questions) { const opt = $(`input[name="o-${q.id}"]:checked`)?.value; const text = $(`[data-t="${q.id}"]`)?.value.trim(); if (opt || text) answers[q.id] = { option: opt || '', text: text || '' }; }
        if (!Object.keys(answers).length) return toast('Answer at least one question', true);
        const r = await studio(`/teach/${sess.id}/answer`, { method: 'POST', json: { answers } });
        $('#t-out').innerHTML = `<div class="sep"></div><h3>Thank you — ${r.proposals.length} proposed rule(s)</h3>${r.proposals.map((p) => `<div class="prop"><b>${esc(p.title)}</b> ${pill(p.section)}<br>${esc(p.rule)}${p.replaces ? `<br><small class="hint">replaces rule ${esc(p.replaces)}</small>` : ''}</div>`).join('') || '<p class="hint">No change was proposed (everything was “keep as is”).</p>'}`;
        toast('Sent to the team');
      });
    };
    $('#t-start').onclick = (ev) => busy(ev.currentTarget, 'Preparing questions (about 30 seconds)…', async () => { const s = await studio(`/items/${id}/teach`, { method: 'POST', json: { fresh: !(last && last.status === 'open') } }); render(s); });
    if (last && last.status === 'open') render({ id: last.id, questions: last.questions });
  }

  // ── tab: AI review and style check ──
  function aiTab() {
    const a = it.auto_eval; const c = it.conformance; const ev = it.evidence;
    const rules = (c?.failed || []);
    $('#tab').innerHTML = `<div class="two">
      <div class="card"><h3>Style check (Style Spec v1) ${c ? pill(`${Math.round(c.score * 100)}%`, scoreTone(c.score)) : ''}</h3>
        ${c ? (rules.length ? rules.map((f) => `<div class="err-item"><div>${pill(f.rule, f.severity === 'major' ? 'bad' : 'warn')} <small class="hint">${esc(f.section)}</small><div>${esc(f.detail || '')}</div></div></div>`).join('') : '<p>Every style rule is met.</p>') : '<p class="hint">Not checked yet.</p>'}
        <p class="hint" style="margin-top:10px">${c ? `${c.passed} of ${c.checks} checks passed.` : ''}</p></div>
      <div class="card"><h3>AI reviewer ${a?.overall ? pill(`${a.overall}/5`, a.overall >= 4 ? 'ok' : 'warn') : ''}</h3>
        ${a?.error ? `<p class="err">${esc(a.error)}</p>` : a ? `<p>${esc(a.summary || '')}</p>${a.would_sign != null ? `<p>Would sign: ${pill(a.would_sign ? 'yes' : 'no', a.would_sign ? 'ok' : 'bad')}</p>` : ''}
          ${(a.errors || []).map((e) => `<div class="err-item"><div>${pill(e.severity, e.severity === 'major' ? 'bad' : 'warn')} ${pill(e.kind === 'omission' ? 'missing' : 'wrong')} <small class="hint">${esc(e.section)}</small><div>${esc(e.text)}</div><small class="hint">${esc(e.why)}</small></div></div>`).join('') || '<p class="hint">No errors found.</p>'}` : '<p class="hint">Press “Run AI review”.</p>'}
        ${ev?.summary ? `<div class="sep"></div><p class="hint">Evidence: ${ev.summary.supported} supported, ${ev.summary.partial} partial, ${ev.summary.unsupported} not found, ${ev.summary.unverified} unverified.</p>` : ''}</div></div>`;
  }
  switchTab('rate');
}
