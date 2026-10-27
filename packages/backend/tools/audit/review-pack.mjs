// Clinician review pack (the method of Asgari et al. 2025: every note sentence is marked supported / hallucination (type, major or minor), and omissions are listed with severity).
// Builds ONE self-contained HTML file that a clinician opens in any browser: transcript on the left, note sentences on the right with buttons, an omissions box, autosave,
// and a "Download results" button (JSON). The AI judge's findings are NOT shown (no anchoring). Two clinicians should review the same pack; a third settles disagreements.
//   node review-pack.mjs <run> [<run2> ...] [--n=60] [--seed=7] [--out=/lab-data/review-pack]
// Notes are taken from finished gold-eval runs (de-identified gold transcripts, current pipeline output). Run inside the lab container.
import fs from 'node:fs';
const args = process.argv.slice(2); const flag = (k, d) => (args.find((a) => a.startsWith('--' + k + '=')) || '').split('=')[1] || d;
const runs = args.filter((a) => !a.startsWith('--')); const N = Number(flag('n', 60)); let seed = Number(flag('seed', 7)); const OUT = flag('out', '/lab-data/review-pack');
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const txOf = (file) => { const t = fs.readFileSync('/app/data/gold/' + file, 'utf8'); const i = t.search(/\n\s*\**Subjective:?\**/i); return t.slice(0, i).replace(/^\s*\d+:\d+\s*$/gm, ' ').replace(/\n{3,}/g, '\n\n').trim(); };
const pool = []; const seen = new Set();
for (const r of runs) for (const x of JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${r}.json`, 'utf8'))) if (x.note && !seen.has(x.file)) { seen.add(x.file); pool.push({ file: x.file, run: r, note: x.note }); }
for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
const pick = pool.slice(0, N);
const cases = pick.map((p, k) => {
  const lines = []; let sec = '';
  for (const raw of p.note.split('\n')) {
    const t = raw.replace(/\*\*/g, '').trim(); if (!t) continue;
    if (/^#{1,4}\s/.test(t)) { sec = t.replace(/^#+\s*/, ''); lines.push({ head: sec }); continue; }
    lines.push({ s: t.replace(/^(?:[-*]|\d+\.)\s+/, ''), sec });
  }
  return { id: 'C' + String(k + 1).padStart(2, '0'), transcript: txOf(p.file), lines };
});
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(OUT + '/answer-key.json', JSON.stringify(pick.map((p, k) => ({ id: cases[k].id, file: p.file, run: p.run }))));
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notera note review</title>
<style>
:root{--bg:#f6f7f9;--ink:#1d2129;--mut:#667085;--line:#d9dde3;--card:#fff;--ok:#1f7a4d;--bad:#b42318;--warn:#b54708;--acc:#3a0f34}
@media(prefers-color-scheme:dark){:root{--bg:#14161a;--ink:#e8eaee;--mut:#9aa3b2;--line:#2c313a;--card:#1b1e24;--ok:#4cc38a;--bad:#f97066;--warn:#fdb022;--acc:#d7a9d0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,Segoe UI,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:8px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header b{color:var(--acc)}select,button,input,textarea{font:inherit;color:inherit}button,select,input[type=text]{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:5px 10px}button{cursor:pointer}button:active{transform:scale(.97)}
main{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 16px;max-width:1500px;margin:0 auto}@media(max-width:900px){main{grid-template-columns:1fr}}
.pane{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;max-height:calc(100dvh - 90px);overflow:auto}
.tx{white-space:pre-wrap;font-size:13px}h3{margin:10px 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--mut)}
.row{border-top:1px solid var(--line);padding:6px 0}.row .t{margin-bottom:4px}.btns{display:flex;gap:4px;flex-wrap:wrap}.btns button{padding:2px 8px;font-size:12px}
.btns button.on.ok{background:var(--ok);color:#fff;border-color:var(--ok)}.btns button.on.bad{background:var(--bad);color:#fff;border-color:var(--bad)}
.sub{display:none;gap:4px;margin-top:4px;flex-wrap:wrap}.row.h .sub{display:flex}.sub select{padding:2px 6px;font-size:12px}
textarea{width:100%;min-height:90px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px}
.help{color:var(--mut);font-size:12px;margin:0 0 8px}
</style></head><body>
<header><b>Notera note review</b><select id="case"></select><button id="prev">Previous</button><button id="next">Next</button><span id="prog" class="help"></span>
<input id="who" type="text" placeholder="Your name or initials" style="width:170px"><button id="dl">Download results</button></header>
<main><section class="pane"><h3>Consultation transcript</h3><div class="tx" id="tx"></div></section>
<section class="pane"><p class="help">For every note line choose <b>Supported</b> (the consultation says it) or <b>Wrong</b>, then the kind and how serious. <b>Serious</b> = could change diagnosis, treatment or safety. Then list what the note LEAVES OUT.</p>
<div id="lines"></div><h3>Left out of the note</h3><p class="help">One per line. Start with S: (serious) or M: (minor), for example “S: allergy to penicillin”.</p><textarea id="om"></textarea></section></main>
<script>
const CASES=${JSON.stringify(cases).replace(/</g, '\\u003c')};
const KEY='notera-review-v1';let st={};try{st=JSON.parse(localStorage.getItem(KEY)||'{}')}catch{}
const $=(i)=>document.getElementById(i);let cur=0;
const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(st))}catch{}};
const cs=$('case');CASES.forEach((c,i)=>{const o=document.createElement('option');o.value=i;o.textContent=c.id;cs.appendChild(o)});
function done(c){const a=st[c.id]||{};const n=c.lines.filter(l=>l.s).length;return Object.keys(a.l||{}).length>=n}
function render(){const c=CASES[cur];cs.value=cur;$('tx').textContent=c.transcript;const a=(st[c.id]=st[c.id]||{l:{},om:''});const box=$('lines');box.innerHTML='';
 c.lines.forEach((l,i)=>{if(l.head){const h=document.createElement('h3');h.textContent=l.head;box.appendChild(h);return}
  const r=document.createElement('div');const v=a.l[i]||{};r.className='row'+(v.v==='wrong'?' h':'');
  r.innerHTML='<div class="t"></div><div class="btns"><button class="ok'+(v.v==='ok'?' on':'')+'" data-v="ok">Supported</button><button class="bad'+(v.v==='wrong'?' on':'')+'" data-v="wrong">Wrong</button></div><div class="sub"><select data-k="kind"><option value="">kind…</option><option>invented</option><option>negation</option><option>wrong detail</option><option>mixed up (wrong problem or time)</option><option>unsupported cause</option></select><select data-k="sev"><option value="">how serious…</option><option>serious</option><option>minor</option></select></div>';
  r.querySelector('.t').textContent=l.s;
  r.querySelectorAll('.btns button').forEach(b=>b.onclick=()=>{a.l[i]={...(a.l[i]||{}),v:b.dataset.v};save();render()});
  r.querySelectorAll('select').forEach(s=>{s.value=v[s.dataset.k]||'';s.onchange=()=>{a.l[i]={...(a.l[i]||{}),[s.dataset.k]:s.value};save()}});
  box.appendChild(r)});
 $('om').value=a.om||'';$('om').oninput=()=>{a.om=$('om').value;save()};
 $('prog').textContent=CASES.filter(done).length+' of '+CASES.length+' fully marked';$('who').value=st._who||'';}
cs.onchange=()=>{cur=+cs.value;render()};$('prev').onclick=()=>{cur=Math.max(0,cur-1);render()};$('next').onclick=()=>{cur=Math.min(CASES.length-1,cur+1);render()};
$('who').oninput=()=>{st._who=$('who').value;save()};
$('dl').onclick=()=>{const out={reviewer:st._who||'',at:new Date().toISOString(),cases:CASES.map(c=>({id:c.id,lines:c.lines.map((l,i)=>l.s?{s:l.s,sec:l.sec,...((st[c.id]||{l:{}}).l[i]||{})}:null).filter(Boolean),omissions:((st[c.id]||{}).om||'').split('\\n').map(x=>x.trim()).filter(Boolean)}))};
 const b=new Blob([JSON.stringify(out,null,1)],{type:'application/json'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download='review-'+(st._who||'reviewer').replace(/\\W+/g,'_')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),2000)};
render();
</script></body></html>`;
fs.writeFileSync(OUT + '/review-pack.html', html);
console.log(`review pack: ${cases.length} notes, ${cases.reduce((n, c) => n + c.lines.filter((l) => l.s).length, 0)} note lines -> ${OUT}/review-pack.html (answer key: answer-key.json)`);
