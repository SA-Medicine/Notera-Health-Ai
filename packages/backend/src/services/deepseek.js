// ─────────────────────────────────────────────────────────────────────────────
// deepseek.js — independent "Second Opinion" clinical reviewer.
//
// Unlike the note-vs-gold comparator, this agent gets NO reference note. It is handed
// only the raw transcript, the Notera-generated note, and (optionally) the generation
// prompt, and is asked for a blunt, expert, independent review from its OWN clinical
// knowledge — the kind of brutally honest critique you'd get from a senior attending or
// a top web chat assistant. Powered by DeepSeek (OpenAI-compatible API).
//
// Config (.env):
//   DEEPSEEK_API_KEY   required to enable the feature
//   DEEPSEEK_MODEL     default 'deepseek-v4-flash'  (latest flash; also 'deepseek-v4-pro', 'deepseek-reasoner')
//   DEEPSEEK_BASE_URL  default 'https://api.deepseek.com'
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const BASE = () => (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = () => process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const KEY = () => process.env.DEEPSEEK_API_KEY || '';

export function deepseekEnabled() { return !!KEY(); }

// The reviewer persona + the exact JSON we render in the UI.
const SYS = `You are an elite independent clinical documentation reviewer — a seasoned attending physician and a medico-legal QA expert rolled into one. You are given the raw consultation TRANSCRIPT and an AI-generated SOAP NOTE (and possibly the generation PROMPT). There is NO reference/"gold" note — you judge the note ENTIRELY on your own clinical knowledge and reasoning.

Give a brutally honest, specific, expert opinion on the NOTE. Be direct and critical — do not flatter. Reward only genuine clinical accuracy, completeness, and safety; never fluent-but-unsupported text. Ground every criticism in the transcript (quote the offending phrase when useful). Call out: facts invented or not supported by the transcript (hallucinations), important facts from the transcript that were dropped (omissions), anything that is a patient-safety risk (wrong dose/drug/allergy/laterality, missing red-flag follow-up), transcription artifacts, and structural/clarity problems.

Return ONLY a valid JSON object (no markdown, no commentary) with EXACTLY this shape:
{
  "overall_score": 0-100,
  "verdict": "excellent | good | needs_work | unsafe",
  "one_liner": "one blunt sentence — your bottom line",
  "dimensions": [
    { "name": "Faithfulness", "score": 0-5, "comment": "short, specific" },
    { "name": "Completeness", "score": 0-5, "comment": "short, specific" },
    { "name": "Clinical safety", "score": 0-5, "comment": "short, specific" },
    { "name": "Structure", "score": 0-5, "comment": "short, specific" },
    { "name": "Clarity", "score": 0-5, "comment": "short, specific" }
  ],
  "strengths": ["what the note genuinely does well"],
  "weaknesses": ["concrete weaknesses, each actionable"],
  "safety_issues": ["patient-safety risks; [] if none"],
  "hallucinations": ["facts in the note NOT supported by the transcript; [] if none"],
  "omissions": ["important transcript facts the note dropped; [] if none"],
  "recommendations": ["specific fixes, most important first"],
  "brutal_summary": "2-4 paragraph honest expert assessment, no sugar-coating"
}
Scoring: overall_score is holistic (0-100). Each dimension is 0 (unacceptable) to 5 (excellent). If there is any real patient-safety risk, verdict is "unsafe" regardless of other qualities.`;

function buildUser({ transcript = '', note = '', promptContext = '' }) {
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '\n…[truncated]…' : s; };
  let u = `=== CONSULTATION TRANSCRIPT (the source of truth) ===\n${clip(transcript, 24000) || '(no transcript provided)'}\n\n`;
  u += `=== NOTERA-GENERATED SOAP NOTE (the note under review) ===\n${clip(note, 16000) || '(no note provided)'}\n\n`;
  if (promptContext) u += `=== GENERATION PROMPT (context, for reference only) ===\n${clip(promptContext, 6000)}\n\n`;
  u += `Review the NOTE independently and return ONLY the JSON object.`;
  return u;
}

// Robust-ish JSON extraction (strip fences, slice to the object).
function parseJson(raw) {
  const s = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* noop */ } }
  return null;
}

/**
 * Low-level DeepSeek JSON call — shared by the Second Opinion critic and the
 * pipeline Hallucination-Remover agent. Non-thinking (fast), JSON output, never throws.
 * Returns { ok:true, data } (parsed JSON) or { ok:false, error, hint }.
 */
export async function deepseekJson({ system = '', user = '', maxTokens, temperature = 0.1 } = {}, { fetchImpl } = {}) {
  if (!deepseekEnabled()) return { ok: false, error: 'DeepSeek is not configured', hint: 'Set DEEPSEEK_API_KEY in the backend .env.' };
  const f = fetchImpl || fetch;
  const thinking = String(process.env.DEEPSEEK_THINKING || 'disabled').toLowerCase() === 'enabled' ? 'enabled' : 'disabled';
  const body = {
    model: MODEL(), messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature, max_tokens: Number(maxTokens || process.env.DEEPSEEK_MAX_TOKENS || 8192),
    response_format: { type: 'json_object' }, thinking: { type: thinking }, stream: false,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.DEEPSEEK_TIMEOUT_MS || 120000));
  try {
    const r = await f(`${BASE()}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY()}` }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: `DeepSeek API ${r.status}`, hint: text.slice(0, 400) };
    let payload; try { payload = JSON.parse(text); } catch { return { ok: false, error: 'non-JSON envelope', hint: text.slice(0, 400) }; }
    const parsed = parseJson(payload?.choices?.[0]?.message?.content || '');
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'could not parse JSON output' };
    return { ok: true, data: parsed, model: MODEL() };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'DeepSeek request timed out' : e.message, hint: 'Check DEEPSEEK_API_KEY / egress to api.deepseek.com.' };
  } finally { clearTimeout(timer); }
}

/**
 * Run the independent critique. Returns { ok, ...report } or { ok:false, error, hint }.
 * Never throws.
 */
export async function critiqueNote({ transcript = '', note = '', promptContext = '' } = {}, { fetchImpl } = {}) {
  if (!deepseekEnabled()) return { ok: false, error: 'DeepSeek is not configured', hint: 'Set DEEPSEEK_API_KEY in the backend .env to enable the Second Opinion reviewer.' };
  if (!note.trim()) return { ok: false, error: 'no generated note to review' };
  const f = fetchImpl || fetch;
  // Thinking mode is DEFAULT-ON for deepseek-v4-* and runs a long chain-of-thought before
  // answering — slow enough that the dev proxy times out. A structured JSON critique does
  // not need it, so disable it (fast, non-thinking) unless DEEPSEEK_THINKING=enabled.
  const thinking = String(process.env.DEEPSEEK_THINKING || 'disabled').toLowerCase() === 'enabled' ? 'enabled' : 'disabled';
  const body = {
    model: MODEL(),
    messages: [{ role: 'system', content: SYS }, { role: 'user', content: buildUser({ transcript, note, promptContext }) }],
    temperature: 0.2,
    max_tokens: Number(process.env.DEEPSEEK_MAX_TOKENS || 4096),
    response_format: { type: 'json_object' },
    thinking: { type: thinking },
    stream: false,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.DEEPSEEK_TIMEOUT_MS || 120000));
  try {
    const r = await f(`${BASE()}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY()}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: `DeepSeek API ${r.status}`, hint: text.slice(0, 400) };
    let payload; try { payload = JSON.parse(text); } catch { return { ok: false, error: 'DeepSeek returned non-JSON envelope', hint: text.slice(0, 400) }; }
    const content = payload?.choices?.[0]?.message?.content || '';
    const parsed = parseJson(content);
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'could not parse critique JSON', raw: String(content).slice(0, 4000) };
    // normalize arrays so the UI never crashes on a missing key
    for (const k of ['strengths', 'weaknesses', 'safety_issues', 'hallucinations', 'omissions', 'recommendations']) {
      if (!Array.isArray(parsed[k])) parsed[k] = parsed[k] ? [String(parsed[k])] : [];
    }
    if (!Array.isArray(parsed.dimensions)) parsed.dimensions = [];
    parsed.model = MODEL();
    parsed.generatedAt = new Date().toISOString();
    return { ok: true, ...parsed };
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'DeepSeek request timed out' : e.message;
    return { ok: false, error: msg, hint: 'Check DEEPSEEK_API_KEY / network egress to api.deepseek.com.' };
  } finally { clearTimeout(timer); }
}
