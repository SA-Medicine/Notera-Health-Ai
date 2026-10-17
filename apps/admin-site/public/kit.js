// Shared helpers for the console screens: lab client, dependency-free SVG charts, line diff.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** fetch against the lab service through the Worker (admin-session gated). */
export async function lab(path, opts = {}) {
  const res = await fetch('/lab' + path, { credentials: 'same-origin', method: opts.method, headers: opts.json ? { 'Content-Type': 'application/json' } : {}, body: opts.json ? JSON.stringify(opts.json) : undefined });
  const txt = await res.text(); let d = null; try { d = txt ? JSON.parse(txt) : null; } catch { d = { error: txt.slice(0, 120) }; }
  if (!res.ok) throw new Error((d && d.error) || `HTTP ${res.status}`);
  return d;
}
export const pretty = (id) => String(id).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
export const f3 = (x) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(3));
export const sgn = (x, d = 3) => (x == null ? '—' : (x > 0 ? '+' : '') + Number(x).toFixed(d));
export const MODELS = [
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite — cheapest, fastest'],
  ['gemini-3.7-flash', 'Gemini 3.7 Flash — best measured quality, ~2x slower'],
  ['gemini-2.5-flash', 'Gemini 2.5 Flash — current production writer'],
  ['gemini-2.5-pro', 'Gemini 2.5 Pro — highest quality'],
];
export const opts = (arr, cur) => arr.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`).join('');

/** Line diff (LCS) → html with +/- rows. For prompt versions and candidate-vs-live review. */
export function diffHtml(a, b, ctxLines = 2) {
  const A = String(a).split('\n'), B = String(b).split('\n'); const n = A.length, m = B.length;
  if (n * m > 4_000_000) return '<div class="hint">Texts are too large to diff here.</div>';
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) ops.push(['-', A[i++]]); else ops.push(['+', B[j++]]); }
  while (i < n) ops.push(['-', A[i++]]); while (j < m) ops.push(['+', B[j++]]);
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, k) => { if (o[0] !== ' ') for (let t = Math.max(0, k - ctxLines); t <= Math.min(ops.length - 1, k + ctxLines); t++) keep[t] = true; });
  const adds = ops.filter((o) => o[0] === '+').length, dels = ops.filter((o) => o[0] === '-').length;
  if (!adds && !dels) return '<div class="hint">No differences.</div>';
  let out = `<div class="hint" style="margin-bottom:6px"><b style="color:var(--ok)">+${adds}</b> added · <b style="color:var(--bad)">−${dels}</b> removed lines</div><div class="diff">`; let gap = false;
  ops.forEach((o, k) => { if (!keep[k]) { gap = true; return; } if (gap) { out += '<div class="dl gap">⋯</div>'; gap = false; } out += `<div class="dl ${o[0] === '+' ? 'add' : o[0] === '-' ? 'del' : ''}"><i>${o[0]}</i>${esc(o[1]) || '&nbsp;'}</div>`; });
  return out + '</div>';
}

// ───────────── charts (inline SVG, theme-aware via CSS variables) ─────────────
const PAL = ['#2d8cff', '#22b573', '#f5a524', '#e5484d', '#8e4ec6', '#12a594'];
function scale(vals, pad = 0.08) { let lo = Math.min(...vals), hi = Math.max(...vals); if (!Number.isFinite(lo)) { lo = 0; hi = 1; } if (lo === hi) { lo -= 1; hi += 1; } const p = (hi - lo) * pad; return [lo - p, hi + p]; }
/** series: [{name, color?, points:[{x:label, y:number|null}]}] — shared x labels from the first series. */
export function lineChart(series, { w = 560, h = 170, fmt = (v) => v, zero = false } = {}) {
  const pts = series.flatMap((s) => s.points.map((p) => p.y).filter((y) => y != null)); if (!pts.length) return '<div class="hint" style="padding:30px 0;text-align:center">No data yet</div>';
  let [lo, hi] = scale(pts); if (zero) lo = Math.min(0, lo); const L = 40, R = 10, T = 10, B = 24; const xs = series[0].points.map((p) => p.x); const nx = Math.max(1, xs.length - 1);
  const X = (i) => L + (i * (w - L - R)) / nx, Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);
  let g = ''; for (let k = 0; k <= 3; k++) { const v = lo + ((hi - lo) * k) / 3; g += `<line x1="${L}" x2="${w - R}" y1="${Y(v)}" y2="${Y(v)}" class="gl"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" class="ax">${esc(fmt(v))}</text>`; }
  const step = Math.ceil(xs.length / 7); xs.forEach((x, i) => { if (i % step === 0 || i === xs.length - 1) g += `<text x="${X(i)}" y="${h - 6}" text-anchor="middle" class="ax">${esc(x)}</text>`; });
  const lines = series.map((s, si) => { const c = s.color || PAL[si % PAL.length]; let d = '', pen = false; s.points.forEach((p, i) => { if (p.y == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`; pen = true; });
    return `<path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>` + s.points.map((p, i) => (p.y == null ? '' : `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3" fill="${c}"><title>${esc(s.name)} · ${esc(p.x)}: ${esc(fmt(p.y))}${p.tip ? ' · ' + esc(p.tip) : ''}</title></circle>`)).join(''); }).join('');
  const legend = series.length > 1 ? `<div class="legend">${series.map((s, i) => `<span><i style="background:${s.color || PAL[i % PAL.length]}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" preserveAspectRatio="xMidYMid meet">${g}${lines}</svg>${legend}`;
}
/** bars: [{label, value, color?}] */
export function barChart(bars, { w = 560, h = 150, fmt = (v) => v } = {}) {
  if (!bars.length) return '<div class="hint" style="padding:30px 0;text-align:center">No data yet</div>';
  const max = Math.max(1e-9, ...bars.map((b) => Math.abs(b.value))); const L = 8, T = 8, B = 22; const bw = (w - L * 2) / bars.length; const zero = T + (h - T - B) / 2; const hasNeg = bars.some((b) => b.value < 0); const base = hasNeg ? zero : h - B; const span = hasNeg ? (h - T - B) / 2 : h - T - B;
  const step = Math.ceil(bars.length / 10);
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">${hasNeg ? `<line x1="${L}" x2="${w - L}" y1="${zero}" y2="${zero}" class="gl"/>` : ''}${bars.map((b, i) => { const bh = (Math.abs(b.value) / max) * span; const y = b.value >= 0 ? base - bh : base; return `<rect x="${(L + i * bw + bw * 0.14).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.72).toFixed(1)}" height="${Math.max(1, bh).toFixed(1)}" rx="2" fill="${b.color || (b.value < 0 ? '#e5484d' : '#2d8cff')}"><title>${esc(b.label)}: ${esc(fmt(b.value))}</title></rect>${i % step === 0 ? `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle" class="ax">${esc(String(b.label).slice(0, 8))}</text>` : ''}`; }).join('')}</svg>`;
}
export function spark(vals, { w = 90, h = 26 } = {}) {
  const v = vals.filter((x) => x != null); if (v.length < 2) return ''; const [lo, hi] = scale(v, 0.1); const X = (i) => (i * w) / (v.length - 1), Y = (y) => h - ((y - lo) / (hi - lo)) * h;
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="spark"><path d="${v.map((y, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(y).toFixed(1)}`).join('')}" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
}
export const kpi = (label, value, sub = '', tone = '') => `<div class="card stat"><div class="l">${esc(label)}</div><div class="n ${tone}">${value}</div><div class="s">${sub}</div></div>`;

// shared "currently selected run / note" so every Harness screen opens on what you were just looking at
export const cur = {
  get run() { try { return localStorage.getItem('nadm_run') || ''; } catch { return ''; } },
  set run(v) { try { localStorage.setItem('nadm_run', v || ''); } catch { /* storage may be blocked */ } },
  get note() { try { return localStorage.getItem('nadm_note') || ''; } catch { return ''; } },
  set note(v) { try { localStorage.setItem('nadm_note', v || ''); } catch { /* */ } },
};
export const runLabel = (r) => `${r.label || r.id.slice(-8)} · ${r.config.writerModel || 'default'} · ${String(r.config.promptSource).replace('candidate:', 'cand ')} · ${r.config.n} notes`;
/** traffic-light for one note from its metrics (simple, explainable thresholds) */
export const grade = (x) => (x.error ? 'bad' : (x.similarity_to_gold ?? 0) >= 0.45 && (x.omission_rate ?? 1) <= 0.45 ? 'ok' : (x.similarity_to_gold ?? 0) >= 0.3 && (x.omission_rate ?? 1) <= 0.65 ? 'mid' : 'bad');
export const VERDICT = { excellent: ['Excellent', 'ok'], good: ['Good', 'ok'], needs_work: ['Needs work', 'warn'], unsafe: ['Unsafe', 'bad'] };
