// The Style Interview screens (every invited account) and the owner's interview views.
import { $, $$, esc, when, studio, toast, busy, pill, head, S } from './kit.js';

const TONE = { new: '', open: 'acc', submitted: 'ok' };
const ST = { new: 'Not started', open: 'In progress', submitted: 'Submitted' };

// ───────── home: the three parts ─────────
export async function interviewHome(root) {
  const d = await studio('/interview'); const done = d.parts.filter((p) => p.status === 'submitted').length;
  root.innerHTML = head('Notera Style Interview', 'A long, detailed interview about exactly how you want your notes written. Your answers are saved as you go — stop and come back any time.', pill(`${done} of 3 parts submitted`, done === 3 ? 'ok' : 'acc')) + `
    <div class="card" style="margin-bottom:14px"><p>Three parts, each detailed. <b>Part 3 is the defining part</b>: your priorities, your hard rules, your perfect note, and a rule-by-rule review of the format approved today. Afterwards Notera writes a <b>style profile</b> of you and asks you to confirm it.</p>
      <p class="hint">Nothing you answer changes how Notera writes notes today. Your answers are stored, and the team uses them later to improve the system with you.</p></div>
    <div class="cards">${d.parts.map((p) => `<div class="card"><div class="hint">Part ${p.part} · about ${p.minutes} minutes</div><h3 style="margin:4px 0 6px">${esc(p.title)} ${p.part === 3 ? pill('defining', 'acc') : ''}</h3><p class="hint">${esc(p.intro)}</p>
      <p>${pill(ST[p.status], TONE[p.status])} <span class="hint">${p.answered} of ${p.total} answered${p.required_left ? ` · ${p.required_left} required left` : ''}</span></p>
      <div class="bar"><i style="width:${p.total ? Math.round((p.answered / p.total) * 100) : 0}%"></i></div>
      <div style="margin-top:12px">${p.locked ? '<span class="hint">Opens after the previous part is submitted.</span>' : `<a class="btn ${p.status === 'submitted' ? '' : 'primary'}" href="#/interview/part/${p.part}">${p.status === 'new' ? 'Start' : p.status === 'open' ? 'Continue' : 'Review answers'}</a>`}</div></div>`).join('')}</div>
    ${d.parts[2].status === 'submitted' ? `<div class="card" style="margin-top:14px"><h3>Your style profile</h3>${d.profile ? `<p>${pill(d.profile.status === 'confirmed' ? 'Confirmed' : 'Waiting for your confirmation', d.profile.status === 'confirmed' ? 'ok' : 'warn')} <span class="hint">version ${d.profile.version} · ${esc(when(d.profile.created_at))}</span></p><a class="btn primary" href="#/interview/profile">${d.profile.status === 'confirmed' ? 'View my profile' : 'Review and confirm'}</a>` : `<p class="hint">The profile has not been built yet.</p><button class="btn primary" id="mkp">Build my profile</button>`}</div>` : ''}`;
  $('#mkp')?.addEventListener('click', (e) => busy(e.currentTarget, 'Building your profile (about a minute)…', async () => { await studio('/interview/profile/rebuild', { method: 'POST', json: {} }); location.hash = '#/interview/profile'; }));
}

// ───────── one part: the long form with autosave ─────────
export async function interviewPart(root, n) {
  const v = await studio('/interview/part/' + n); const answers = { ...v.answers }; const dirty = {}; let timer = 0; const locked = v.status === 'submitted';
  const groups = []; for (const q of v.questions) { let g = groups.find((x) => x.name === q.group); if (!g) groups.push((g = { name: q.group || '', qs: [] })); g.qs.push(q); }
  const count = () => { const total = v.questions.length; const a = v.questions.filter((q) => answers[q.id] != null).length; const req = v.questions.filter((q) => q.required && answers[q.id] == null).length; return { total, a, req }; };

  const qHtml = (q, i) => {
    const a = answers[q.id]; const choice = typeof a === 'object' && a && !Array.isArray(a) ? a.choice : a; const note = typeof a === 'object' && a && !Array.isArray(a) ? (a.note || '') : '';
    let body = '';
    if (q.type === 'text') body = `<textarea data-q="${esc(q.id)}" style="min-height:${q.long ? 160 : 80}px" placeholder="${esc(q.placeholder || '')}" ${locked ? 'disabled' : ''}>${esc(a || '')}</textarea>`;
    else if (q.type === 'scale') body = `<div class="scale"><span class="hint">${esc(q.labels?.[0] || '1')}</span><div class="stars" data-q="${esc(q.id)}">${[1, 2, 3, 4, 5].map((k) => `<button type="button" data-v="${k}" class="${a === k ? 'on' : ''}" ${locked ? 'disabled' : ''}>${k}</button>`).join('')}</div><span class="hint">${esc(q.labels?.[1] || '5')}</span></div>`;
    else if (q.type === 'single' || q.type === 'compare') body = (q.options || []).map((o) => `<label class="opt"><input type="radio" name="o-${esc(q.id)}" value="${esc(o.id)}" ${choice === o.id ? 'checked' : ''} ${locked ? 'disabled' : ''}><span><b>${esc(o.label)}</b>${o.example ? `<pre class="ex">${esc(o.example)}</pre>` : ''}</span></label>`).join('');
    else if (q.type === 'multi') { const sel = Array.isArray(a) ? a : (a?.choices || []); body = (q.options || []).map((o) => `<label class="opt"><input type="checkbox" data-m="${esc(q.id)}" value="${esc(o.id)}" ${sel.includes(o.id) ? 'checked' : ''} ${locked ? 'disabled' : ''}><span>${esc(o.label)}</span></label>`).join(''); }
    else if (q.type === 'rank') { const order = Array.isArray(a) ? a : (q.options || []).map((o) => o.id); body = `<ol class="rank" data-q="${esc(q.id)}">${order.map((id) => `<li data-id="${esc(id)}"><span>${esc(q.options.find((o) => o.id === id)?.label || id)}</span>${locked ? '' : '<button type="button" class="btn sm" data-up>▲</button><button type="button" class="btn sm" data-down>▼</button>'}</li>`).join('')}</ol><p class="hint">${Array.isArray(a) ? 'Order saved.' : 'Move items up or down; the order is saved when you change it.'}</p>`; }
    const wantNote = q.followup && q.type === 'single' && q.followup.when.includes(choice);
    const noteBox = (q.type === 'single' || q.type === 'multi' || q.type === 'compare') ? `<textarea class="qn" data-n="${esc(q.id)}" style="min-height:52px;${wantNote || note ? '' : 'display:none'}" placeholder="${esc(q.followup?.prompt || 'Add a comment (optional)')}" ${locked ? 'disabled' : ''}>${esc(note)}</textarea>${q.followup ? '' : `<a href="#" class="hint" data-addn="${esc(q.id)}" style="${note ? 'display:none' : ''}">Add a comment</a>`}` : '';
    return `<div class="q" id="q-${esc(q.id)}" data-qid="${esc(q.id)}"><div class="hint">Question ${i}${q.required ? ' · required' : ''}</div><p><b>${esc(q.prompt)}</b></p>${q.help ? `<p class="hint">${esc(q.help)}</p>` : ''}${body}${noteBox}</div>`;
  };
  let idx = 0;
  root.innerHTML = `<div class="head"><div><a href="#/interview" class="hint">← Back to the interview</a><h2>Part ${n}: ${esc(v.title)} ${n === 3 ? pill('the defining part', 'acc') : ''}</h2><p>${esc(v.intro)}</p></div></div>
    <div class="sticky"><div class="bar"><i id="pbar"></i></div><div class="hint" id="pinfo"></div><div class="hint" id="saved"></div></div>
    ${locked ? `<div class="card pop" style="margin-bottom:12px">This part is submitted. <button class="btn sm" id="reopen">Reopen to edit</button></div>` : ''}
    ${groups.map((g) => `<h3 class="grp">${esc(g.name)}</h3>${g.qs.map((q) => qHtml(q, ++idx)).join('')}`).join('')}
    <div class="card" style="margin-top:14px">${locked ? '' : `<button class="btn primary" id="submit">${n === 3 ? 'Submit the defining part' : `Submit Part ${n}`}</button> `}<a class="btn" href="#/interview">${locked ? 'Back' : 'Save and finish later'}</a><span class="hint" id="subres"></span></div>`;

  const progress = () => { const c = count(); $('#pbar').style.width = `${Math.round((c.a / c.total) * 100)}%`; $('#pinfo').textContent = `${c.a} of ${c.total} answered${c.req ? ` · ${c.req} required still to answer` : ' · all required questions answered'}`; };
  progress();
  const flush = async () => {
    const body = { ...dirty }; for (const k of Object.keys(dirty)) delete dirty[k]; if (!Object.keys(body).length) return;
    $('#saved').textContent = 'Saving…';
    try { const r = await studio(`/interview/part/${n}/answers`, { method: 'PUT', json: { answers: body } }); $('#saved').textContent = `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; if (Object.keys(r.rejected || {}).length) toast('Some answers were not accepted: ' + Object.values(r.rejected).join(', '), true); }
    catch (e) { Object.assign(dirty, body); $('#saved').textContent = 'Not saved — ' + e.message; }
  };
  const set = (id, val) => { if (val == null || val === '' || (Array.isArray(val) && !val.length)) delete answers[id]; else answers[id] = val; dirty[id] = val == null ? '' : val; progress(); clearTimeout(timer); timer = setTimeout(flush, 1100); };
  const q = (id) => v.questions.find((x) => x.id === id);
  const withNote = (id, base) => { const note = $(`[data-n="${id}"]`)?.value.trim(); return note && base != null ? (Array.isArray(base) ? { choices: base, note } : { choice: base, note }) : base; };
  if (!locked) {
    $$('textarea[data-q]').forEach((t) => { t.oninput = () => set(t.dataset.q, t.value.trim() ? t.value : null); });
    $$('.stars[data-q] button').forEach((b) => { b.onclick = () => { const g = b.parentElement; $$('button', g).forEach((x) => x.classList.toggle('on', x === b)); set(g.dataset.q, Number(b.dataset.v)); }; });
    $$('input[type=radio]').forEach((r) => { r.onchange = () => { const id = r.name.slice(2); const qq = q(id); if (qq?.followup) $(`[data-n="${id}"]`).style.display = qq.followup.when.includes(r.value) ? '' : 'none'; set(id, withNote(id, r.value)); }; });
    $$('input[data-m]').forEach((c) => { c.onchange = () => { const id = c.dataset.m; const sel = $$(`input[data-m="${id}"]:checked`).map((x) => x.value); set(id, sel.length ? withNote(id, sel) : null); }; });
    $$('textarea[data-n]').forEach((t) => { t.oninput = () => { const id = t.dataset.n; const qq = q(id); let base = null; if (qq.type === 'multi') { const sel = $$(`input[data-m="${id}"]:checked`).map((x) => x.value); base = sel.length ? sel : null; } else base = $(`input[name="o-${id}"]:checked`)?.value || null; if (base != null) set(id, withNote(id, base)); }; });
    $$('[data-addn]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); $(`[data-n="${a.dataset.addn}"]`).style.display = ''; a.style.display = 'none'; }; });
    $$('ol.rank').forEach((ol) => { ol.onclick = (e) => { const li = e.target.closest('li'); if (!li || !(e.target.matches('[data-up]') || e.target.matches('[data-down]'))) return; if (e.target.matches('[data-up]') && li.previousElementSibling) ol.insertBefore(li, li.previousElementSibling); else if (e.target.matches('[data-down]') && li.nextElementSibling) ol.insertBefore(li.nextElementSibling, li); set(ol.dataset.q, $$('li', ol).map((x) => x.dataset.id)); }; });
    $('#submit').onclick = (e) => busy(e.currentTarget, n === 3 ? 'Submitting and building your profile (about a minute)…' : 'Submitting…', async () => {
      clearTimeout(timer); await flush();
      try {
        const r = await studio(`/interview/part/${n}/submit`, { method: 'POST', json: {} });
        if (n < 3) { toast(`Part ${n} submitted${r.followups ? ` — ${r.followups} follow-up questions were added to Part ${n + 1}, based on your answers` : ''}`); location.hash = '#/interview'; }
        else { toast('Thank you — your profile is ready to review'); location.hash = r.profile_id ? '#/interview/profile' : '#/interview'; }
      } catch (err) {
        if (err.message && /required/.test(err.message)) { const m = await studio(`/interview/part/${n}`); const first = m.questions.find((x) => x.required && m.answers[x.id] == null); toast(err.message, true); if (first) { const el = $('#q-' + CSS.escape(first.id)); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); el?.classList.add('miss'); $$('.q').forEach((x) => { const qq = q(x.dataset.qid); if (qq?.required && answers[qq.id] == null) x.classList.add('miss'); }); } } else toast(err.message, true);
      }
    });
  } else $('#reopen').onclick = (e) => busy(e.currentTarget, 'Reopening…', async () => { await studio(`/interview/part/${n}/reopen`, { method: 'POST', json: {} }); interviewPart(root, n); });
}

// ───────── the style profile: she confirms how Notera understood her ─────────
export async function profileView(root) {
  const { profile: p } = await studio('/interview/profile');
  if (!p) { root.innerHTML = head('Your style profile', '') + '<div class="card empty">No profile yet. Submit Part 3 first.</div>'; return; }
  const pr = p.profile; const conf = p.confirmations?.items || {}; const done = p.status === 'confirmed'; const T = { subjective: 'Subjective', past_medical_history: 'Past Medical History', objective: 'Objective', assessment_and_plan: 'Assessment & Plan', language: 'Language', general: 'General' };
  root.innerHTML = head('How Notera understood you', done ? 'You confirmed this profile. It is stored with your interview.' : 'Read each statement. Tell us if it is right. This is the last step of the defining part.', pill(done ? 'Confirmed' : 'Please confirm', done ? 'ok' : 'warn')) + `
    <div class="card"><p>${esc(pr.summary)}</p>${pr.priorities?.length ? `<p class="hint">What matters most to you, in order:</p><ol>${pr.priorities.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}</div>
    ${Object.entries(pr.sections || {}).filter(([, a]) => a.length).map(([k, arr]) => `<div class="card" style="margin-top:12px"><h3>${esc(T[k] || k)}</h3>${arr.map((r) => { const c = conf[r.id]?.verdict || ''; return `<div class="stmt" data-id="${esc(r.id)}"><div class="grow">${esc(r.text)} ${r.confidence === 'low' ? pill('not sure', 'warn') : ''}</div>${done ? pill(c === 'agree' ? 'agreed' : c ? (c === 'wrong' ? 'wrong' : 'not quite') : '—', c === 'agree' ? 'ok' : c ? 'warn' : '') : `<div class="stars"><button data-v="agree" type="button">Right</button><button data-v="not_quite" type="button">Not quite</button><button data-v="wrong" type="button">Wrong</button></div>`}</div>${!done ? `<textarea class="fix" data-fix="${esc(r.id)}" style="display:none;min-height:48px" placeholder="What is the correct version?"></textarea>` : (conf[r.id]?.text ? `<p class="hint">Your correction: ${esc(conf[r.id].text)}</p>` : '')}`; }).join('')}</div>`).join('')}
    ${pr.hard_rules?.length ? `<div class="card" style="margin-top:12px"><h3>Your hard rules</h3><ul>${pr.hard_rules.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${pr.contradictions?.length ? `<div class="card" style="margin-top:12px"><h3>Where your answers pulled in different directions</h3><ul>${pr.contradictions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${!done ? `<div class="card" style="margin-top:12px"><label class="lbl">Anything important that is missing or wrong?<textarea id="missing" style="min-height:90px"></textarea></label><button class="btn primary" id="confirm">Confirm my profile</button></div>` : ''}
    <p style="margin-top:14px"><a href="#/interview">← Back to the interview</a></p>`;
  if (!done) {
    const verdicts = {};
    $$('.stmt').forEach((row) => { $$('button', row).forEach((b) => { b.onclick = () => { verdicts[row.dataset.id] = b.dataset.v; $$('button', row).forEach((x) => x.classList.toggle('on', x === b)); $(`[data-fix="${row.dataset.id}"]`).style.display = b.dataset.v === 'agree' ? 'none' : ''; }; }); });
    $('#confirm').onclick = (e) => busy(e.currentTarget, 'Saving…', async () => {
      const confirmations = {}; for (const [id, verdict] of Object.entries(verdicts)) confirmations[id] = { verdict, text: $(`[data-fix="${id}"]`)?.value || '' }; confirmations._missing = $('#missing').value;
      await studio('/interview/profile/confirm', { method: 'POST', json: { confirmations } }); toast('Thank you. Your profile is confirmed.'); profileView(root);
    });
  }
}

// ───────── owner: everyone's progress, answers, export, cross-doctor view ─────────
export async function interviewsAdmin(root) {
  const { people } = await studio('/interviews');
  root.innerHTML = head('Style interviews', 'Every invited account. Existing accounts were invited automatically; self sign-ups and later accounts are not.', '<a class="btn" href="#/interviews/compare">Compare doctors</a>') + `
    <div class="card"><table><thead><tr><th>Person</th><th>Invited as</th><th>Part 1</th><th>Part 2</th><th>Part 3 (defining)</th><th>Profile</th><th></th></tr></thead><tbody>${people.map((p) => `<tr><td><b>${esc(p.full_name || p.user_id.slice(0, 8))}</b>${p.active ? '' : ' ' + pill('off')}</td><td><small class="hint">${esc(p.source)}</small></td>
      ${p.parts.map((x) => `<td>${pill(ST[x.status], TONE[x.status])}<br><small class="hint">${x.answered}/${x.total}</small></td>`).join('') || '<td colspan="3"><small class="hint">not started</small></td>'}
      <td>${p.profile ? pill(p.profile.status === 'confirmed' ? 'confirmed' : 'draft', p.profile.status === 'confirmed' ? 'ok' : 'warn') : '—'}</td><td><a class="btn sm" href="#/interviews/person/${esc(p.user_id)}">Open</a></td></tr>`).join('')}</tbody></table></div>
    <div class="card" style="margin-top:14px"><h3>Invite another account</h3><p class="hint">For example an account that signed up on its own.</p><div class="two"><input id="iv-email" type="email" placeholder="account email"><button class="btn" id="iv-add">Invite</button></div></div>`;
  $('#iv-add').onclick = (e) => busy(e.currentTarget, 'Inviting…', async () => { const r = await studio('/interviewees', { method: 'POST', json: { email: $('#iv-email').value.trim() } }); toast(`${r.full_name || 'Account'} invited`); interviewsAdmin(root); });
}

export async function personView(root, id) {
  const d = await studio('/interviews/' + id); let part = 0, grp = '';
  root.innerHTML = head(d.who.full_name || 'Interview', 'All answers, exactly as given.', `<a class="btn" href="/studio/interviews/${esc(id)}/export?format=md">Download (Markdown)</a> <a class="btn" href="/studio/interviews/${esc(id)}/export?format=json">Download (JSON)</a>`) + `
    <p><a href="#/interviews">← All interviews</a></p><div class="cards">${d.progress.map((p) => `<div class="card kpi"><b>${p.answered}/${p.total}</b><span>Part ${p.part} · ${ST[p.status]}</span></div>`).join('')}</div>
    ${d.profile ? `<div class="card"><h3>Style profile ${pill(d.profile.status, d.profile.status === 'confirmed' ? 'ok' : 'warn')}</h3><pre class="ex" style="white-space:pre-wrap">${esc(d.profile.markdown)}</pre></div>` : ''}
    <div class="card" style="margin-top:14px">${d.answers.map((a) => { let h = ''; if (a.part !== part || a.group !== grp) { part = a.part; grp = a.group; h = `<h3 class="grp">Part ${a.part} · ${esc(a.group || '')}</h3>`; } return `${h}<div class="q"><div><b>${esc(a.prompt)}</b></div><div style="white-space:pre-wrap">${esc(a.answer)}</div></div>`; }).join('') || '<p class="hint">No answers yet.</p>'}</div>`;
}

export async function compareView(root) {
  const { synthesis: s0 } = await studio('/interviews/synthesis'); const render = (s) => {
    $('#cmp').innerHTML = !s ? '<p class="hint">No comparison yet.</p>' : `<p class="hint">${s.people} submitted interview(s) · ${esc(when(s.created_at || s.at))}</p>
      ${s.narrative ? ['agreements', 'conflicts', 'surprises', 'recommended_shared_rules', 'personal_variations'].map((k) => (s.narrative[k] || []).length ? `<div class="card" style="margin-bottom:10px"><h3>${esc({ agreements: 'Where they agree', conflicts: 'Where they disagree', surprises: 'Surprises', recommended_shared_rules: 'Rules most would accept', personal_variations: 'Should stay personal' }[k])}</h3><ul>${s.narrative[k].map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '').join('') : (s.narrative_error ? `<p class="err">${esc(s.narrative_error)}</p>` : '')}
      <div class="card"><h3>Every choice question</h3>${s.questions.map((d) => `<div class="q"><div class="hint">${esc(d.id)} · ${d.n} answer(s)</div><b>${esc(d.prompt)}</b>${Object.entries(d.counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="hbar"><span>${esc(k)}</span><i style="width:${Math.round((v / d.n) * 100)}%"></i><em>${v}</em></div>`).join('')}</div>`).join('')}</div>`;
  };
  root.innerHTML = head('Compare doctors', 'How the invited doctors answered, and where they agree or differ.', '<button class="btn primary" id="mk">Update the comparison</button>') + '<p><a href="#/interviews">← All interviews</a></p><div id="cmp"></div>'; render(s0);
  $('#mk').onclick = (e) => busy(e.currentTarget, 'Comparing (about a minute)…', async () => { const r = await studio('/interviews/synthesis', { method: 'POST', json: {} }); render(r.synthesis); });
}
