// LLMService for Gemini REST API
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export class LLMService {
  constructor(apiKey, model = 'gemini-3-flash-preview') {
    if (!apiKey) {
      throw new Error('Gemini API key is required');
    }
    this.apiKey = apiKey;
    this.model = model;
  }

  async generateContent(systemInstruction, userPrompt, responseSchema = null, options = {}) {
    const url = `${GEMINI_API_BASE}/${this.model}:generateContent?key=${this.apiKey}`;

    // Per-request timeout so a slow/hanging response can never block the pipeline forever.
    // Default 120s gives ~2x headroom over the slowest legit call (~52s observed); callers
    // override (heavy extraction/synthesis get more, optional recovery gets less).
    const timeoutMs = options.timeoutMs || 120000;
    // One automatic retry on a timeout / transient network error — a single slow request
    // shouldn't kill the whole note (this is what crashed patient1). Optional callers can
    // pass retries:0 to disable.
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
      body.generationConfig.responseMimeType = "application/json";
      if (typeof responseSchema === 'object') {
        body.generationConfig.responseSchema = responseSchema;
      }
    }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          // Retry transient 429/500/503; fail fast on 4xx like bad key.
          if ([429, 500, 502, 503, 504].includes(response.status) && attempt < retries) {
            lastErr = new Error(`Gemini API ${response.status} (retrying)`);
            continue;
          }
          throw new Error(`Gemini API Error ${response.status}: ${JSON.stringify(errorData)}`);
        }
        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch (err) {
        lastErr = (err && err.name === 'AbortError')
          ? new Error(`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s`)
          : err;
        // retry on timeout/network error; otherwise rethrow
        if (attempt < retries && (err?.name === 'AbortError' || err?.name === 'TypeError' || /fetch failed|network/i.test(err?.message || ''))) {
          continue;
        }
        throw lastErr;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error('Gemini request failed');
  }

  async* generateContentStream(systemInstruction, userPromptOrMessages) {
    const url = `${GEMINI_API_BASE}/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    
    let contents = [];
    if (Array.isArray(userPromptOrMessages)) {
      contents = userPromptOrMessages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      }));
    } else {
      contents = [{
        role: 'user',
        parts: [{ text: userPromptOrMessages }]
      }];
    }

    const body = {
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: contents,
      generationConfig: {}
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Gemini API Error ${response.status}: ${JSON.stringify(errorData)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep incomplete last line

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
    } finally {
      reader.releaseLock();
    }
  }
}

export async function createGeminiService(apiKey = null) {
  if (!apiKey) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const data = await chrome.storage.local.get('dasSettings');
      apiKey = data.dasSettings?.geminiKey;
    } else {
      try {
        const data = JSON.parse(localStorage.getItem('dasSettings') || '{}');
        apiKey = data?.geminiKey;
      } catch (e) {}
    }
  }
  if (!apiKey) {
    throw new Error('Gemini API Key is missing. Please configure it in settings.');
  }
  return new LLMService(apiKey);
}
