// LLMService (embedded client) — routes through the Notera backend proxy so the
// Gemini API key stays in .env and never appears in the frontend.
const PROXY_GEN    = '/backend/api/llm/generate';
const PROXY_STREAM = '/backend/api/llm/stream';

export class LLMService {
  constructor(apiKey = null, model = 'gemini-3-flash-preview') {
    // apiKey is ignored — the backend proxy injects the real key from .env.
    this.model = model;
  }

  async generateContent(systemInstruction, userPrompt, responseSchema = null, options = {}) {
    const timeoutMs = options.timeoutMs || 120000;
    const retries = options.retries !== undefined ? options.retries : 1;
    const maxOutputTokens = options.maxOutputTokens || 32768;

    const body = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens },
    };
    if (options.thinkingBudget !== undefined) {
      body.generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget };
    }
    if (responseSchema) {
      body.generationConfig.responseMimeType = 'application/json';
      if (typeof responseSchema === 'object') body.generationConfig.responseSchema = responseSchema;
    }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${PROXY_GEN}?model=${encodeURIComponent(this.model)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          if ([429, 500, 502, 503, 504].includes(response.status) && attempt < retries) { lastErr = new Error(`LLM ${response.status} (retrying)`); continue; }
          throw new Error(`LLM proxy ${response.status}: ${JSON.stringify(errData)}`);
        }
        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch (err) {
        lastErr = err && err.name === 'AbortError' ? new Error(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s`) : err;
        if (attempt < retries && (err?.name === 'AbortError' || err?.name === 'TypeError' || /fetch failed|network/i.test(err?.message || ''))) continue;
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

// No key needed anymore — the proxy supplies it from .env.
export async function createGeminiService() {
  return new LLMService();
}
