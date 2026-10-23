// SUPER RUN: pick a stored recording and watch it go through the whole chain, one step at a time.
//   1 Transcribe: the same audio goes to two speech models at once (Chirp 2 and Gemini 2.5 Flash)
//   2 Compare:    a reviewer agent listens to the recording and checks both transcripts (scores, disagreements, a winner)
//   3 SOAP note:  the note is written from the chosen transcript, shown section by section, then audited, then one consolidated statement
// Nothing starts by itself after the first step: each "Next" starts the next one, with a loader while it works. Past steps fold into a short summary
// you can open again. All work happens in the lab service; the page only starts steps and polls their state.
import { lab } from './kit.js';

export async function superRunView(ctx) {
  const { $, esc, ago, head, toast, api } = ctx;
  let run = null; let recs = []; let poll = null; let pick = ''; let player = null;
  const ui = { openStep: null, transcript: false, showFull: {}, use: 'winner' };
  const mmss = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
  const pct = (v) => (v == null ? '—' : Math.round(v) + '%');
  const usd = (v) => (v == null ? '—' : '$' + (v < 0.01 ? v.toFixed(4) : v.toFixed(3)));
  const spin = '<span class="sr-spin" aria-hidden="true"></span>';
  const elapsed = (t) => (t ? Math.max(0, Math.round((Date.now() - new Date(t)) / 1000)) : 0);
  const winLabel = (c) => (c?.winner === 'A' ? 'Chirp 2' : c?.winner === 'B' ? 'Gemini 2.5 Flash' : 'neither (a tie)');

  $('#view').innerHTML = head('Super run', 'One recording through the whole chain: two speech models, a reviewer that listens, the SOAP note, and the audit.',
    '<button class="btn" id="sr-past">Past runs</button><button class="btn" id="sr-new">New run</button>') + '<div id="sr-steps"></div><div id="sr-stack"></div><div id="sr-past-box"></div>';
  $('#sr-new').onclick = () => reset(); $('#sr-past').onclick = pastRuns;

  function reset() { stopPoll(); run = null; ui.openStep = null; ui.transcript = false; ui.showFull = {}; ui.use = 'winner'; draw(); }
  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }
  function running() { return run && ['asr', 'compare', 'note', 'audit'].some((k) => run[k]?.status === 'running'); }
  function startPoll() {
    stopPoll(); poll = setInterval(async () => {
      if (!document.getElementById('sr-stack')) return stopPoll();   // the admin left this page
      try { run = await lab('/superrun/' + run.id); } catch { return; }
      draw(); if (!running()) stopPoll();
    }, 1500);
  }
  async function start(id) { try { run = await lab('/superrun', { method: 'POST', json: { consultId: id } }); ui.openStep = null; draw(); startPoll(); } catch (e) { toast(e.message, true); } }
  async function step(name, body) { try { run = await lab(`/superrun/${run.id}/${name}`, { method: 'POST', json: body || {} }); ui.openStep = null; draw(); startPoll(); } catch (e) { toast(e.message, true); } }

  // which step is in front: 1 until Compare was pressed, 2 until Create note was pressed, then 3
  function active() { if (!run) return 1; if (run.note.status !== 'idle' || run.audit.status !== 'idle') return 3; if (run.compare.status !== 'idle') return 2; return 1; }
  const state = (k) => (!run ? 'idle' : run[k]?.status || 'idle');

  function stepper() {
    const a = active(); const items = [[1, 'Transcribe', 'two speech models', state('asr')], [2, 'Compare', 'a reviewer listens', state('compare')], [3, 'SOAP note & audit', 'write, then check', state('audit') !== 'idle' ? state('audit') : state('note')]];
    $('#sr-steps').innerHTML = `<div class="sr-stepper">${items.map(([n, t, s, st]) => `<div class="sr-node ${st} ${a === n ? 'cur' : ''} ${a > n || st === 'done' ? 'past' : ''}"><span class="sr-dot">${st === 'running' ? spin : st === 'done' ? '✓' : st === 'error' ? '!' : n}</span><div><b>${t}</b><small>${s}</small></div></div>`).join('<div class="sr-link"></div>')}</div>`;
  }

  function engineBox(key) {
    const e = run?.asr?.engines?.[key]; const info = key === 'chirp' ? ['Chirp 2', 'Google Speech-to-Text, with the medical vocabulary'] : ['Gemini 2.5 Flash', 'Google Gemini audio transcription'];
    if (!e) return `<div class="sr-eng"><h4>${info[0]}</h4><small>${info[1]}</small><div class="sr-wait">Waiting to start</div></div>`;
    const m = e.metrics; const full = ui.showFull[key]; const tx = e.text || '';
    return `<div class="sr-eng ${e.status}"><h4>${esc(e.label || info[0])}</h4><small>${esc(e.detail || info[1])}</small>
      ${e.status === 'running' ? `<div class="sr-wait">${spin} Listening… ${elapsed(run.asr.startedAt)} s</div><div class="sr-shim"></div>` : e.status === 'waiting' ? '<div class="sr-wait">Waiting to start</div>'
      : e.status === 'error' ? `<div class="sr-err">${esc(e.error)}</div>`
      : `<div class="sr-chips"><span>${m.words} words</span><span>${m.wpm ?? '—'} a minute</span><span>${m.seconds} s</span><span>${m.speedX ?? '—'}× real time</span><span>${usd(m.costUsd)}</span><span>${m.medicalTerms} medical terms</span></div>
         ${e.note ? `<p class="hint" style="color:var(--warn)">Note: ${esc(e.note)}</p>` : ''}<div class="sr-tx${full ? ' full' : ''}">${esc(tx)}</div><button class="btn sm" data-full="${key}">${full ? 'Show less' : 'Show all'}</button>`}</div>`;
  }

  function card1() {
    if (!run) {
      return `<div class="sr-body"><h3>Choose a recording</h3><p class="hint">Every stored recording. Pick one, listen if you like, then send it to both speech models.</p>
        <div class="sr-pick"><select class="select" id="sr-sel"><option value="">Select a recording…</option>${recs.map((r) => `<option value="${esc(r.id)}"${r.id === pick ? ' selected' : ''}${r.damaged ? ' disabled' : ''}>${esc(r.name)}${r.status === 'real' ? ' ✓ real' : r.status === 'not_real' ? ' ✗ not real' : ''}${r.damaged ? ' (damaged file)' : ''}</option>`).join('')}</select>
        <button class="btn" id="sr-listen" ${pick ? '' : 'disabled'}>▶ Listen</button><button class="btn primary" id="sr-go" ${pick ? '' : 'disabled'}>Run both models</button></div><div id="sr-aud"></div>
        ${recs.length ? '' : '<div class="empty">No recordings are stored yet.</div>'}</div>`;
    }
    const a = run.asr; const sp = a.agreement?.spans || [];
    return `<div class="sr-body"><div class="sr-rec"><b>${esc(run.name)}</b><span class="hint">${run.durationS ? mmss(run.durationS) + ' of audio · ' : ''}started ${ago(run.createdAt)}</span></div>
      ${a.status === 'running' && a.stage ? `<div class="sr-stage">${spin} ${esc(a.stage)}…</div>` : ''}
      <div class="sr-two">${engineBox('chirp')}${engineBox('gemini')}</div>
      ${a.status === 'error' ? `<div class="sr-err">${esc(a.error)}</div>` : ''}
      ${a.status === 'done' ? `<div class="sr-diff"><h4>Where they differ</h4><p class="hint">They agree on <b>${pct(a.agreement.sharedPct)}</b> of the words. ${a.agreement.differences} difference${a.agreement.differences === 1 ? '' : 's'}, ${a.agreement.medicalDifferences} with a medical term.</p>
        ${sp.length ? `<div class="tbl-wrap"><table><thead><tr><th>Chirp 2 heard</th><th>Gemini 2.5 Flash heard</th><th></th></tr></thead><tbody>${sp.slice(0, 12).map((s) => `<tr><td>${esc(s.a) || '<span class="hint">nothing</span>'}</td><td>${esc(s.b) || '<span class="hint">nothing</span>'}</td><td>${s.medical ? '<span class="pill warn">medical</span>' : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">The two transcripts are identical.</div>'}</div>` : ''}
      ${a.status === 'done' && run.compare.status === 'idle' ? '<div class="sr-next"><button class="btn primary" id="sr-next1">Next: compare the transcripts ▸</button></div>' : ''}</div>`;
  }

  function bars(label, A, B) {
    const row = (v, cls) => `<div class="sr-bar"><i class="${cls}" style="width:${Math.max(2, v || 0)}%"></i><span>${v ?? '—'}</span></div>`;
    return `<tr><td>${label}</td><td>${row(A, 'a')}</td><td>${row(B, 'b')}</td></tr>`;
  }
  function card2() {
    const c = run.compare; const r = c.result;
    if (c.status === 'idle') return '<div class="sr-body"><p class="hint">The reviewer compares the two transcripts once the first step is finished.</p></div>';
    if (c.status === 'running') return `<div class="sr-body sr-loading">${spin}<div><h3>Comparing the transcripts</h3><p class="hint">${esc(c.stage || 'Working')}… ${elapsed(c.startedAt)} s</p><p class="hint">A reviewer model (Gemini 2.5 Pro) listens to the recording and checks both transcripts against what was actually said.</p></div></div><div class="sr-shim big"></div>`;
    if (c.status === 'error') return `<div class="sr-body"><div class="sr-err">${esc(c.error)}</div><div class="sr-next"><button class="btn primary" id="sr-retry2">Try again</button></div></div>`;
    const s = r.scores || {}; const win = winLabel(r); const conf = r.confidence || 'unknown';
    const dis = (r.disagreements || []).slice(0, 12); const lst = (t, a) => (a && a.length ? `<div class="sr-list"><b>${t}</b><ul>${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
    return `<div class="sr-body"><div class="sr-win ${r.winner === 'tie' ? 'tie' : ''}"><div><small>Better for this recording</small><h3>${esc(win)}</h3></div><span class="pill ${conf === 'high' ? 'ok' : conf === 'low' ? 'warn' : 'acc'}">${esc(conf)} confidence</span></div>
      <p class="sr-headline">${esc(r.headline || '')}</p>
      <div class="tbl-wrap"><table class="sr-scores"><thead><tr><th>Measured by listening</th><th>Chirp 2 (A)</th><th>Gemini 2.5 Flash (B)</th></tr></thead><tbody>
        ${bars('Accuracy', s.A?.accuracy, s.B?.accuracy)}${bars('Completeness', s.A?.completeness, s.B?.completeness)}${bars('Medical terms', s.A?.medical_terms, s.B?.medical_terms)}${bars('Nothing invented', s.A?.no_invention, s.B?.no_invention)}${bars('Overall', s.A?.overall, s.B?.overall)}</tbody></table></div>
      ${(r.reasons || []).length ? `<div class="sr-list"><b>Why</b><ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${dis.length ? `<h4>Where they differ, and who is right</h4><div class="tbl-wrap"><table><thead><tr><th>Chirp 2 wrote</th><th>Gemini wrote</th><th>The recording says</th><th>Right</th><th>Impact</th></tr></thead><tbody>${dis.map((d) => `<tr><td>${esc(d.a)}</td><td>${esc(d.b)}</td><td><b>${esc(d.audio)}</b></td><td><span class="pill ${d.right === 'A' || d.right === 'B' ? 'ok' : 'warn'}">${d.right === 'A' ? 'Chirp 2' : d.right === 'B' ? 'Gemini' : esc(d.right || '?')}</span></td><td><span class="pill ${d.impact === 'high' ? 'bad' : d.impact === 'low' ? 'warn' : ''}">${esc(d.impact || 'none')}</span></td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="sr-cols">${lst('Chirp 2 missed', r.missed_by_a)}${lst('Gemini missed', r.missed_by_b)}${lst('Chirp 2 invented', r.invented_by_a)}${lst('Gemini invented', r.invented_by_b)}</div>
      ${lst('Clinical risks', r.clinical_risks)}${r.limits ? `<p class="hint">Limits: ${esc(r.limits)}${c.audioAttached ? '' : ' (the reviewer had no audio this time)'}</p>` : ''}
      ${run.note.status === 'idle' ? `<div class="sr-use"><b>Write the SOAP note from</b>
        <label><input type="radio" name="sr-use" value="winner" ${ui.use === 'winner' ? 'checked' : ''}> the better transcript (${esc(win)})</label><label><input type="radio" name="sr-use" value="chirp" ${ui.use === 'chirp' ? 'checked' : ''}> Chirp 2</label><label><input type="radio" name="sr-use" value="gemini" ${ui.use === 'gemini' ? 'checked' : ''}> Gemini 2.5 Flash</label></div>
        <div class="sr-next"><button class="btn primary" id="sr-next2">Next: create the SOAP note ▸</button></div>` : ''}</div>`;
  }

  // the note as a structure: sections, topics and problems with their labelled lines
  function parseNote(md) {
    const sections = []; let sec = null; let group = null; let prob = null;
    for (const raw of String(md || '').split('\n')) {
      const line = raw.replace(/\s+$/, ''); if (!line.trim()) continue; let m;
      if ((m = line.match(/^###\s+(.+)/))) { sec = { title: m[1], groups: [], problems: [] }; sections.push(sec); group = null; prob = null; continue; }
      if (!sec) continue;
      if (/^Assessment/i.test(sec.title)) {
        if ((m = line.match(/^\s*\d+\.\s+\*\*(.+?)\*\*/))) { prob = { title: m[1], lines: [] }; sec.problems.push(prob); continue; }
        if (prob && (m = line.match(/^\s*[-•*]\s+(.*)$/))) { const l = m[1].match(/^(Diagnosis|Differential diagnoses|Investigations planned|Treatment planned|Referrals|Advice|Follow-up):\s*(.*)$/); prob.lines.push(l ? { label: l[1], text: l[2] } : { label: '', text: m[1] }); }
      } else {
        if ((m = line.match(/^\*\*(.+?)\*\*\s*$/))) { group = { title: m[1].replace(/:$/, ''), items: [] }; sec.groups.push(group); continue; }
        if ((m = line.match(/^\s*[-•*]\s+(.*)$/))) { if (!group) { group = { title: '', items: [] }; sec.groups.push(group); } group.items.push(m[1]); }
      }
    }
    return sections;
  }
  const noteSection = (s) => (s.problems.length
    ? `<section class="sr-sec ap"><h4>${esc(s.title)}</h4>${s.problems.map((p, i) => `<div class="sr-prob"><div class="sr-ptitle"><span>${i + 1}</span>${esc(p.title)}</div>${p.lines.map((l) => `<div class="sr-pl">${l.label ? `<em>${esc(l.label)}</em>` : '<em class="plain"></em>'}<span>${esc(l.text)}</span></div>`).join('')}</div>`).join('')}</section>`
    : `<section class="sr-sec"><h4>${esc(s.title)}</h4>${s.groups.map((g) => `<div class="sr-grp">${g.title ? `<div class="sr-gt">${esc(g.title)}</div>` : ''}<ul>${g.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</section>`);

  const ring = (score) => { const r = 34; const c = 2 * Math.PI * r; const v = Math.max(0, Math.min(100, score || 0)); return `<svg class="sr-ring" viewBox="0 0 80 80" width="84" height="84" role="img" aria-label="Score ${v} of 100"><circle cx="40" cy="40" r="${r}" class="bg"/><circle cx="40" cy="40" r="${r}" class="fg ${v >= 80 ? 'ok' : v >= 60 ? 'warn' : 'bad'}" stroke-dasharray="${(c * v) / 100} ${c}" transform="rotate(-90 40 40)"/><text x="40" y="45" text-anchor="middle">${v}</text></svg>`; };
  function auditHtml() {
    const au = run.audit; const a = au.result;
    if (au.status === 'running') return `<div class="sr-sub sr-loading">${spin}<div><h3>Auditing the note</h3><p class="hint">${esc(au.stage || 'Working')}… ${elapsed(au.startedAt)} s</p></div></div><div class="sr-shim big"></div>`;
    if (au.status === 'error') return `<div class="sr-err">${esc(au.error)}</div><div class="sr-next"><button class="btn primary" id="sr-retry3">Run the audit again</button></div>`;
    if (!a) return '';
    const sev = (x) => `<span class="pill ${x === 'critical' ? 'bad' : x === 'major' || x === 'important' ? 'warn' : ''}">${esc(x || 'minor')}</span>`;
    const L = (arr, f) => (arr || []).slice(0, 8).map(f).join('');
    const p = a.presentation || {};
    return `<div class="sr-sub"><div class="sr-audit-head">${ring(a.score)}<div><small>Audit of the note</small><h3>${esc(a.verdict || '')}</h3><p class="hint">${esc(a.summary || '')}</p></div>
        <div class="sr-pres"><span>Flow <b>${p.flow ?? '—'}</b></span><span>Readability <b>${p.readability ?? '—'}</b></span><span>Organisation <b>${p.organization ?? '—'}</b></span></div></div>
      ${(a.strengths || []).length ? `<div class="sr-list ok"><b>What works</b><ul>${a.strengths.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      <h4>What does not match</h4>
      ${!(a.wrong || []).length && !(a.missing || []).length && !(a.extra || []).length && !(a.ap_gaps || []).length ? '<p class="hint">Nothing wrong, missing or extra was found.</p>' : `<div class="tbl-wrap"><table><thead><tr><th>Kind</th><th>What</th><th>Why</th><th></th></tr></thead><tbody>
        ${L(a.wrong, (x) => `<tr><td><span class="pill bad">wrong</span></td><td>${esc(x.claim)}</td><td>${esc(x.problem)}</td><td>${sev(x.severity)}</td></tr>`)}
        ${L(a.missing, (x) => `<tr><td><span class="pill warn">missing</span></td><td>${esc(x.fact)}</td><td>in the recording, not in the note</td><td>${sev(x.importance)}</td></tr>`)}
        ${L(a.extra, (x) => `<tr><td><span class="pill">extra</span></td><td>${esc(x.text)}</td><td>${esc(x.why)}</td><td></td></tr>`)}
        ${L(a.ap_gaps, (x) => `<tr><td><span class="pill acc">plan</span></td><td>${esc(x.where)}: ${esc(x.gap)}</td><td>${esc(String(x.kind || '').replace(/_/g, ' '))}</td><td></td></tr>`)}</tbody></table></div>`}
      ${(a.suggestions || []).length ? `<div class="sr-list"><b>Suggestions</b><ul>${a.suggestions.slice(0, 6).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}</div>`;
  }
  function summaryHtml() {
    const s = run.summary; if (!s || run.audit.status !== 'done') return '';
    return `<div class="sr-sum ${s.verdict.replace(' ', '-')}"><div class="sr-sum-head"><small>Consolidated statement</small><h3>${esc(s.headline)}</h3></div>
      <ol>${s.lines.map((l) => `<li class="${l.ok ? 'ok' : 'no'}"><b>${esc(l.step)}</b><span>${esc(l.text)}</span></li>`).join('')}</ol>
      <div class="sr-caveats">${s.caveats.map((x) => `<p>${esc(x)}</p>`).join('')}</div>
      <div class="tools"><button class="btn" id="sr-copy">Copy statement</button><button class="btn" id="sr-dl">Download full report</button><button class="btn primary" id="sr-new2">New run</button></div></div>`;
  }
  function card3() {
    const n = run.note; if (n.status === 'idle') return '<div class="sr-body"><p class="hint">The note is written after you choose a transcript.</p></div>';
    const src = n.sourceLabel ? `from the <b>${esc(n.sourceLabel)}</b> transcript` : '';
    const tx = run.asr.engines[n.sourceKey]?.text || '';
    const top = `<button class="sr-fold" id="sr-tx" aria-expanded="${ui.transcript}"><span>${ui.transcript ? '▾' : '▸'}</span> Transcript used ${src} <small>${ui.transcript ? 'click to close' : 'click to open'}</small></button>${ui.transcript ? `<div class="sr-txfull">${esc(tx)}</div>` : ''}`;
    if (n.status === 'running') return `<div class="sr-body">${top}<div class="sr-loading">${spin}<div><h3>Writing the SOAP note</h3><p class="hint">${esc(n.stage || 'Working')}… ${elapsed(n.startedAt)} s</p></div></div><div class="sr-shim big"></div></div>`;
    if (n.status === 'error') return `<div class="sr-body">${top}<div class="sr-err">${esc(n.error)}</div><div class="sr-next"><button class="btn primary" id="sr-retry-note">Try again</button></div></div>`;
    const flags = (n.flags || []).filter((f) => ['warning', 'critical'].includes(f.severity));
    return `<div class="sr-body">${top}<div class="sr-notehead"><h3>SOAP note</h3><span class="hint">written in ${n.seconds} s ${src}</span>${n.toCheck ? `<span class="pill warn">${n.toCheck} to check</span>` : '<span class="pill ok">nothing flagged</span>'}</div>
      <div class="sr-note">${parseNote(n.rendered).map(noteSection).join('')}</div>
      ${flags.length ? `<details class="sr-flags"><summary>${flags.length} line${flags.length === 1 ? '' : 's'} the pipeline wants checked</summary><ul>${flags.slice(0, 12).map((f) => `<li>${esc(String(f.message || '').slice(0, 220))}</li>`).join('')}</ul></details>` : ''}
      ${auditHtml()}${summaryHtml()}</div>`;
  }

  // a finished step folds into one line you can open again
  function folded(n) {
    if (n === 1) { const e = run.asr.engines || {}; return `Transcribed by 2 models · Chirp 2 ${e.chirp?.metrics?.words ?? '?'} words, Gemini ${e.gemini?.metrics?.words ?? '?'} words · ${pct(run.asr.agreement?.sharedPct)} agree`; }
    if (n === 2) return `Reviewer: ${winLabel(run.compare.result)} is better (${run.compare.result?.confidence || '?'} confidence)`;
    return '';
  }
  function draw() {
    stepper(); const a = active(); const cards = [[1, 'Transcribe', card1], [2, 'Compare', () => (run ? card2() : '')], [3, 'SOAP note & audit', () => (run ? card3() : '')]];
    $('#sr-stack').innerHTML = `<div class="sr-stack">${cards.map(([n, title, body]) => {
      const locked = n > a && !(run && ((n === 2 && run.compare.status !== 'idle') || (n === 3 && run.note.status !== 'idle')));
      const past = n < a && run && (n === 1 ? run.asr.status === 'done' : run.compare.status === 'done');
      const open = n === a || ui.openStep === n;
      if (locked) return `<div class="sr-card locked" style="z-index:${10 - n}"><div class="sr-ch"><span class="sr-num">${n}</span><b>${title}</b><small>Waiting for the step before</small></div></div>`;
      if (past && !open) return `<div class="sr-card folded" style="z-index:${10 - n}" data-open="${n}"><div class="sr-ch"><span class="sr-num ok">✓</span><b>${title}</b><small>${esc(folded(n))}</small><span class="sr-more">open ▾</span></div></div>`;
      return `<div class="sr-card open" style="z-index:${10 - n}"><div class="sr-ch"><span class="sr-num">${state(n === 1 ? 'asr' : n === 2 ? 'compare' : 'note') === 'done' ? '✓' : n}</span><b>${title}</b>${past ? '<span class="sr-more" data-close="1">close ▴</span>' : ''}</div>${body()}</div>`;
    }).join('')}</div>`;
    wire();
  }

  function wire() {
    document.querySelectorAll('[data-open]').forEach((c) => { c.onclick = () => { ui.openStep = Number(c.dataset.open); draw(); }; });
    document.querySelectorAll('[data-close]').forEach((c) => { c.onclick = () => { ui.openStep = null; draw(); }; });
    document.querySelectorAll('[data-full]').forEach((b) => { b.onclick = () => { ui.showFull[b.dataset.full] = !ui.showFull[b.dataset.full]; draw(); }; });
    const sel = $('#sr-sel'); if (sel) sel.onchange = () => { pick = sel.value; $('#sr-listen').disabled = !pick; $('#sr-go').disabled = !pick; $('#sr-aud').innerHTML = ''; };
    const lis = $('#sr-listen'); if (lis) lis.onclick = async () => { try { const a = await api(`/api/console/audio/${encodeURIComponent(pick)}/url`); $('#sr-aud').innerHTML = `<audio controls autoplay preload="metadata" src="${esc(a.url)}" style="width:100%;max-width:560px;margin-top:10px"></audio><div class="hint">Opening a recording is written to the audit log. The link works for 10 minutes.</div>`; } catch (e) { toast(e.message, true); } };
    const go = $('#sr-go'); if (go) go.onclick = () => start(pick);
    const n1 = $('#sr-next1'); if (n1) n1.onclick = () => step('compare');
    const r2 = $('#sr-retry2'); if (r2) r2.onclick = () => step('compare');
    document.querySelectorAll('input[name="sr-use"]').forEach((r) => { r.onchange = () => { ui.use = r.value; }; });
    const n2 = $('#sr-next2'); if (n2) n2.onclick = () => step('note', { use: ui.use === 'winner' ? undefined : ui.use });
    const rn = $('#sr-retry-note'); if (rn) rn.onclick = () => step('note', { use: ui.use === 'winner' ? undefined : ui.use });
    const r3 = $('#sr-retry3'); if (r3) r3.onclick = () => step('note');
    const tx = $('#sr-tx'); if (tx) tx.onclick = () => { ui.transcript = !ui.transcript; draw(); };
    const cp = $('#sr-copy'); if (cp) cp.onclick = () => { const s = run.summary; navigator.clipboard.writeText([s.headline, '', ...s.lines.map((l) => `${l.step}: ${l.text}`), '', ...s.caveats].join('\n')); toast('Statement copied'); };
    const dl = $('#sr-dl'); if (dl) dl.onclick = async () => { try { const res = await fetch(`/lab/superrun/${run.id}/report`, { credentials: 'same-origin' }); const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `super-run-${run.id}.json`; document.body.appendChild(a); a.click(); a.remove(); } catch (e) { toast(e.message, true); } };
    const nw = $('#sr-new2'); if (nw) nw.onclick = reset;
  }

  async function pastRuns() {
    const box = $('#sr-past-box'); if (box.innerHTML) { box.innerHTML = ''; return; }
    try {
      const d = await lab('/superrun/runs');
      box.innerHTML = d.runs.length ? `<div class="card" style="margin-top:16px"><h3 style="margin:0 0 8px">Past runs</h3><div class="tbl-wrap"><table><thead><tr><th>Recording</th><th>When</th><th>Result</th><th></th></tr></thead><tbody>${d.runs.map((r) => `<tr class="click" data-run="${esc(r.id)}"><td>${esc(r.name)}</td><td>${ago(r.createdAt)}</td><td>${esc(r.headline)}</td><td>${r.steps.map((s) => `<span class="sr-mini ${s}"></span>`).join('')}</td></tr>`).join('')}</tbody></table></div></div>` : '<div class="card empty" style="margin-top:16px">No runs yet.</div>';
      document.querySelectorAll('[data-run]').forEach((tr) => { tr.onclick = async () => { try { run = await lab('/superrun/' + tr.dataset.run); ui.openStep = null; box.innerHTML = ''; draw(); if (running()) startPoll(); window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { toast(e.message, true); } }; });
    } catch (e) { toast(e.message, true); }
  }

  try { recs = (await lab('/superrun/recordings')).recordings; } catch (e) { $('#sr-stack').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
  draw();
}
