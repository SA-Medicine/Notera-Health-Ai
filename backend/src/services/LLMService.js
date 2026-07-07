// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — LLMService (Node / Cloud Run)
// Node-adapted port of the browser LLMService. Key comes from env/Secret Manager.
// Generation model is Gemini (doc 06). Thinking is DISABLED by default.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const AI_STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const MODEL_TIERS = {
  pro:   process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_PRO || 'gemini-3.5-flash',
  flash: process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_FLASH || 'gemini-3.5-flash',
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
  }

  _endpoint(stream = false) {
    const verb = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    if (this.backend === 'vertex') {
      const host = `https://${this.location}-aiplatform.googleapis.com`;
      const base = `${host}/v1/projects/${this.project}/locations/${this.location}/publishers/google/models`;
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
    const url = this._endpoint(false);
    const timeoutMs = options.timeoutMs || 120000;
    const retries = options.retries !== undefined ? Math.max(options.retries, 2) : 2;
    const maxOutputTokens = options.maxOutputTokens || Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 32768;

    const body = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens },
    };
    // Thinking DISABLED by default (do not use thinking); callers may override.
    body.generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget ?? 0 };
    if (process.env.GEMINI_TEMPERATURE) body.generationConfig.temperature = Number(process.env.GEMINI_TEMPERATURE);
    if (responseSchema) {
      body.generationConfig.responseMimeType = 'application/json';
      if (typeof responseSchema === 'object') body.generationConfig.responseSchema = responseSchema;
    }

    const headers = await this._authHeaders();
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
          if ([429, 500, 502, 503, 504].includes(response.status) && attempt < retries) {
            lastErr = new Error(`Gemini API ${response.status} (retrying)`);
            continue;
          }
          throw new Error(`Gemini API Error ${response.status}: ${JSON.stringify(errorData)}`);
        }
        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch (err) {
        lastErr = err && err.name === 'AbortError'
          ? new Error(`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s`)
          : err;
        if (attempt < retries && (err?.name === 'AbortError' || err?.name === 'TypeError' ||
            /fetch failed|network/i.test(err?.message || ''))) continue;
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
