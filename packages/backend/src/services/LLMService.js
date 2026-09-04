// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — LLMService (Node / Cloud Run)
// Node-adapted port of the browser LLMService. Key comes from env/Secret Manager.
// Generation model is Gemini (doc 06). Thinking is DISABLED by default.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const AI_STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const MODEL_TIERS = {
  pro:   process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_PRO || 'gemini-3.7-flash',
  flash: process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_FLASH || 'gemini-3.7-flash',
};

export class LLMService {
  constructor(opts = {}) {
    const {
      apiKey = process.env.GEMINI_API_KEY,
      model = MODEL_TIERS.pro,
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
    console.log(`[tokens] ${agent}: prompt=${p} output=${o} total=${t} (model=${this.model})`);
  }

  _endpoint(stream = false) {
    const verb = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    if (this.backend === 'vertex') {
      // `global` = Vertex's dynamic worldwide fleet → cheapest (no regional localization premium).
      // A pinned region (e.g. us-central1) is used only when data residency/sovereignty requires it.
      const loc = this.location;
      const host = loc === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${loc}-aiplatform.googleapis.com`;
      const base = `${host}/v1/projects/${this.project}/locations/${loc}/publishers/google/models`;
      return `${base}/${this.model}:${verb}`;
    }
    const key = `key=${this.apiKey}`;
    const sep = verb.includes('?') ? '&' : '?';
    return `${AI_STUDIO_BASE}/${this.model}:${verb}${sep}${key}`;
  }

  async _authHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.backend === 'vertex') {
      const { GoogleAuth } = await import('google-auth-library');
      const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
      const token = await auth.getAccessToken();
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
    const retries = (options.retries !== undefined ? Math.max(options.retries, 2) : 2) + targets.length;
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
    if (options.temperature !== undefined) body.generationConfig.temperature = options.temperature;
    else if (process.env.GEMINI_TEMPERATURE) body.generationConfig.temperature = Number(process.env.GEMINI_TEMPERATURE);
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
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
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
        const raw = await response.text();
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
          if (isTimeout && !timedOutOnce) { timedOutOnce = true; continue; }
          // Network/transient errors still retry freely.
          if (!isTimeout && (err?.name === 'TypeError' || /fetch failed|network/i.test(err?.message || ''))) continue;
        }
        throw lastErr;
      } finally { clearTimeout(timer); }
    }
    throw lastErr || new Error('Gemini request failed');
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
