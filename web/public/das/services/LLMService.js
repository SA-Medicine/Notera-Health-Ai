// LLMService (embedded client) — routes through the Notera backend proxy so the
// Gemini API key stays in .env and never appears in the frontend.
//
// Resilience: on a 500 while using a large responseSchema (some preview models
// intermittently 500 on complex structured-output schemas), it automatically
// retries WITHOUT the schema (plain JSON mode). safeParseJson downstream repairs
// any imperfect JSON, so we recover instead of failing the whole pipeline.
// In dev the app is served by Next on :3000 but the backend runs on :8080. Calling
// the backend DIRECTLY (CORS-enabled) avoids the Next rewrite proxy, whose socket
// timeout was killing the slow ~90s extraction call. In prod, use the /backend rewrite.
const API_BASE = (typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname))
  ? (window.NOTERA_BACKEND || 'http://localhost:8080')
  : '/backend';
const PROXY_GEN    = `${API_BASE}/api/llm/generate`;
const PROXY_STREAM = `${API_BASE}/api/llm/stream`;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class LLMService {
  constructor(apiKey = null, model = 'gemini-3.5-flash') {
    // apiKey is ignored — the backend proxy injects the real key from .env.
    this.model = model;
  }

  async generateContent(systemInstruction, userPrompt, responseSchema = null, options = {}) {
    const timeoutMs = options.timeoutMs || 120000;
    const maxRetries = options.retries !== undefined ? Math.max(options.retries, 2) : 2;
    const maxOutputTokens = options.maxOutputTokens || 32768;
    let useSchema = !!responseSchema && typeof responseSchema === 'object';
    let lastErr;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const body = {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens },
      };
      if (options.thinkingBudget !== undefined) body.generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget };
      if (responseSchema) {
        body.generationConfig.responseMimeType = 'application/json'; // still ask for JSON
        if (useSchema) body.generationConfig.responseSchema = responseSchema;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(`${PROXY_GEN}?model=${encodeURIComponent(this.model)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const bodyText = await resp.text().catch(() => '');
          // A 500 while constraining to a big schema → drop the schema and retry.
          if (resp.status === 500 && useSchema) {
            useSchema = false;
            lastErr = new Error('LLM 500 with responseSchema — retrying without schema');
            continue;
          }
          if (RETRYABLE.has(resp.status) && attempt < maxRetries) {
            lastErr = new Error(`LLM ${resp.status} (retrying)`);
            continue;
          }
          // Surface the FULL upstream error (the proxy sends a detailed JSON payload).
          throw new Error(`LLM proxy ${resp.status}: ${bodyText || '(empty response)'}`);
        }
        const data = await resp.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch (err) {
        lastErr = err && err.name === 'AbortError' ? new Error(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s`) : err;
        if (attempt < maxRetries && (err?.name === 'AbortError' || err?.name === 'TypeError' || /fetch failed|network/i.test(err?.message || ''))) continue;
        throw lastErr;
      } finally { clearTimeout(timer); }
    }
    throw lastErr || new Error('LLM request failed');
  }

  async* generateContentStream(systemInstruction, userPromptOrMessages) {
    let contents;
    if (Array.isArray(userPromptOrMessages)) {
      contents = userPromptOrMessages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    } else {
      contents = [{ role: 'user', parts: [{ text: userPromptOrMessages }] }];
    }
    const response = await fetch(`${PROXY_STREAM}?model=${encodeURIComponent(this.model)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: systemInstruction }] }, contents, generationConfig: {} }),
    });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(`LLM proxy ${response.status}: ${JSON.stringify(e)}`); }

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
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try { const obj = JSON.parse(payload); const c = obj?.candidates?.[0]?.content?.parts?.[0]?.text; if (c) yield c; } catch (_) {}
        }
      }
    } finally { reader.releaseLock(); }
  }
}

export async function createGeminiService() { return new LLMService(); }
