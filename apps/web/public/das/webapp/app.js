/* ============================================================
   DAS — Clinical AI Scribe  v2.0  (Extension Webapp)
   Flow: Start → [recording, 20s chunks→Whisper] → Stop →
         auto-transcribe final → auto-redirect Note → auto-generate
   Storage: chrome.storage.local (extension) | localStorage (standalone)
   ============================================================ */
'use strict';

import { PipelineEngine } from '../pipeline/PipelineEngine.js';

// ── Runtime detection ──────────────────────────────────────────
const IS_EXT = typeof chrome !== 'undefined' && !!chrome?.storage?.local;

// ── Config ────────────────────────────────────────────────────
const GEMINI_BASE       = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL     = 'gemini-3.5-flash';
const NOTERA_API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) ? (window.NOTERA_BACKEND || 'http://localhost:8080') : '/backend';
const CHUNK_INTERVAL_MS = 20_000;  // rotate recorder every 20 s → valid WebM blob

// ── State ─────────────────────────────────────────────────────
let S = {
  phase:       'idle',      // idle | recording | done
  recorder:    null,
  stream:      null,
  startTime:   null,
  timerTick:   null,
  chunkTick:   null,
  audioBuffer: [],          // Blob[] since last Whisper call
  segments:    [],          // {text, ts}[]
  transcript:  '',
  note:        '',
  groqIdx:     0,
  chatHistory: [],
  sessionId:   null,
  duration:    0,
  // ── Suggestion memory ──
  shownSuggestions:    [],  // all suggestion texts shown this session (no repeats)
  lastTranscriptSent:  '',  // transcript snapshot from the previous suggestions call
  draftTick:           null,
  patientName:         'Add patient details',
  patientSubtitle:     'Confus, HIA',
};

// ── marked.js configuration ───────────────────────────────────
// breaks:true  → single newlines → <br> (AI notes use \n per item, not \n\n)
// gfm:true     → GitHub Flavored Markdown (**bold**, lists, etc.)
if (typeof marked !== 'undefined') {
  marked.use({ breaks: true, gfm: true });
}

// ── DOM shorthand ─────────────────────────────────────────────
const $  = id => document.getElementById(id);
const qs = s  => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Storage abstraction ───────────────────────────────────────
const store = {
  get: keys => IS_EXT
    ? new Promise(r => chrome.storage.local.get(keys, r))
    : Promise.resolve(Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map(k => {
          try { return [k, JSON.parse(localStorage.getItem(k))]; } catch { return [k, null]; }
        })
      )),
  set: obj => IS_EXT
    ? new Promise(r => chrome.storage.local.set(obj, r))
    : Promise.resolve(Object.entries(obj).forEach(([k, v]) =>
        localStorage.setItem(k, JSON.stringify(v))
      )),
};

async function getSettings() {
  const { dasSettings } = await store.get('dasSettings');
  return dasSettings || {};
}
async function saveSettings(obj) { await store.set({ dasSettings: obj }); }
async function getSessions()  {
  const { dasSessions } = await store.get('dasSessions');
  return dasSessions || [];
}
async function saveSessions(arr) { await store.set({ dasSessions: arr }); }

function groqKey(cfg) {
  const keys = [cfg.groqKey1, cfg.groqKey2, cfg.groqKey3].filter(Boolean);
  if (!keys.length) return 'via-backend-proxy';
  const k = keys[S.groqIdx % keys.length];
  S.groqIdx++;
  return k;
}
function geminiKey(cfg) {
  if (!cfg.geminiKey) return 'via-backend-proxy';
  return cfg.geminiKey;
}

// ── Templates ─────────────────────────────────────────────────
const NO_THINK = '\nCRITICAL: Output ONLY the final document. No reasoning, thinking, or preamble.';
const TEMPLATES = {
  soap: {
    label: 'SOAP Note',
    system: `You are DAS, an AI medical scribe. Convert the transcript into a compact, telegraphic, problem-oriented SOAP note.\${NO_THINK}

CRITICAL FORMATTING RULES:
- Telegraphic Phrasing: Write strictly in short, concise fragments. No complete sentences. Omit pronouns (he, she, they), articles (a, an, the), and filler phrases.
- No Direct Quotes: Never use quotation marks. Translate all patient complaints into objective clinical terminology.
- Output in standard sentence casing (NO ALL CAPS).
- Delimiter Rule: When appending descriptive detail to a symptom, lab result, or finding, use a space-hyphen-space ( - ) as the delimiter. NEVER use a colon for this. Example: "HbA1c 6.2 - improved from previous, goal <6".
- Tense Rule: All actions taken during the visit must use past or passive tense. NEVER use future tense. Correct: "Requisition provided for PSA." Incorrect: "Will provide PSA requisition."
- Zero-inference Extraction: Never add clinical specificity beyond the exact words spoken.
- Exclude Fluff: Strip all logistical details (directions, facility locations, scheduling mechanics) from the A&P.

STRUCTURE RULE — CRITICAL:
Every section header must appear on its OWN LINE. All content under it must be on SEPARATE BULLET LINES directly below. NEVER place content inline on the same line as the header.
CORRECT format:
**Presenting Complaints:**
- Anemia - iron deficiency, refractory to oral supplementation
- Fatigue

WRONG format (NEVER do this):
**Presenting Complaints:** Anemia - iron deficiency, fatigue

EXACT PERMITTED HEADERS — use ONLY these strings verbatim. No others allowed:
**Subjective:**
**Objective:**
**Assessment:**
**Plan:**
**Assessment & Plan:** (Allowed if combined)
Do NOT create: 'Medications', 'Family History', 'Imaging', 'Disease Management', or any other invented header.
Imaging orders and X-rays belong ONLY in the Assessment & Plan as a past-tense action.

SUBJECTIVE & OBJECTIVE RULES:
- Every single data point goes on its own bullet line.
- List pertinent negatives directly under **Associated Symptoms:**.
- Extract and print exact values for vital signs and blood work - each on its own bullet.

ASSESSMENT & PLAN (A&P) RULES:
- Numbered list of medical problems. Do NOT bold the numbered items (e.g., "1. Diabetes mellitus", not "**1. Diabetes mellitus**").
- Under each problem, provide concise unlabelled bullet points mixing current status and actions taken.
- Nest all medication refills, lab requisitions, and referrals under their corresponding diagnosis. No standalone 'Medications' or 'Refills' section.
- Use exact diagnostic labels from the transcript only. Do not expand or reclassify.`,
  },
  soap_narrative: {
    label: 'SOAP Note (Subjective)',
    system: `You are DAS, an AI medical scribe. Write the Subjective section (History of Presenting Complaint) of a SOAP note.\${NO_THINK}

CRITICAL RULES FOR SUBJECTIVE SECTION (HPI):
- Write in a professional but humanized narrative format.
- Use complete sentences, active verbs, and clear chronological storytelling to explain the patient's experience.
- Break the narrative down into readable, logically separated bullet points or short subsections (e.g., Onset & Mechanism, Quality & Severity, Progression, Context). Do NOT write one massive paragraph.
- Ensure the "story" of the patient's complaint is easy to follow and visually scannable.
- Output the header "**History of Presenting Complaint:**" on its own line, followed by the structured narrative below it.
- Do NOT output any other sections.`,
  },
  soap_extraction: {
    label: 'SOAP Note (Objective & A&P)',
    system: `You are DAS, an AI medical scribe. Extract the Objective and Assessment & Plan sections of a SOAP note.\${NO_THINK}

CRITICAL RULES FOR OBJECTIVE & A&P SECTIONS:
- Switch to a strict, telegraphic formatting style.
- Use bullet points, fragment sentences, and prioritize data efficiency.
- Do not use conversational filler here. No complete sentences. Omit pronouns (he, she, they), articles (a, an, the), and filler phrases.
- No Direct Quotes: Translate all patient complaints into objective clinical terminology.
- Output in standard sentence casing (NO ALL CAPS).
- Delimiter Rule: When appending descriptive detail to a symptom, lab result, or finding, use a space-hyphen-space ( - ) as the delimiter. NEVER use a colon for this.
- Tense Rule: All actions taken during the visit must use past or passive tense. NEVER use future tense. Correct: "Requisition provided for PSA." Incorrect: "Will provide PSA requisition."
- Zero-inference Extraction: Never add clinical specificity beyond the exact words spoken.
- Exclude Fluff: Strip all logistical details (directions, facility locations, scheduling mechanics) from the A&P.

STRUCTURE RULE — CRITICAL:
Every section header must appear on its OWN LINE. All content under it must be on SEPARATE BULLET LINES directly below. NEVER place content inline on the same line as the header.
CORRECT format:
**Presenting Complaints:**
- Anemia - iron deficiency, refractory to oral supplementation
- Fatigue

EXACT PERMITTED HEADERS — use ONLY these strings verbatim. No others allowed:
**Presenting Complaints:**
**Associated Symptoms:**
**Diabetes Management:**
**Past Medical History:**
**Vital Signs:**
**Blood Work:**
Assessment & Plan:

Do NOT create 'History of Presenting Complaint' - this was handled already. Do NOT create: 'Medications', 'Family History', 'Imaging', 'Disease Management', or any other invented header.
Imaging orders and X-rays belong ONLY in the Assessment & Plan as a past-tense action.

SUBJECTIVE & OBJECTIVE RULES:
- Every single data point goes on its own bullet line.
- List pertinent negatives directly under **Associated Symptoms:**.
- Extract and print exact values for vital signs and blood work - each on its own bullet.

ASSESSMENT & PLAN (A&P) RULES:
- Numbered list of medical problems. Do NOT bold the numbered items.
- Under each problem, provide concise unlabelled bullet points mixing current status and actions taken.
- Nest all medication refills, lab requisitions, and referrals under their corresponding diagnosis. No standalone 'Medications' or 'Refills' section.
- Use exact diagnostic labels from the transcript only. Do not expand or reclassify.`,
  },
  summary: {
    label: 'Clinical Summary',
    system: `You are DAS, an AI medical scribe. Write a concise clinical summary.${NO_THINK}
Sections: PATIENT PRESENTATION | KEY FINDINGS | CLINICAL DECISION | NEXT STEPS`,
  },
  referral: {
    label: 'Referral Letter',
    system: `You are DAS, an AI medical scribe. Draft a formal referral letter.${NO_THINK}
Include: reason for referral, clinical summary, specific request to receiving clinician.`,
  },
  discharge: {
    label: 'Discharge Summary',
    system: `You are DAS, an AI medical scribe. Write a discharge summary.${NO_THINK}
Sections: ADMITTING DIAGNOSIS | HOSPITAL COURSE | PROCEDURES | MEDICATIONS AT DISCHARGE | DISCHARGE CONDITION | FOLLOW-UP`,
  },
  progress: {
    label: 'Progress Note',
    system: `You are DAS, an AI medical scribe. Write a progress note.${NO_THINK}
Sections: INTERVAL HISTORY | CURRENT STATUS | ASSESSMENT | PLAN UPDATES`,
  },
};

// ── SSE streaming parser ──────────────────────────────────────
async function* parseSSE(response) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let   buf     = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') return;
        yield payload;
      }
    }
  } finally { reader.releaseLock(); }
}

function stripThink(t) {
  return t.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*\n+/, '').trim();
}

function bestMime() {
  const candidates = [
    'audio/webm;codecs=opus', 'audio/webm',
    'audio/ogg;codecs=opus',  'audio/ogg',
    'audio/mp4',
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || 'audio/webm';
}

// ══════════════════════════════════════════════════════════════
//  RECORDING  —  Start / Stop only (no pause)
// ══════════════════════════════════════════════════════════════

async function startRecording() {
  if (S.phase !== 'idle') return;

  // Check keys before starting
  const cfg = await getSettings();
  try { groqKey(cfg); } catch (err) {
    toast(err.message, 'error');
    openSettings();
    return;
  }

  // Mic access
  try {
    const sel   = $('micSelect');
    const devId = sel?.value && sel.value !== 'default' ? { exact: sel.value } : undefined;
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: devId
        ? { deviceId: devId, echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
        : { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
    });
  } catch {
    toast('Microphone access denied — allow mic in browser settings', 'error');
    return;
  }

  // Reset state
  S.segments           = [];
  S.audioBuffer        = [];
  S.transcript         = '';
  S.note               = '';
  S.groqIdx            = 0;
  S.shownSuggestions   = [];
  S.lastTranscriptSent = '';
  S.startTime          = Date.now();
  S.sessionId          = 'ses_' + Date.now();
  S.phase              = 'recording';

  // Reset transcript UI
  $('transcriptLines').innerHTML = '';
  $('tEmpty').style.display      = 'flex';
  $('segCount').textContent      = '0 segments';

  // Build MediaRecorder — 2s timeslices for smooth buffer accumulation
  const mime     = bestMime();
  S.recorder     = new MediaRecorder(S.stream, { mimeType: mime });

  S.recorder.ondataavailable = e => {
    if (e.data?.size > 0) S.audioBuffer.push(e.data);
  };

  S.recorder.start(); // no timeslice — we stop/restart per chunk for valid WebM blobs

  // Periodic chunk: stop recorder → get complete blob → restart → send to Whisper
  S.chunkTick = setInterval(() => rotateAndFlush(), CHUNK_INTERVAL_MS);

  // Auto-save draft
  S.draftTick = setInterval(() => {
    if (S.transcript) {
      localStorage.setItem('dasDraft', JSON.stringify({
        transcript: S.transcript,
        segments: S.segments,
        duration: Math.floor((Date.now() - S.startTime) / 1000),
        patientName: S.patientName,
        patientSubtitle: S.patientSubtitle
      }));
    }
  }, 10000);

  startTimer();
  updateUI();
  setStatus('rec', 'Recording — consultation in progress');
  $('audioBars').classList.add('active');

  switchTab('transcript');
  toast('Recording started — speak clearly');
}

// ── Rotate recorder to get a complete, valid WebM blob every 20 s ──
async function rotateAndFlush() {
  if (S.phase !== 'recording' || !S.stream) return;
  if (!S.recorder || S.recorder.state === 'inactive') return;

  const mime    = S.recorder.mimeType || bestMime();
  const outgoing = S.recorder;

  // Start fresh recorder FIRST so there's zero audio gap
  const freshRec = new MediaRecorder(S.stream, { mimeType: mime });
  freshRec.ondataavailable = e => { /* captured in drainRecorder */ };
  S.recorder = freshRec;
  S.recorder.start();

  // Drain the outgoing recorder → complete valid WebM
  const chunks = await drainRecorder(outgoing);
  const blob   = new Blob(chunks, { type: mime });
  if (blob.size >= 1000) {   // at least 1 KB — skip silence
    await sendBlobToWhisper(blob, false);
  }
}

// Drain a MediaRecorder into chunks array
function drainRecorder(rec) {
  return new Promise(resolve => {
    const out = [];
    rec.ondataavailable = e => { if (e.data?.size > 0) out.push(e.data); };
    rec.onstop          = () => resolve(out);
    if (rec.state !== 'inactive') rec.stop();
    else resolve(out);
  });
}

async function stopRecording() {
  if (S.phase !== 'recording') return;

  // Immediately update phase so UI reflects stop
  S.phase = 'done';
  updateUI();

  clearInterval(S.timerTick);
  clearInterval(S.chunkTick);
  clearInterval(S.draftTick);

  // Drain final recorder → complete valid WebM
  const mime        = S.recorder?.mimeType || bestMime();
  const finalChunks = await drainRecorder(S.recorder);
  S.recorder = null;

  // Stop mic
  S.stream?.getTracks().forEach(t => t.stop());
  S.stream = null;

  S.duration = Math.floor((Date.now() - S.startTime) / 1000);
  $('audioBars').classList.remove('active');
  setStatus('loading', 'Transcribing final audio…');

  // Send final blob to Whisper
  const finalBlob = new Blob(finalChunks, { type: mime });
  if (finalBlob.size >= 300) {
    await sendBlobToWhisper(finalBlob, true);
  }

  if (!S.transcript.trim()) {
    setStatus('done', 'Session stopped — no speech detected');
    toast('No speech detected. Check mic and API key.', 'error');
    return;
  }

  setStatus('done', `Transcription complete — ${S.segments.length} segment(s) · generating note…`);
  toast(`${S.segments.length} segment(s) captured — generating note…`);

  // Auto-switch to Note tab and generate
  switchTab('note');
  await generateNote(true); // true = auto-triggered
}

// ── Send a complete blob to Groq Whisper ─────────────────────
async function sendBlobToWhisper(blob, isFinal) {
  if (!isFinal) setStatus('loading', 'Transcribing chunk…');

  const cfg = await getSettings();
  let key;
  try   { key = groqKey(cfg); }
  catch (err) { toast('⚙ ' + err.message, 'error'); return; }

  const ext  = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'mp4' : 'webm';
  const lang = $('selLang')?.value || 'en';
  const form = new FormData();
  form.append('file',            blob, `audio_${Date.now()}.${ext}`);
  form.append('model',           'whisper-large-v3-turbo');
  form.append('language',        lang);
  form.append('response_format', 'json');

  try {
    const resp = await fetch(NOTERA_API + '/api/asr', {
      method:  'POST',
      headers: {},
      body:    form,
    });

    if (resp.status === 429) {
      toast('Groq rate limit — will retry next cycle', 'error');
      return;
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error('Groq error', resp.status, errText);
      toast(`Transcription error (${resp.status})`, 'error');
      return;
    }

    const data = await resp.json();
    const text = (data.text || '').trim();

    if (text) {
      appendSegment(text);
      if (!isFinal) switchTab('transcript');
    }

  } catch (err) {
    console.error('Whisper error:', err);
    toast('Transcription failed: ' + err.message, 'error');
  }

  // Restore recording status if still going
  if (S.phase === 'recording') setStatus('rec', 'Recording — transcript live');
}

function appendSegment(text) {
  S.segments.push({ text, ts: Date.now() });
  S.transcript = S.segments.map(s => s.text).join(' ');

  $('tEmpty').style.display = 'none';
  const line       = document.createElement('div');
  line.className   = 't-line';
  line.textContent = text;
  const box = $('transcriptLines');
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;

  const n = S.segments.length;
  $('segCount').textContent = `${n} segment${n !== 1 ? 's' : ''}`;

  if (S.phase === 'done') $('btnGenerate').disabled = false;

  // Trigger clinical suggestions on every new segment (during recording only)
  if (S.phase === 'recording') scheduleClinicalSuggestions();
}

// ══════════════════════════════════════════════════════════════
//  CLINICAL SUGGESTIONS ENGINE
//  Triggered after each Whisper segment during recording.
//  Calls NVIDIA NIM with a dedicated clinical prompt → renders
//  colour-coded suggestion chips above the AI command bar.
// ══════════════════════════════════════════════════════════════

let _csbDebounce = null;
let _csbRunning  = false;

function scheduleClinicalSuggestions() {
  clearTimeout(_csbDebounce);
  // Debounce 800ms so rapid segments don't flood the API
  _csbDebounce = setTimeout(() => refreshClinicalSuggestions(), 800);
}

async function refreshClinicalSuggestions() {
  if (_csbRunning) return;          // don't overlap calls
  if (!S.transcript.trim()) return;

  const cfg = await getSettings();
  let apiKey;
  try   { apiKey = geminiKey(cfg); }
  catch { return; }  // no key — silently skip

  const SUGGESTIONS_MODEL = DEFAULT_MODEL;

  const bar      = $('clinicalSuggestionsBar');
  const chips    = $('csbChips');
  const loading  = $('csbLoading');
  const meta     = $('csbMeta');
  const badge    = $('csbBadge');

  bar.style.display  = 'flex';
  bar.style.flexDirection = 'column';

  // Move loading indicator to end without clearing existing chips
  chips.appendChild(loading);  // re-append to end (keeps existing chips)
  loading.style.display = 'flex';

  meta.textContent = 'Getting new suggestions…';

  _csbRunning = true;

  // Build transcript DELTA (what's new since last suggestions call)
  const transcriptDelta = S.transcript.slice(S.lastTranscriptSent.length).trim();
  const isFirstCall = S.shownSuggestions.length === 0;

  // ── Dynamic prompt with DO-NOT-REPEAT memory ───────────────
  const noPrevSection = S.shownSuggestions.length === 0
    ? ''
    : `
ALREADY SUGGESTED — DO NOT REPEAT ANY OF THESE (not even rephrased):
${S.shownSuggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}
`;

  const newInfoSection = (!isFirstCall && transcriptDelta)
    ? `
NEW TRANSCRIPT SINCE LAST UPDATE (focus on this):
"${transcriptDelta}"
`
    : '';

  const SYSTEM_PROMPT = `You are a senior clinical decision support AI in an active doctor-patient consultation.
Your job: generate fresh, specific, NEVER-BEFORE-SUGGESTED clinical action items for the doctor.
${noPrevSection}
CRITICAL RULES:
4. Each suggestion: max 6 words, no full stops.
5. Categories: [ASK]=question for patient, [CHECK]=physical exam step, [ORDER]=test/imaging/referral, [WARN]=red flag/urgent concern, [INFO]=clarify context
6. Think about: differentials, drug interactions, contraindications, vital abnormalities, social history, medication reconciliation, follow-up timing.
7. Output ONLY a valid JSON array of strings. No markdown, no explanation, no preamble.

EXAMPLE — for a chest pain case:
["[ASK] When did the pain start exactly?", "[ASK] Any radiation to left arm?", "[CHECK] Auscultate heart for murmur", "[CHECK] Palpate abdomen for tenderness", "[ORDER] 12-lead ECG stat", "[ORDER] Troponin I and CK-MB", "[ORDER] Chest X-ray PA", "[WARN] Possible ACS — don't delay", "[INFO] Previous cardiac history?"]

NOW generate for the actual transcript provided.`;

  const USER_PROMPT = `ACTIVE CONSULTATION TRANSCRIPT:

${S.transcript}

Generate 5-9 specific clinical suggestions JSON array:`;

  try {
    const resp = await fetch(`${NVIDIA_BASE}/chat/completions`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: SUGGESTIONS_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: USER_PROMPT },
        ],
        max_tokens:  400,       // enough for 5-9 suggestions as JSON array
        temperature: 0.5,       // slight variety across calls, still consistent
        top_p:       0.9,
        stream:      false,
      }),
    });

    if (!resp.ok) throw new Error(`NVIDIA ${resp.status}`);

    const data    = await resp.json();
    const rawText = stripThink(data.choices?.[0]?.message?.content || '');

    // Robustly parse JSON array from model output
    let suggestions = [];
    try {
      // Extract JSON array even if model wrapped it in markdown
      const match = rawText.match(/\[.*\]/s);
      if (match) suggestions = JSON.parse(match[0]);
    } catch {
      // Fallback: split by newlines and grab non-empty lines
      suggestions = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 3).slice(0, 6);
    }

    // Hide loading dots
    loading.style.display = 'none';
    // DON'T clear existing chips — we APPEND new ones

    // Count chips currently visible so we know if this is the first batch
    const existingChips = chips.querySelectorAll('.csb-chip').length;

    const tagInfo = {
      ASK:   { cls: 'type-ask',   icon: '💬', label: 'Ask' },
      CHECK: { cls: 'type-check', icon: '🩺', label: 'Check' },
      ORDER: { cls: 'type-order', icon: '📋', label: 'Order' },
      WARN:  { cls: 'type-warn',  icon: '⚠️', label: 'Alert' },
      INFO:  { cls: 'type-info',  icon: 'ℹ️', label: 'Info' },
    };

    let rendered = 0;
    const newSuggestions = [];

    suggestions.forEach(raw => {
      if (!raw || typeof raw !== 'string') return;
      const tagMatch = raw.match(/^\[(ASK|CHECK|ORDER|WARN|INFO)\]\s*/i);
      const tag  = tagMatch ? tagMatch[1].toUpperCase() : 'ASK';
      const text = raw.replace(/^\[.*?\]\s*/, '').trim();
      if (!text) return;

      // Client-side dedup guard
      const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '');
      const alreadyShown = S.shownSuggestions.some(
        prev => prev.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized
      );
      if (alreadyShown) return;

      const info = tagInfo[tag] || tagInfo.ASK;

      // Build chip with dismiss button
      const chip = document.createElement('span');  // span so × btn doesn't submit
      chip.className   = `csb-chip ${info.cls}`;
      chip.title       = `${info.label}: Click to send to AI · × to dismiss`;
      chip.setAttribute('aria-label', text);
      chip.dataset.text = text;

      // Label part (clickable → sends to AI)
      const label = document.createElement('button');
      label.className   = 'csb-chip-label';
      label.textContent = `${info.icon} ${text}`;
      label.addEventListener('click', () => {
        const inp = $('askInput');
        if (inp) {
          inp.value = text;
          inp.focus();
          $('aiCommandBar')?.classList.remove('hidden');
          $('btnOpenAiBar').style.display = 'none';
        }
        // Remove chip — it's been addressed
        chip.classList.add('csb-chip-dismissed');
        setTimeout(() => chip.remove(), 200);
        updateChipBadge();
      });

      // Dismiss button ×
      const dismiss = document.createElement('button');
      dismiss.className   = 'csb-chip-dismiss';
      dismiss.textContent = '×';
      dismiss.title       = 'Dismiss';
      dismiss.addEventListener('click', e => {
        e.stopPropagation();
        chip.classList.add('csb-chip-dismissed');
        setTimeout(() => chip.remove(), 200);
        updateChipBadge();
      });

      chip.appendChild(label);
      chip.appendChild(dismiss);

      // Insert before the loading dots (which are at end)
      chips.insertBefore(chip, loading);
      newSuggestions.push(text);
      rendered++;

      // Auto-dismiss the chip after 30 seconds
      setTimeout(() => {
        if (!chip.classList.contains('csb-chip-dismissed')) {
          chip.classList.add('csb-chip-dismissed');
          setTimeout(() => {
            if (chip.parentNode) chip.remove();
            updateChipBadge();
          }, 200);
        }
      }, 30000);
    });

    // Insert “NEW” divider before this batch (if there were existing chips)
    if (rendered > 0 && existingChips > 0) {
      const divider = document.createElement('span');
      divider.className = 'csb-divider';
      divider.textContent = '✕ New';
      // Find the first new chip and insert divider before it
      const allChips = [...chips.querySelectorAll('.csb-chip')];
      const firstNew  = allChips[existingChips]; // chips after the old ones
      if (firstNew) chips.insertBefore(divider, firstNew);
    }

    // Persist to session memory so next call won't repeat
    S.shownSuggestions.push(...newSuggestions);
    if (S.shownSuggestions.length > 50) S.shownSuggestions.splice(0, S.shownSuggestions.length - 50);
    S.lastTranscriptSent = S.transcript;

    if (rendered > 0) {
      chips.classList.remove('updated');
      void chips.offsetWidth;
      chips.classList.add('updated');

      // Badge = total chips currently visible (not just new ones)
      updateChipBadge();
      meta.textContent = `+${rendered} new · ${chips.querySelectorAll('.csb-chip').length} total · click to use, × to dismiss`;
    } else if (S.shownSuggestions.length > 0) {
      meta.textContent = 'All caught up — new suggestions after next 20s segment';
    } else {
      meta.textContent = 'No suggestions yet — keep talking';
    }

  } catch (err) {
    console.warn('Clinical suggestions error:', err.message);
    loading.style.display = 'none';
    meta.textContent = 'Suggestions unavailable';
  } finally {
    _csbRunning = false;
  }
}

function hideClinicalSuggestions() {
  $('clinicalSuggestionsBar').style.display = 'none';
  clearTimeout(_csbDebounce);

  const chips = $('csbChips');
  const loading = $('csbLoading');
  if (chips && loading) {
    chips.innerHTML = '';
    chips.appendChild(loading);
    updateChipBadge();
  }
}

// Update badge to show number of chips currently visible
function updateChipBadge() {
  const chips   = $('csbChips');
  const badge   = $('csbBadge');
  if (!chips || !badge) return;
  const total = chips.querySelectorAll('.csb-chip').length;
  badge.textContent = total;
  badge.style.display = total > 0 ? 'inline-block' : 'none';
}

// ══════════════════════════════════════════════════════════════
//  NOTE GENERATION
// ══════════════════════════════════════════════════════════════

async function generateNote(auto = false) {
  if (!S.transcript.trim()) {
    if (!auto) toast('No transcript yet — record first', 'error');
    return;
  }

  const fmtKey = $('selNoteFormatInline')?.value || $('selTemplate')?.value || 'soap';
  const tpl    = TEMPLATES[fmtKey] || TEMPLATES.soap;

  showLoader(`Generating ${tpl.label}…`);
  setStatus('loading', `Generating ${tpl.label}…`);

  const cfg = await getSettings();
  let apiKey;
  try   { apiKey = geminiKey(cfg); }
  catch (err) {
    hideLoader();
    toast(err.message, 'error');
    if (!auto) openSettings();
    return;
  }

  const ctxAge  = $('ctxAge')?.value.trim();
  const ctxSex  = $('ctxSex')?.value.trim();
  const ctxPMHx = $('ctxPMHx')?.value.trim();
  const ctxMeds = $('ctxMeds')?.value.trim();
  let contextStr = '';
  if (ctxAge || ctxSex || ctxPMHx || ctxMeds) {
    contextStr = `\n\nPATIENT CONTEXT:\n${ctxAge ? `Age: ${ctxAge}\n` : ''}${ctxSex ? `Sex: ${ctxSex}\n` : ''}${ctxPMHx ? `PMHx: ${ctxPMHx}\n` : ''}${ctxMeds ? `Current Meds: ${ctxMeds}\n` : ''}`;
  }

  try {
    S.note = '';
    showNoteUI();
    
    if (fmtKey === 'soap') {
      const engine = new PipelineEngine(
        (stepNum, totalSteps, msg) => {
          setStatus('loading', `Step ${stepNum}/${totalSteps}: ${msg}`);
          $('loadingMsg').textContent = `Step ${stepNum}/${totalSteps}: ${msg}`;
        },
        (partialNote) => {
          S.note = partialNote;
          $('noteBody').innerHTML = marked.parse(S.note);
          $('noteBody').scrollTop = 99999;
        }
      );
      
      const { finalNote, textLogs } = await engine.runPipeline(S.transcript, tpl.system + contextStr);
      S.note = finalNote;
      $('noteBody').innerHTML = marked.parse(S.note);
      S.logsText = textLogs.join('\n\n');
      $('logsContent').textContent = S.logsText;
    } else {
      // Helper to run a streaming generation for non-SOAP
      const runStream = async (systemPrompt, loadingMsg) => {
        setStatus('loading', loadingMsg);
        const resp = await fetch(
          NOTERA_API + `/api/llm/stream?model=${DEFAULT_MODEL}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: 'user', parts: [{ text: `CONSULTATION TRANSCRIPT:\n\n${S.transcript}\n\nGenerate the clinical documentation now.` }] }],
              generationConfig: {
                maxOutputTokens: 8192,
                temperature: 1.0,
                thinkingConfig: { thinkingBudget: 8192 },
              },
            }),
          }
        );

        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}));
          throw new Error(`Gemini ${resp.status}: ${JSON.stringify(e)}`);
        }

        for await (const chunk of parseSSE(resp)) {
          try {
            const parsed = JSON.parse(chunk);
            const parts = parsed?.candidates?.[0]?.content?.parts || [];
            const text = parts.map(p => p.text || '').join('');
            if (text) {
              S.note += text;
              $('noteBody').innerHTML = marked.parse(stripThink(S.note));
              $('noteBody').scrollTop = 99999;
            }
          } catch { /* partial chunk, skip */ }
        }
        
        S.note = stripThink(S.note);
        $('noteBody').innerHTML = marked.parse(S.note);
        S.logsText = "No pipeline logs available for non-SOAP templates.";
        $('logsContent').textContent = S.logsText;
      };
      
      await runStream(tpl.system + contextStr, 'Streaming note…');
    }

    hideLoader();
    $('btnGenerate').disabled  = false;

    await saveSessionToHistory(fmtKey, tpl.label);
    setStatus('done', `${tpl.label} ready`);
    toast(`${tpl.label} generated`, 'success');

  } catch (err) {
    hideLoader();
    toast(`Error: ${err.message}`, 'error');
    console.error('Generate error:', err);
    setStatus('done', 'Note generation failed');
  }
}

function showNoteUI() {
  $('noteEmpty').style.display   = 'none';
  $('noteContent').style.display = 'flex';
  $('noteContent').style.flexDirection = 'column';
  $('noteContent').style.flex    = '1';
}

// ── Save to history ───────────────────────────────────────────
async function saveSessionToHistory(templateKey, templateLabel) {
  const all = await getSessions();
  all.unshift({
    id: S.sessionId, ts: Date.now(),
    templateKey, templateLabel,
    transcript: S.transcript,
    note:       S.note,
    duration:   S.duration,
    segments:   S.segments.length,
    patientName: S.patientName,
    patientSubtitle: S.patientSubtitle,
  });
  if (all.length > 100) all.splice(100);
  await saveSessions(all);
}

// ══════════════════════════════════════════════════════════════
//  UI STATE MACHINE
// ══════════════════════════════════════════════════════════════
function updateUI() {
  const p    = S.phase;
  const btn  = $('btnResume');
  const lbl  = $('resumeBtnLabel');
  const dot  = $('recDot');
  const tmr  = $('timerEl');
  const gen  = $('btnGenerate');
  const bar  = $('recStatusBar');

  // Recording dot
  dot.className = 'rec-dot' + (p === 'recording' ? ' recording' : p === 'done' ? ' done' : '');

  // Main button: Start (idle) | Stop/red (recording) | Reset (done)
  lbl.textContent = { idle: 'Start', recording: 'Stop', done: 'Reset' }[p] || 'Start';
  btn.className   = 'top-resume-btn' + (p === 'recording' ? ' recording' : '');

  // Timer color
  tmr.style.color = p === 'recording' ? 'var(--green)' : 'var(--text-muted)';

  // Audio bars
  $('audioBars').classList.toggle('active', p === 'recording');

  // Generate
  gen.disabled = !(p === 'done' && S.transcript.trim());

  // Status bar
  bar.style.display = p !== 'idle' ? 'flex' : 'none';
}

// ── Timer ────────────────────────────────────────────────────
function startTimer() {
  clearInterval(S.timerTick);
  S.timerTick = setInterval(() => {
    const s  = Math.floor((Date.now() - S.startTime) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    $('timerEl').textContent = `${mm}:${ss}`;
  }, 500);
}

// ── Status bar ───────────────────────────────────────────────
function setStatus(type, msg) {
  const badge = $('statusPillBadge');
  const text  = $('statusMsgText');
  if (!badge || !text) return;

  const map = {
    rec:     ['rec',     'REC'],
    done:    ['done',    'Done'],
    loading: ['loading', 'Processing'],
    error:   ['error',   'Error'],
  };
  const [cls, label] = map[type] || ['', type];
  badge.className   = `status-pill-badge ${cls}`;
  badge.textContent = label;
  text.textContent  = msg;
  $('recStatusBar').style.display = 'flex';
}

// ── Toast ────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className   = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3500);
}

// ── Reset session ─────────────────────────────────────────────
function resetSession() {
  S.segments    = [];
  S.audioBuffer = [];
  S.transcript  = '';
  S.note        = '';
  S.chatHistory = [];
  S.phase       = 'idle';
  S.sessionId   = 'ses_' + Date.now();
  S.duration    = 0;
  S.shownSuggestions   = [];
  S.lastTranscriptSent = '';
  S.patientName        = 'Add patient details';
  S.patientSubtitle    = 'Confus, HIA';
  S.logsText           = '';

  $('sessionTitle').textContent = S.patientName;
  $('sessionSubtitle').textContent = S.patientSubtitle;

  localStorage.removeItem('dasDraft');

  $('transcriptLines').innerHTML = '';
  $('tEmpty').style.display      = 'flex';
  $('segCount').textContent      = '';
  $('timerEl').textContent       = '00:00';
  $('audioBars').classList.remove('active');
  $('noteEmpty').style.display   = '';
  $('noteContent').style.display = 'none';
  $('noteBody').textContent      = '';
  $('logsContent').textContent   = 'No logs generated yet.';
  $('aiMessages').innerHTML      = '';
  $('recStatusBar').style.display= 'none';
  hideClinicalSuggestions();

  updateUI();
  updateDatePill();
  switchTab('transcript');
}

// ── Loader overlay ────────────────────────────────────────────
function showLoader(msg = 'Processing…') {
  $('loadingMsg').textContent = msg;
  $('loadingOverlay').style.display = 'flex';
}
function hideLoader() {
  $('loadingOverlay').style.display = 'none';
}

// ── Date pill ─────────────────────────────────────────────────
function updateDatePill() {
  const now = new Date();
  const h   = now.getHours();
  const m   = now.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr12 = h % 12 || 12;
  $('datePillText').textContent = `Today ${hr12}:${m}${ampm}`;
}

// ══════════════════════════════════════════════════════════════
//  EVENT WIRING
// ══════════════════════════════════════════════════════════════

// Main Start/Stop/Reset button
$('btnLoadManualTranscript')?.addEventListener('click', () => {
  const text = $('manualTranscriptInput').value.trim();
  if (!text) return;
  if (!S.sessionId) S.sessionId = 'ses_' + Date.now();
  S.phase = 'done'; // Pretend we finished recording
  appendSegment(text);
  updateUI();
  toast('Manual transcript loaded — generating note…');
  switchTab('note');
  generateNote(true);
});

$('btnResume').addEventListener('click', () => {
  if      (S.phase === 'idle')      startRecording();
  else if (S.phase === 'recording') stopRecording();
  else if (S.phase === 'done')      resetSession();
});

// "Start recording" hint button in Note empty state
$('btnStartHint')?.addEventListener('click', () => {
  switchTab('transcript');
  startRecording();
});

// New Session (sidebar)
$('btnNewSession').addEventListener('click', async () => {
  if (S.phase === 'recording') {
    if (!confirm('Stop current recording and start a new session?')) return;
    await stopRecording();
  }
  resetSession();
  toast('New session ready');
});

// Trash (delete session)
$('btnTrash').addEventListener('click', async () => {
  if (!confirm('Delete this session?')) return;
  if (S.phase === 'recording') await stopRecording();
  resetSession();
  toast('Session deleted');
});

// Generate note (manual)
$('btnGenerate').addEventListener('click', () => generateNote(false));

// Copy note
$('btnCopy')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(S.note);
    toast('Note copied to clipboard', 'success');
  } catch { toast('Copy failed — select text manually', 'error'); }
});

// Copy for EMR (plain text)
$('btnCopyEMR')?.addEventListener('click', async () => {
  try {
    const plain = S.note.replace(/[*_#`~]+/g, '').toUpperCase();
    await navigator.clipboard.writeText(plain);
    toast('Copied plain text for EMR', 'success');
  } catch { toast('Copy failed', 'error'); }
});

// Editable Session Title & Subtitle
$('sessionTitle')?.addEventListener('input', e => S.patientName = e.target.textContent.trim());
$('sessionSubtitle')?.addEventListener('input', e => S.patientSubtitle = e.target.textContent.trim());

// Editable Profile
$('userName')?.addEventListener('input', async e => {
  const cfg = await getSettings();
  cfg.profileName = e.target.textContent.trim();
  await saveSettings(cfg);
});
$('userEmail')?.addEventListener('input', async e => {
  const cfg = await getSettings();
  cfg.profileEmail = e.target.textContent.trim();
  await saveSettings(cfg);
});

// Sidebar History link
$('btnSidebarHistory')?.addEventListener('click', () => {
  switchTab('history');
});

// Export note
document.querySelectorAll('.top-icon-btn')[0]?.addEventListener('click', () => {
  if (!S.note) { toast('No note to export', 'error'); return; }
  const blob = new Blob([S.note], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `das-note-${new Date().toISOString().slice(0, 10)}.txt`,
  });
  a.click();
  URL.revokeObjectURL(url);
  toast('Note exported', 'success');
});

// Create button — starts recording OR generates if done
$('btnCreate')?.addEventListener('click', () => {
  if (S.phase === 'done' && S.transcript) generateNote(false);
  else { switchTab('transcript'); startRecording(); }
});

// Undo note edit
let undoStack = [];
$('noteBody')?.addEventListener('input', () => {
  undoStack.push(S.note);
  if (undoStack.length > 50) undoStack.shift();
  S.note = $('noteBody').textContent;
});
$('btnUndoEdit')?.addEventListener('click', () => {
  if (!undoStack.length) { toast('Nothing to undo'); return; }
  S.note = undoStack.pop();
  $('noteBody').textContent = S.note;
  toast('Undo applied');
});

// Thumbs feedback
$('btnThumbUp')?.addEventListener('click', () => {
  $('btnThumbUp').classList.toggle('active-up');
  $('btnThumbDown')?.classList.remove('active-down');
  toast($('btnThumbUp').classList.contains('active-up') ? '👍 Thanks!' : 'Feedback removed');
});
$('btnThumbDown')?.addEventListener('click', () => {
  $('btnThumbDown').classList.toggle('active-down');
  $('btnThumbUp')?.classList.remove('active-up');
  toast($('btnThumbDown').classList.contains('active-down') ? '👎 Noted — we\'ll improve this.' : 'Feedback removed');
});

// Personalisation toggle
$('personalisationToggle')?.addEventListener('click', () => {
  const t  = $('personalisationToggle');
  const on = t.getAttribute('aria-checked') !== 'true';
  t.setAttribute('aria-checked', String(on));
  if (t.previousElementSibling) t.previousElementSibling.textContent = on ? 'Personalisation on' : 'Personalisation off';
  toast(on ? 'Personalisation enabled' : 'Personalisation disabled');
});

// Sidebar toggle
$('sidebarToggle')?.addEventListener('click', () => {
  $('sidebar').classList.toggle('collapsed');
});

// Nav items
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    
    const logsPage = $('logsPage');
    const mainArea = $('mainArea');
    
    if (item.dataset.nav === 'settings') {
      openSettings();
    } else if (item.dataset.nav === 'logs') {
      if (mainArea) mainArea.style.display = 'none';
      if (logsPage) logsPage.style.display = 'flex';
    } else {
      if (mainArea) mainArea.style.display = 'flex';
      if (logsPage) logsPage.style.display = 'none';
    }
  });
});
$('navSettings')?.addEventListener('click', openSettings);

// Theme Toggle
$('btnThemeToggle')?.addEventListener('click', () => {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem('dasTheme', isDark ? 'dark' : 'light');
});

// Format selects — keep in sync
$('selTemplate')?.addEventListener('change', () => {
  if ($('selNoteFormatInline')) $('selNoteFormatInline').value = $('selTemplate').value;
});
$('selNoteFormatInline')?.addEventListener('change', () => {
  if ($('selTemplate')) $('selTemplate').value = $('selNoteFormatInline').value;
});

// ── Paste-from-clipboard & clear transcript input ─────────────────
$('btnPasteClipboard')?.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) {
      const ta = $('manualTranscriptInput');
      if (ta) {
        ta.value = text.trim();
        ta.dispatchEvent(new Event('input'));
        ta.focus();
        toast('Pasted from clipboard');
      }
    } else {
      toast('Clipboard is empty', 'error');
    }
  } catch {
    toast('Clipboard access denied — use Ctrl+V instead', 'error');
  }
});

$('btnClearTranscriptInput')?.addEventListener('click', () => {
  const ta = $('manualTranscriptInput');
  if (ta) {
    ta.value = '';
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  }
});

$('manualTranscriptInput')?.addEventListener('input', () => {
  const ta  = $('manualTranscriptInput');
  const cnt = $('transcriptCharCount');
  if (ta && cnt) {
    const n = ta.value.length;
    cnt.textContent = n === 0 ? '0 characters' : `${n.toLocaleString()} character${n !== 1 ? 's' : ''}`;
  }
});

// ── Tab switching ─────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.main-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.maintab === name)
  );
  const panels = {
    context:    $('mainPanelContext'),
    transcript: $('mainPanelTranscript'),
    note:       $('mainPanelNote'),
    history:    $('mainPanelHistory'),
    logs:       $('mainPanelLogs'),
  };
  Object.entries(panels).forEach(([k, el]) => {
    if (el) el.classList.toggle('active', k === name);
  });
  if (name === 'history') renderHistory();
  if (name === 'logs') {
    if (S.logsText) $('logsContent').textContent = S.logsText;
  }
}

document.querySelectorAll('.main-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.maintab;
    if (name) switchTab(name);
  });
});

// ── AI Command Bar ────────────────────────────────────────────
document.querySelectorAll('.ai-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.ai-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const show = ['write', 'explain', 'create', 'clinical'].includes(tab.dataset.aitab || '');
    const area = $('aiMessagesArea');
    if (area) area.style.display = show ? 'flex' : 'none';
    const placeholders = {
      write:       'Ask, edit or create anything…',
      'fill-form': 'Choose a form to fill from transcript…',
      explain:     'Explain a medical term or concept…',
      create:      'Create a new section or document…',
      clinical:    'Ask about clinical considerations…',
    };
    const inp = $('askInput');
    if (inp) inp.placeholder = placeholders[tab.dataset.aitab || ''] || 'Ask anything…';
  });
});

$('btnAiClose')?.addEventListener('click', () => {
  $('aiCommandBar')?.classList.add('hidden');
  $('btnOpenAiBar').style.display = 'flex';
  hideClinicalSuggestions();   // also hide suggestions when chat is closed
});
$('btnOpenAiBar')?.addEventListener('click', () => {
  $('aiCommandBar')?.classList.remove('hidden');
  $('btnOpenAiBar').style.display = 'none';
  $('askInput')?.focus();
  // Restore suggestions if we have transcript
  if (S.transcript.trim() && S.phase !== 'idle') {
    $('clinicalSuggestionsBar').style.display = 'flex';
  }
});
$('btnSources')?.addEventListener('click', () => {
  $('btnSources').classList.toggle('active');
});

// Quick chips
document.querySelectorAll('.ai-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    $('askInput').value = chip.dataset.q || chip.textContent;
    sendAIMessage();
  });
});
$('askInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAIMessage(); }
});
$('btnSend')?.addEventListener('click', sendAIMessage);

// ── AI voice mic (command bar) ─────────────────────────────────
let _aiMicOn = false, _aiMicRec = null, _aiMicStream = null;
$('btnAiMic')?.addEventListener('click', async () => {
  if (_aiMicOn) {
    _aiMicOn = false;
    $('btnAiMic').classList.remove('recording-ai');
    _aiMicRec?.stop();
    return;
  }
  try {
    _aiMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime   = bestMime();
    _aiMicRec    = new MediaRecorder(_aiMicStream, { mimeType: mime });
    let   buf    = [];
    _aiMicRec.ondataavailable = e => { if (e.data?.size) buf.push(e.data); };
    _aiMicRec.onstop = async () => {
      _aiMicOn = false;
      $('btnAiMic').classList.remove('recording-ai');
      _aiMicStream.getTracks().forEach(t => t.stop());
      if (!buf.length) return;
      const cfg = await getSettings();
      try {
        const k    = groqKey(cfg);
        const form = new FormData();
        form.append('file', new Blob(buf, { type: mime }), 'voice.webm');
        form.append('model', 'whisper-large-v3-turbo');
        form.append('response_format', 'json');
        const r = await fetch(NOTERA_API + '/api/asr', {
          method: 'POST', headers: {}, body: form,
        });
        if (r.ok) { const d = await r.json(); if (d.text) $('askInput').value = d.text.trim(); }
      } catch (err) { console.error('AI mic:', err); }
    };
    _aiMicRec.start();
    _aiMicOn = true;
    $('btnAiMic').classList.add('recording-ai');
    setTimeout(() => { if (_aiMicOn) _aiMicRec?.stop(); }, 15000);
  } catch { toast('Mic access denied', 'error'); }
});

// ── AI chat ───────────────────────────────────────────────────
async function sendAIMessage() {
  const q = $('askInput')?.value?.trim();
  if (!q) return;
  $('askInput').value = '';

  const area = $('aiMessagesArea');
  if (area) { area.style.display = 'flex'; area.style.flexDirection = 'column'; }
  addBubble('user', q);
  S.chatHistory.push({ role: 'user', content: q });

  const bubble = addBubble('das', '▍', 'loading');
  $('btnSend').disabled = true;

  const cfg = await getSettings();
  let apiKey;
  try   { apiKey = geminiKey(cfg); }
  catch (err) { bubble.textContent = err.message; $('btnSend').disabled = false; return; }

  const sysPrompt = `You are DAS, an AI clinical assistant.
TRANSCRIPT: ${S.transcript || '(none)'}
NOTE: ${S.note || '(none)'}
Answer the clinician's question concisely. Plain text only.`;

  const geminiHistory = S.chatHistory.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  try {
    const resp = await fetch(
      NOTERA_API + `/api/llm/stream?model=${DEFAULT_MODEL}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sysPrompt }] },
          contents: [...geminiHistory, { role: 'user', parts: [{ text: q }] }],
          generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
        }),
      }
    );

    let full = '';
    bubble.classList.remove('loading');
    for await (const chunk of parseSSE(resp)) {
      try {
        const parsed = JSON.parse(chunk);
        const parts = parsed?.candidates?.[0]?.content?.parts || [];
        const text = parts.map(p => p.text || '').join('');
        if (text) { full += text; bubble.textContent = stripThink(full); }
      } catch { /* partial chunk */ }
    }
    full = stripThink(full);
    bubble.textContent = full;
    S.chatHistory.push({ role: 'assistant', content: full });

  } catch (err) {
    bubble.textContent = 'Error: ' + err.message;
  }
  $('btnSend').disabled = false;
}

function addBubble(role, text, cls = '') {
  const area = $('aiMessages');
  const el   = document.createElement('div');
  el.className   = `ai-bubble ai-bubble-${role} ${cls}`.trim();
  el.textContent = text;
  area.appendChild(el);
  area.scrollTop = area.scrollHeight;
  return el;
}

// ── Microphone enumeration ────────────────────────────────────
async function populateMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics    = devices.filter(d => d.kind === 'audioinput');
    const sel     = $('micSelect');
    if (!sel) return;
    sel.innerHTML = '';
    mics.forEach((d, i) => {
      const opt   = document.createElement('option');
      opt.value   = d.deviceId;
      opt.textContent = d.label || `Microphone ${i + 1}`;
      sel.appendChild(opt);
    });
    if (!mics.length) {
      const opt = document.createElement('option');
      opt.textContent = 'Default – Microphone';
      sel.appendChild(opt);
    }
  } catch { /* permissions not granted yet */ }
}

// ── History ───────────────────────────────────────────────────
async function renderHistory() {
  const list  = $('historyList');
  const empty = $('histEmpty');
  const all   = await getSessions();

  if (!all.length) {
    if (empty) empty.style.display = 'flex';
    list.innerHTML = '';
    if (empty) list.appendChild(empty);
    return;
  }

  if (empty) empty.style.display = 'none';
  list.innerHTML = '';

  all.forEach(s => {
    const d    = new Date(s.ts);
    const item = document.createElement('div');
    item.className = 'h-item';
    const pName = s.patientName && s.patientName !== 'Add patient details' ? s.patientName : 'Unknown Patient';
    item.innerHTML = `
      <div class="h-item-main">
        <div class="h-date"><strong>${pName}</strong> · ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} · ${fmtDur(s.duration)}</div>
        <span class="h-template">${s.templateLabel || 'SOAP Note'}</span>
        <div class="h-preview">${(s.note || s.transcript || '').slice(0, 120)}…</div>
      </div>
      <button class="h-del" title="Delete">✕</button>`;

    item.querySelector('.h-item-main').addEventListener('click', () => {
      S.note = s.note; S.transcript = s.transcript;
      showNoteUI();
      $('noteBody').innerHTML = marked.parse(s.note || '');
      switchTab('note');
    });
    item.querySelector('.h-del').addEventListener('click', async e => {
      e.stopPropagation();
      const sessions = await getSessions();
      await saveSessions(sessions.filter(x => x.id !== s.id));
      renderHistory();
      toast('Session deleted');
    });
    list.appendChild(item);
  });
}

$('btnClearAll')?.addEventListener('click', async () => {
  if (!confirm('Delete all session history?')) return;
  await saveSessions([]);
  renderHistory();
  toast('History cleared');
});

function fmtDur(s) {
  if (!s) return '0s';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m ? `${m}m ${sec}s` : `${sec}s`;
}

// ══════════════════════════════════════════════════════════════
//  SETTINGS MODAL
// ══════════════════════════════════════════════════════════════

async function openSettings() {
  const cfg = await getSettings();
  $('groqKey1').value = cfg.groqKey1 || '';
  $('groqKey2').value = cfg.groqKey2 || '';
  $('groqKey3').value = cfg.groqKey3 || '';
  if ($('geminiKey')) $('geminiKey').value = cfg.geminiKey || '';
  $('groqTestResult').textContent = '';
  if ($('geminiTestResult')) $('geminiTestResult').textContent = '';
  $('settingsModal').style.display = 'flex';
}
function closeSettings() { $('settingsModal').style.display = 'none'; }

$('closeSettings')?.addEventListener('click', closeSettings);
$('btnCancelSettings')?.addEventListener('click', closeSettings);
$('settingsModal')?.addEventListener('click', e => {
  if (e.target === $('settingsModal')) closeSettings();
});

// Visibility toggles for password fields
document.querySelectorAll('.vis-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const inp = $(btn.dataset.target);
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    btn.textContent = inp.type === 'password' ? '👁' : '🙈';
  });
});

// .env file upload
$('envFileInput')?.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const lines = text.split(/\r?\n/);
  let found = 0, preview = [];
  const newCfg = await getSettings();
  const map = {
    GROQ_KEY_1: 'groqKey1', GROQ_KEY: 'groqKey1',
    GROQ_KEY_2: 'groqKey2',
    GROQ_KEY_3: 'groqKey3',
    GEMINI_API_KEY: 'geminiKey',
  };
  for (const line of lines) {
    const [k, ...rest] = line.split('=');
    const key = k?.trim();
    const val = rest.join('=').trim().replace(/^["']|["']$/g, '');
    if (map[key] && val) {
      newCfg[map[key]] = val;
      found++;
      preview.push(`✓ ${key}`);
    }
  }
  if (found > 0) {
    await saveSettings(newCfg);
    $('groqKey1').value = newCfg.groqKey1 || '';
    $('groqKey2').value = newCfg.groqKey2 || '';
    $('groqKey3').value = newCfg.groqKey3 || '';
    if ($('geminiKey')) $('geminiKey').value = newCfg.geminiKey || '';
    $('envUploadTitle').textContent = `✓ Loaded ${found} key${found !== 1 ? 's' : ''}`;
    const result = $('envParseResult');
    result.style.display = 'block';
    result.innerHTML = `<strong>Imported:</strong><br>${preview.join('<br>')}`;
    toast(`${found} key(s) imported from .env`, 'success');
  } else {
    toast('No recognised keys found in file', 'error');
  }
  e.target.value = '';
});

// Save settings
$('btnSaveSettings')?.addEventListener('click', async () => {
  const cfg = await getSettings();
  cfg.groqKey1 = $('groqKey1').value.trim();
  cfg.groqKey2 = $('groqKey2').value.trim();
  cfg.groqKey3 = $('groqKey3').value.trim();
  if ($('geminiKey')) cfg.geminiKey = $('geminiKey').value.trim();
  await saveSettings(cfg);
  closeSettings();
  toast('Settings saved', 'success');
  await populateMics();
});

// — Test Groq key ———————————————————————————————
$('btnTestGroq')?.addEventListener('click', async () => {
  const key = $('groqKey1').value.trim();
  const out = $('groqTestResult');
  if (!key) { out.textContent = '⚠ Enter key first'; out.className = 'test-result fail'; return; }
  out.textContent = 'Testing…'; out.className = 'test-result';
  try {
    // Minimal silence blob (~50ms)
    const silence = new Uint8Array(1000).fill(0);
    const form    = new FormData();
    form.append('file',  new Blob([silence], { type: 'audio/webm' }), 'test.webm');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    const r = await fetch(NOTERA_API + '/api/asr', {
      method: 'POST', headers: {}, body: form,
    });
    // 400 = key works but file invalid (expected for silence) = key OK
    // 401 = invalid key
    if (r.status === 401) throw new Error('Invalid API key');
    if (r.status === 200 || r.status === 400) {
      out.textContent = '✅ Key valid'; out.className = 'test-result pass';
    } else {
      out.textContent = `⚠ Status ${r.status}`; out.className = 'test-result fail';
    }
  } catch (err) {
    out.textContent = '❌ ' + err.message; out.className = 'test-result fail';
  }
});

// — Test Gemini key ————————————————————————————
$('btnTestNvidia')?.addEventListener('click', async () => {
  const key = ($('geminiKey') || $('nvidiaKey'))?.value.trim();
  const out  = $('geminiTestResult') || $('nvidiaTestResult');
  if (!out) return;
  if (!key) { out.textContent = '⚠ Enter key first'; out.className = 'test-result fail'; return; }
  out.textContent = 'Testing…'; out.className = 'test-result';
  try {
    const r = await fetch(
      NOTERA_API + `/api/llm/generate?model=${DEFAULT_MODEL}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with just "ok".' }] }], generationConfig: { maxOutputTokens: 5 } }),
      }
    );
    if (r.status === 400 || r.status === 403) throw new Error(`Auth failed (${r.status}) — key invalid`);
    if (r.ok) { out.textContent = `✅ Gemini 2.5 Pro OK`; out.className = 'test-result pass'; }
    else { const e = await r.json().catch(() => ({})); throw new Error(`${r.status}: ${JSON.stringify(e)}`); }
  } catch (err) {
    out.textContent = '❌ ' + err.message; out.className = 'test-result fail';
  }
});

// Drag-and-drop .env
const envLabel = $('envUploadLabel');
envLabel?.addEventListener('dragover', e => { e.preventDefault(); envLabel.classList.add('drag-over'); });
envLabel?.addEventListener('dragleave', () => envLabel.classList.remove('drag-over'));
envLabel?.addEventListener('drop', e => {
  e.preventDefault();
  envLabel.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f) {
    const dt = new DataTransfer();
    dt.items.add(f);
    $('envFileInput').files = dt.files;
    $('envFileInput').dispatchEvent(new Event('change'));
  }
});

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════

async function init() {
  updateDatePill();
  updateUI();
  switchTab('transcript');
  await populateMics();
  
  if (localStorage.getItem('dasTheme') === 'dark') {
    document.body.classList.add('dark-mode');
  }

  // Load saved settings into UI
  const cfg = await getSettings();
  
  if (cfg.profileName) $('userName').textContent = cfg.profileName;
  if (cfg.profileEmail) $('userEmail').textContent = cfg.profileEmail;

  // Check for unsaved draft
  try {
    const draftStr = localStorage.getItem('dasDraft');
    if (draftStr) {
      const draft = JSON.parse(draftStr);
      if (draft.transcript && confirm('You have an unsaved session draft. Would you like to restore it?')) {
        S.transcript = draft.transcript;
        S.segments = draft.segments || [];
        S.duration = draft.duration || 0;
        if (draft.patientName) {
          S.patientName = draft.patientName;
          $('sessionTitle').textContent = draft.patientName;
        }
        if (draft.patientSubtitle) {
          S.patientSubtitle = draft.patientSubtitle;
          $('sessionSubtitle').textContent = draft.patientSubtitle;
        }
        S.phase = 'done';
        $('transcriptLines').innerHTML = S.segments.map(s => `<div class="t-line">${s.text}</div>`).join('');
        $('tEmpty').style.display = 'none';
        $('segCount').textContent = `${S.segments.length} segment(s)`;
        updateUI();
        $('btnGenerate').disabled = false;
        switchTab('transcript');
        toast('Draft restored');
      } else {
        localStorage.removeItem('dasDraft');
      }
    }
  } catch (e) { console.error('Draft restore error', e); }
  if (!cfg.groqKey1 && !cfg.geminiKey) {
    // First run — remind user to set up
    toast('Welcome to DAS — open ⚙ Settings to add your Groq & Gemini API keys', 'info');
  }

  // Restore history count badge if any
  const sessions = await getSessions();
  if (sessions.length) {
    const tab = document.querySelector('[data-maintab="history"]');
    if (tab) tab.title = `${sessions.length} saved session(s)`;
  }
}

document.addEventListener('DOMContentLoaded', init);
