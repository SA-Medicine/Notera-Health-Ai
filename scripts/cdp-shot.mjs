#!/usr/bin/env node
// Real-time screenshots via the Chrome DevTools Protocol (no puppeteer needed).
//   node scripts/cdp-shot.mjs <url> <outPrefix> [--w 1440] [--h 900] [--at 3,9,14] [--frames N --fps 12 --selector .dm]
//   --at   : seconds after load at which to capture a PNG  → <outPrefix>_<sec>.png
//   --frames/--fps : capture N frames at fps (for video) → <outPrefix>_f0001.png …  (optionally clipped to --selector)
//   --css '<rules>' : inject CSS before capturing (e.g. hide a fixed nav)
//   --clock <global> : with --frames, drive window[<global>] = frame time in ms (deterministic frames, any speed)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const [url, out] = args;
const opt = (k, d) => { const i = args.indexOf('--' + k); return i === -1 ? d : args[i + 1]; };
const W = +opt('w', 1440), H = +opt('h', 900);
const at = String(opt('at', '')).split(',').filter(Boolean).map(Number);
const frames = +opt('frames', 0), fps = +opt('fps', 12), selector = opt('selector', ''), clock = opt('clock', '');
const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9300 + Math.floor(Math.random() * 400);
const dir = mkdtempSync(join(tmpdir(), 'cdp-'));
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0; const pending = new Map();
async function connect() {
  for (let i = 0; i < 50; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const pg = t.find((x) => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); break; } } catch { /* not up yet */ }
    await sleep(200);
  }
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const save = (p, b64) => writeFileSync(p, Buffer.from(b64, 'base64'));

try {
  await connect();
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: +opt('dpr', 1), mobile: W < 600 });
  if (opt('dark', '')) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const t0 = Date.now();
  await send('Page.navigate', { url });
  await sleep(1500);
  if (opt('scroll', '')) await send('Runtime.evaluate', { expression: `window.scrollTo(0, ${+opt('scroll', 0)})` });
  if (opt('css', '')) await send('Runtime.evaluate', { expression: `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(opt('css', ''))};document.head.appendChild(s)})()` });
  let clip;
  if (selector) {
    const r = await send('Runtime.evaluate', { expression: `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x+scrollX,y:b.y+scrollY,width:b.width,height:b.height,scale:1}})()`, returnByValue: true });
    clip = r.result?.result?.value || undefined;
  }
  const shot = async (path) => { const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) }); save(path, r.result.data); };
  for (const s of at) { const wait = s * 1000 - (Date.now() - t0); if (wait > 0) await sleep(wait); await shot(`${out}_${s}.png`); }
  if (frames) {
    if (clock) {
      for (let f = 0; f < frames; f++) {
        await send('Runtime.evaluate', { expression: `window.${clock} = ${Math.round((f * 1000) / fps)}` });
        await sleep(+opt('settle', 320));
        await shot(`${out}_f${String(f + 1).padStart(4, '0')}.png`);
      }
    } else {
    const step = 1000 / fps; const start = Date.now();
    for (let f = 1; f <= frames; f++) { await shot(`${out}_f${String(f).padStart(4, '0')}.png`); const next = start + f * step - Date.now(); if (next > 0) await sleep(next); }
    }
  }
} finally { try { ws?.close(); } catch { /* */ } proc.kill(); }
console.log('done');
