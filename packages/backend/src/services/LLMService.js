// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — LLMService (Node / Cloud Run)
// Node-adapted port of the browser LLMService. Key comes from env/Secret Manager.
// Generation model is Gemini (doc 06). Thinking is DISABLED by default.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { AsyncLocalStorage } from 'node:async_hooks';
// Per-call default-model override (lab experiments: run the multi-agent pipeline on another model without touching env).
const _modelStore = new AsyncLocalStorage();
export const runWithModel = (model, fn) => (model ? _modelStore.run({ model }, fn) : fn());
// Every call made inside withUsage(fn) is listed (model, agent, tokens), so one note's cost can be counted even while another note runs at the same time.
const _usageStore = new AsyncLocalStorage();
export async function withUsage(fn) { const calls = []; const result = await _usageStore.run(calls, fn); return { result, calls }; }
const AI_STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const MODEL_TIERS = {
  pro:   process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_PRO || 'gemini-3.5-flash',
  flash: process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_FLASH || 'gemini-3.5-flash',
};

let _googleAuth = null;

// POST with an overall deadline and an optional HEDGE: if no usable answer arrives within
// `hedgeMs`, fire ONE identical request in parallel and take whichever answers first (the
// loser is aborted). Vertex `global` is shared capacity and an occasional call stalls for
// 30-60s while an identical retry returns in ~2s — hedging beats waiting out a timeout.
// A 429/5xx counts as "not usable" while another attempt is still pending. Returns
// { status, text } (the body is read here so aborting the loser can't truncate the winner).
export async function hedgedPost(url, headers, body, timeoutMs, hedgeMs, altUrl = null) {
  const ctrls = [];
  const bad = (s) => s === 429 || s >= 500;
  // The 2nd attempt goes to `altUrl` (the FALLBACK model) when given, else repeats `url`.
  const launch = () => {
    const c = new AbortController(); ctrls.push(c);
    return fetch(ctrls.length > 1 && altUrl ? altUrl : url, { method: 'POST', headers, body, signal: c.signal })
      .then(async (r) => ({ status: r.status, text: await r.text() }));
  };
  const overall = setTimeout(() => ctrls.forEach((c) => c.abort()), timeoutMs);
  let hedgeTimer;
  try {
    const attempts = [launch()];
    const useHedge = hedgeMs > 0 && hedgeMs < timeoutMs;
    const hedgeFired = useHedge ? new Promise((res) => { hedgeTimer = setTimeout(() => res('hedge'), hedgeMs); }) : null;
    let firstErr;
    const settled = [];
    for (;;) {
      const racers = attempts.map((p, i) => p.then((v) => ({ i, v }), (e) => ({ i, e })));
      const pending = racers.filter((_, i) => !settled.includes(i));
      const evt = await Promise.race([...pending, ...(hedgeFired && attempts.length === 1 ? [hedgeFired] : [])]);
      if (evt === 'hedge') { attempts.push(launch()); continue; }
      settled.push(evt.i);
      if (evt.v && !bad(evt.v.status)) return evt.v;                  // usable answer wins
      if (evt.e && evt.e.name !== 'AbortError') firstErr ||= evt.e;
      else if (evt.e) firstErr ||= evt.e;
      if (evt.v && !firstErr) firstErr = evt.v;                        // remember a 429/5xx body
      // The primary model failed fast (429/5xx/connection) — go straight to the fallback model
      // instead of waiting for the hedge timer. One hop only; never a chain.
      if (altUrl && attempts.length === 1 && evt.i === 0 && !(evt.e && evt.e.name === 'AbortError')) { attempts.push(launch()); continue; }
      if (settled.length >= attempts.length) {
        if (firstErr && firstErr.status) return firstErr;
        throw firstErr || new Error('request failed');
      }
    }
  } finally {
    clearTimeout(overall); clearTimeout(hedgeTimer);
    ctrls.forEach((c) => { try { c.abort(); } catch { /* */ } });
  }
}

export class LLMService {
  constructor(opts = {}) {
    const {
      apiKey = process.env.GEMINI_API_KEY,
      model = _modelStore.getStore()?.model || MODEL_TIERS.pro,
      backend = process.env.LLM_BACKEND || 'ai_studio',
    } = opts;
    this.backend = backend;
    this.model = model;
    if (backend === 'ai_studio' && !apiKey) {
      throw new Error('GEMINI_API_KEY is missing. Set it in the environment / Secret Manager.');
    }
    this.apiKey = apiKey;
    this.project = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    this.location = process.env.VERTEX_LOCATION || 'us-central1';
    this._tokenUsage = {};   // per-agent token tally for this run (see get/resetTokenUsage)
  }

  // Per-agent token accounting. Callers set `llm._agent = '<agent>'` before a call; every
  // response's usageMetadata is attributed to that agent and accumulated here.
  resetTokenUsage() { this._tokenUsage = {}; }
  getTokenUsage() {
    const perAgent = this._tokenUsage;
    const totals = Object.values(perAgent).reduce(
      (a, r) => ({ prompt: a.prompt + r.prompt, output: a.output + r.output, total: a.total + r.total, calls: a.calls + r.calls }),
      { prompt: 0, output: 0, total: 0, calls: 0 });
    return { perAgent, totals };
  }
  _recordTokens(usage) {
    const agent = this._agent || 'unknown';
    const rec = (this._tokenUsage[agent] ||= { prompt: 0, output: 0, total: 0, calls: 0 });
    const p = Number(usage?.promptTokenCount || 0);
    const o = Number(usage?.candidatesTokenCount || 0);
    const t = Number(usage?.totalTokenCount || (p + o));
    rec.prompt += p; rec.output += o; rec.total += t; rec.calls += 1;
    const th = Number(usage?.thoughtsTokenCount || 0);
    _usageStore.getStore()?.push({ model: this.model, agent, prompt: p, output: o, thoughts: th });
    console.log(`[tokens] ${agent}: prompt=${p} output=${o} total=${t}${th ? ` thoughts=${th}` : ''} (model=${this.model})`);
  }

  _endpoint(stream = false, model = this.model) {
    const verb = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    if (this.backend === 'vertex') {
      // `global` = Vertex's dynamic worldwide fleet → cheapest (no regional localization premium).
      // A pinned region (e.g. us-central1) is used only when data residency/sovereignty requires it.
      const loc = this.location;
      const host = loc === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${loc}-aiplatform.googleapis.com`;
      const base = `${host}/v1/projects/${this.project}/locations/${loc}/publishers/google/models`;
      return `${base}/${model}:${verb}`;
    }
    const key = `key=${this.apiKey}`;
    const sep = verb.includes('?') ? '&' : '?';
    return `${AI_STUDIO_BASE}/${model}:${verb}${sep}${key}`;
  }

  async _authHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.backend === 'vertex') {
      // One shared GoogleAuth per process: it caches/refreshes the token, so we don't pay a
      // token round-trip (~100-400ms) on every LLM call.
      if (!_googleAuth) {
        const { GoogleAuth } = await import('google-auth-library');
        _googleAuth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
      }
      const token = await _googleAuth.getAccessToken();
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async generateContent(systemInstruction, userPrompt, responseSchema = null, options = {}) {
    // When GEMINI_PROXY_URL is set, route through the SAME backend proxy the website uses
    // (POST /api/llm/generate) instead of calling Gemini directly — identical response
    // shape, plus the proxy's retry + schema/token fallbacks. This makes the auto-tester
    // succeed whenever the backend does (same key, same working network path).
    const proxyBase = (process.env.GEMINI_PROXY_URL || process.env.LLM_PROXY_URL || '').replace(/\/+$/, '');
    // Ordered endpoints to try: the backend proxy on BOTH loopback families (the backend
    // may listen on 127.0.0.1 OR ::1), then a direct Gemini call as last resort. Advance
    // to the next only on a CONNECTION error, so the fast reliable proxy is always used
    // when the backend is up on either family.
    const proxyVariants = (b) => {
      if (!b) return [];
      const set = new Set([b]);
      if (/127\.0\.0\.1/.test(b)) set.add(b.replace('127.0.0.1', '[::1]'));
      else if (/\[::1\]/.test(b)) set.add(b.replace('[::1]', '127.0.0.1'));
      else if (/localhost/i.test(b)) { set.add(b.replace(/localhost/i, '127.0.0.1')); set.add(b.replace(/localhost/i, '[::1]')); }
      return [...set];
    };
    const targets = [
      ...proxyVariants(proxyBase).map((b) => ({ proxy: true, url: `${b}/api/llm/generate?model=${encodeURIComponent(this.model)}` })),
      { proxy: false, url: this._endpoint(false) },
    ];
    let ti = 0;
    let usingProxy = targets[ti].proxy;
    let url = targets[ti].url;
    // Per-call timeout. Default 60s (was 120s): the slowest legitimate call (observation
    // extractor) runs ~34s, so 60s is comfortable headroom while a HUNG endpoint (e.g. the
    // qa-validator that once sat for 181s) aborts far sooner. Tunable via LLM_TIMEOUT_MS.
    const timeoutMs = options.timeoutMs || Number(process.env.LLM_TIMEOUT_MS) || 60000;
    let timedOutOnce = false;   // a timeout may retry at MOST once (never multiply wall-clock)
    // Honour the caller's `retries` (previously floored to 2 and padded by the endpoint count,
    // so every call made >=4 attempts). Default 1 retry; only 429/5xx/connection errors retry.
    const retries = (options.retries !== undefined ? options.retries : Number(process.env.LLM_RETRIES ?? 1)) + (targets.length - 1);
    // Hedge: duplicate a SLOW small call instead of waiting out a timeout (see hedgedPost).
    // Fallback model (GEMINI_FALLBACK_MODEL, e.g. gemini-2.5-flash): used as the hedge target and
    // when the primary fails fast. Same region; skipped on the proxy path.
    const fbModel = options.fallbackModel !== undefined ? options.fallbackModel : (process.env.GEMINI_FALLBACK_MODEL || '');
    const altUrl = (fbModel && fbModel !== this.model && this.backend !== 'proxy') ? this._endpoint(false, fbModel) : null;
    const hedgeMs = options.hedgeMs !== undefined ? options.hedgeMs
      : (process.env.LLM_HEDGE_MS !== undefined ? Number(process.env.LLM_HEDGE_MS) : ((options.maxOutputTokens || 65536) <= 4000 ? 8000 : 0));
    // Output ceiling precedence: an explicit caller cap (prose generators) wins; then an
    // OPTIONAL per-agent cap from the environment (keyed by this._agent); then the full default.
    // Per-agent caps let you bound each stage independently, e.g.:
    //   CLINICAL_STORY_MAX_OUTPUT_TOKENS, EXTRACTOR_MAX_OUTPUT_TOKENS,
    //   QA_MAX_OUTPUT_TOKENS, FACT_RECOVERY_MAX_OUTPUT_TOKENS
    const AGENT_CAP_ENV = {
      'clinical-story': 'CLINICAL_STORY_MAX_OUTPUT_TOKENS',
      'observation-extractor': 'EXTRACTOR_MAX_OUTPUT_TOKENS',
      'qa-validator': 'QA_MAX_OUTPUT_TOKENS',
      'fact-recovery': 'FACT_RECOVERY_MAX_OUTPUT_TOKENS',
      'story-composer': 'STORY_COMPOSER_MAX_OUTPUT_TOKENS',
      'tightener': 'TIGHTENER_MAX_OUTPUT_TOKENS',
      'hallucination-remover': 'HALLUCINATION_REMOVER_MAX_OUTPUT_TOKENS',
    };
    const agentCap = Number(process.env[AGENT_CAP_ENV[this._agent]] || 0) || 0;
    // The per-agent env cap is a HARD CEILING: clamp whatever the caller requested (or the
    // default) so it applies even for stages that pass their own maxOutputTokens.
    let maxOutputTokens = options.maxOutputTokens || 65536;
    if (agentCap) maxOutputTokens = Math.min(maxOutputTokens, agentCap);

    const body = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens },
    };
    // Reasoning depth (gemini-3.x). GEMINI_THINKING_LEVEL / options.thinkingLevel = high|low|off.
    // Legacy thinkingBudget still honored if a caller passes it explicitly.
    const thinkingLevel = options.thinkingLevel ?? process.env.GEMINI_THINKING_LEVEL;
    if (options.thinkingBudget !== undefined) body.generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget };
    else if (thinkingLevel && String(thinkingLevel).toLowerCase() !== 'off') body.generationConfig.thinkingConfig = { thinkingLevel: String(thinkingLevel).toLowerCase() };
    else body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    // LLM_THINKING=off sends every pipeline call with thinking off. Not the default: the paired gold A/B of 2026-10-24 (same judges, 29 notes) scored
    // thinking off 65.6 vs 75.3, 0.90 vs 0.66 critical misses per note, for 6 s saved per note (32 vs 38 s).
    // gemini-2.5-pro refuses a budget of 0 (400), so it gets its minimum, 128. gemini-3.5-flash-lite obeys 0; gemini-3.7/3.8-flash and
    // gemini-3.1-pro-preview accept 0 but still think (~1,000 and ~3,000 tokens), which no setting stops.
    // Judges and auditors keep their own budgets: they only measure, and every A/B must be scored by the same judge.
    if (process.env.LLM_THINKING === 'off' && !/judge|audit/.test(this._agent || '')) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    // LLM_THINKING_SCALE (e.g. 2) multiplies the budget of every pipeline stage that already thinks (judges excluded), with the same room added to the output cap
    const scale = Number(process.env.LLM_THINKING_SCALE || 1); const tb = body.generationConfig.thinkingConfig.thinkingBudget;
    if (scale > 1 && tb > 0 && !/judge|audit/.test(this._agent || '')) { const nb = Math.min(8192, Math.round(tb * scale)); body.generationConfig.thinkingConfig = { thinkingBudget: nb }; body.generationConfig.maxOutputTokens = Math.min(65536, body.generationConfig.maxOutputTokens + nb - tb); }
    if (/^gemini-2\.5-pro/.test(this.model) && body.generationConfig.thinkingConfig.thinkingBudget === 0) body.generationConfig.thinkingConfig = { thinkingBudget: 128 };
    // gemini-3.1-pro-preview ignores a budget of 0 on long prompts (~3,070 thought tokens on the writer prompt, measured on 30 gold notes): the thinking
    // counts against maxOutputTokens, so without room on top the note was cut off after ~116 tokens. Pro models get 8,000 extra.
    if (/-pro/.test(this.model)) body.generationConfig.maxOutputTokens = Math.min(65536, maxOutputTokens + 8000);
    if (options.temperature !== undefined) body.generationConfig.temperature = options.temperature;
    else if (process.env.GEMINI_TEMPERATURE) body.generationConfig.temperature = Number(process.env.GEMINI_TEMPERATURE);
    // Sampling controls (hyper-parameters). Per-call options win over GEMINI_* env defaults; unset = model default.
    for (const [key, env] of [['topP', 'GEMINI_TOP_P'], ['topK', 'GEMINI_TOP_K'], ['seed', 'GEMINI_SEED'], ['frequencyPenalty', 'GEMINI_FREQ_PENALTY'], ['presencePenalty', 'GEMINI_PRES_PENALTY']]) {
      const v = options[key] !== undefined ? options[key] : (process.env[env] !== undefined && process.env[env] !== '' ? Number(process.env[env]) : undefined);
      if (v !== undefined && Number.isFinite(v)) body.generationConfig[key] = v;
    }
    if (Array.isArray(options.stopSequences) && options.stopSequences.length) body.generationConfig.stopSequences = options.stopSequences;
    if (options.candidateCount) body.generationConfig.candidateCount = options.candidateCount;
    if (responseSchema) {
      body.generationConfig.responseMimeType = 'application/json';
      if (typeof responseSchema === 'object') body.generationConfig.responseSchema = responseSchema;
    } else if (options.responseMimeType) {
      // JSON mode without a schema: constrained decoding guarantees syntactically
      // valid JSON (fixes prompts that embed nested JSON and mis-escape it).
      body.generationConfig.responseMimeType = options.responseMimeType;
    }

    let headers = usingProxy ? { 'Content-Type': 'application/json' } : await this._authHeaders();
    let lastErr;
    try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await hedgedPost(url, headers, JSON.stringify(body), timeoutMs, hedgeMs, usingProxy ? null : altUrl);
        response.ok = response.status >= 200 && response.status < 300;
        if (!response.ok) {
          let errorData = {}; try { errorData = JSON.parse(response.text); } catch { /* */ }
          // A 500 while constraining to a large responseSchema → drop the schema and retry.
          if (response.status === 500 && body.generationConfig.responseSchema) {
            delete body.generationConfig.responseSchema;
            lastErr = new Error('Gemini 500 with responseSchema — retrying without schema');
            continue;
          }
          // If an endpoint/model doesn't accept the new thinkingLevel field, fall back to
          // disabling thinking so the call still succeeds (never break on config mismatch).
          if (response.status === 400 && body.generationConfig.thinkingConfig?.thinkingLevel &&
              /thinking|thinkingLevel|unknown name|invalid/i.test(JSON.stringify(errorData))) {
            body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
            lastErr = new Error('Gemini 400 with thinkingLevel — retrying without it');
            continue;
          }
          // A model that doesn't accept a sampling parameter (penalties/topK/seed) → drop them and retry.
          if (response.status === 400 && /penalt|topK|top_k|seed|topP/i.test(JSON.stringify(errorData)) &&
              ['frequencyPenalty', 'presencePenalty', 'topK', 'seed'].some((k) => k in body.generationConfig)) {
            for (const k of ['frequencyPenalty', 'presencePenalty', 'topK', 'seed']) delete body.generationConfig[k];
            lastErr = new Error('Gemini 400 with a sampling parameter — retrying without it');
            continue;
          }
          // If a model rejects bare JSON mode (responseMimeType without schema), drop it
          // and retry as plain text — the caller's robust parser handles the raw output.
          if (response.status === 400 && body.generationConfig.responseMimeType && !body.generationConfig.responseSchema &&
              /mime|responseMimeType|json|unknown name|invalid/i.test(JSON.stringify(errorData))) {
            delete body.generationConfig.responseMimeType;
            lastErr = new Error('Gemini 400 with responseMimeType — retrying as text');
            continue;
          }
          if ([429, 500, 502, 503, 504].includes(response.status) && attempt < retries) {
            lastErr = new Error(`Gemini API ${response.status} (retrying)`);
            // Exponential backoff with jitter — a 429 (RESOURCE_EXHAUSTED) or 5xx means the
            // endpoint is overloaded/throttled; retrying INSTANTLY just hammers it and makes
            // the throttle worse. Wait 1s, 2s, 4s… (capped 10s) so quota has time to recover.
            const wait = Math.min(10000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 400);
            console.warn(`[LLMService] ${response.status} on ${this._agent || 'llm'} — backing off ${wait}ms before retry ${attempt + 1}/${retries}`);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw new Error(`Gemini API Error ${response.status}: ${JSON.stringify(errorData)}`);
        }
        // Read as text first: some upstreams (and proxies) return a plain-text body
        // like "Internal Server Error" even on a 2xx, which would make response.json()
        // throw a cryptic "Unexpected token 'I'". Parse defensively and, if it's not
        // JSON, retry (transient) or surface the real body.
        const raw = response.text;
        let data;
        try { data = JSON.parse(raw); }
        catch {
          const where = usingProxy ? `proxy ${url}` : 'Gemini API';
          lastErr = new Error(`${where} returned non-JSON (${response.status}): ${String(raw).slice(0, 180)}`);
          if (attempt < retries) continue;
          throw lastErr;
        }
        this._recordTokens(data.usageMetadata);
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch (err) {
        const connErr = err?.name === 'TypeError' || !!err?.cause?.code || /fetch failed|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|network/i.test(err?.message || '');
        // Local proxy unreachable (e.g. backend on ::1 not 127.0.0.1)? Fall back to
        // calling Gemini directly with the key — the machine can reach Gemini.
        if (connErr && ti < targets.length - 1) {
          ti++; usingProxy = targets[ti].proxy; url = targets[ti].url;
          headers = usingProxy ? { 'Content-Type': 'application/json' } : await this._authHeaders();
          console.warn(`[LLMService] endpoint unreachable (${err?.cause?.code || err?.message}); trying ${usingProxy ? 'proxy ' + url : 'direct Gemini'}`);
          lastErr = err; continue;
        }
        const where = usingProxy ? `proxy ${url}` : 'Gemini API';
        const isTimeout = err && err.name === 'AbortError';
        lastErr = isTimeout
          ? new Error(`${where} timed out after ${Math.round(timeoutMs / 1000)}s`)
          : new Error(`${where} request failed: ${err?.message || err} (cause: ${err?.cause?.code || 'n/a'})`);
        if (attempt < retries) {
          // A TIMEOUT retries at most ONCE — a slow endpoint rarely recovers on an immediate
          // retry, and retrying every time is what turned a 60s hang into 181s of wall-clock.
          if (isTimeout && options.retryOnTimeout && !timedOutOnce) { timedOutOnce = true; continue; }
          if (isTimeout) throw lastErr;   // never retry a timeout: hedging covers slow calls
          // Network/transient errors still retry freely.
          if (!isTimeout && (err?.name === 'TypeError' || /fetch failed|network/i.test(err?.message || ''))) continue;
        }
        throw lastErr;
      }
    }
    throw lastErr || new Error('Gemini request failed');
    } catch (err) {
      // Monitoring: log the terminal API error to the ops error log (fire-and-forget), then rethrow.
      try {
        const m = String(err?.message || err);
        const code = /\b(\d{3})\b/.test(m) ? `GEMINI_${m.match(/\b(\d{3})\b/)[1]}`
          : (/timed out/i.test(m) ? 'GEMINI_TIMEOUT' : 'GEMINI_ERROR');
        import('../ops/opsLog.js').then(({ recordError }) => recordError({
          source: 'pipeline', agent: this._agent, level: 'error', code, message: m,
          context: { model: this.model, backend: this.backend },
        })).catch(() => {});
      } catch { /* never break generation */ }
      throw err;
    }
  }

  async* generateContentStream(systemInstruction, userPromptOrMessages) {
    const url = this._endpoint(true);
    let contents;
    if (Array.isArray(userPromptOrMessages)) {
      contents = userPromptOrMessages.map((msg) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      }));
    } else {
      contents = [{ role: 'user', parts: [{ text: userPromptOrMessages }] }];
    }
    const headers = await this._authHeaders();
    const response = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Gemini API Error ${response.status}: ${JSON.stringify(errorData)}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const content = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (content) yield content;
          } catch (_) { /* ignore malformed SSE line */ }
        }
      }
    } finally { reader.releaseLock(); }
  }
}

export async function createGeminiService(apiKey = null, opts = {}) {
  return new LLMService({ apiKey: apiKey || process.env.GEMINI_API_KEY, ...opts });
}
