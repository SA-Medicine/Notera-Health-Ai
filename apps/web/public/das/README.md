# das/ — embedded clinical scribe (dual-purpose)

This folder is the original DAS clinical-scribe app, preserved intact. It serves
**two** roles from one copy of the code:

1. **Embedded web app** — Next.js serves `/das/webapp/index.html`, which the
   logged-in `/app` route embeds full-screen. This is the "same as the extension
   webapp" experience.
2. **Loadable Chrome extension** — the extension shell (`manifest.json`,
   `background.js`, `content.js`, `options.*`, `icons/`) lives here too, so you can
   still `Load unpacked` this folder in `chrome://extensions` if you want the
   browser extension (EHR paste-inject, etc.).

```
das/
├── manifest.json, background.js, content.js, options.*   ← Chrome-extension shell
├── icons/
├── webapp/        ← the UI (index.html, app.js, app.css, marked)
├── pipeline/      ← the multi-agent engine (client-side copy)
└── services/      ← LLMService (now routes through the backend proxy)
```

## API keys stay in `.env`

`services/LLMService.js` and the recording (ASR) calls do **not** hold any API key.
They call the backend proxy (`/backend/api/llm/*`, `/backend/api/asr`), which
injects the real Gemini/Groq keys from the server's `.env`. Nothing sensitive ships
to the browser.

> The `pipeline/` here is a client-side copy. The server-side copy the backend
> orchestrator uses lives at `backend/src/pipeline/`. They are kept in sync; both
> are the same ported engine.
