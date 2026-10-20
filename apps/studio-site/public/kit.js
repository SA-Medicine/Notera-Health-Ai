// Shared helpers for Notera Studio (vanilla ES modules, no build step).
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const when = (t) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export const S = { me: null };

let tt = 0;
export function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : ''); clearTimeout(tt); tt = setTimeout(() => { t.className = ''; }, 3200); }

async function call(prefix, path, opts = {}) {
  const res = await fetch(prefix + path, { credentials: 'same-origin', ...opts, headers: { ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) }, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body });
  const txt = await res.text(); let data = null; try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if (res.status === 401 && !opts.quiet) { S.me = null; location.hash = '#/login'; throw new Error('Signed out'); }
  if (!res.ok) { const e = new Error((data && (data.error || data.message)) || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}
export const studio = (path, opts) => call('/studio', path, opts);
export const backend = (path, opts) => call('/backend', path, opts);

/** Run an async action on a button: disable it, show progress text, restore afterwards. */
export async function busy(btn, text, fn) {
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span> ${esc(text)}`;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.innerHTML = old; }
}
export const pill = (text, tone = '') => `<span class="pill ${tone}">${esc(text)}</span>`;
export const scoreTone = (v) => (v == null ? '' : v >= 0.9 ? 'ok' : v >= 0.75 ? 'warn' : 'bad');
export const head = (title, sub = '', right = '') => `<div class="head"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div><div class="grow"></div>${right}</div>`;
