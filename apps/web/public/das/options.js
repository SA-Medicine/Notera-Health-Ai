'use strict';

// ─── DOM Refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ─── Load Saved Settings ──────────────────────────────────────────────────────
async function loadSettings() {
  const data = await chrome.storage.local.get('dasSettings');
  const cfg  = data.dasSettings || {};

  const set = (id, val) => { if (val !== undefined && val !== null && $(id)) $(id).value = val; };
  set('groqKey1',        cfg.groqKey1);
  set('groqKey2',        cfg.groqKey2);
  set('groqKey3',        cfg.groqKey3);
  set('geminiKey',       cfg.geminiKey);
  set('defaultLang',     cfg.defaultLang     || 'en');
  set('defaultTemplate', cfg.defaultTemplate || 'soap');
}

// ─── Save Settings ────────────────────────────────────────────────────────────
// Saves whatever is filled in — no hard requirements on NVIDIA key
async function saveSettings() {
  const cfg = {
    groqKey1:        $('groqKey1').value.trim(),
    groqKey2:        $('groqKey2').value.trim(),
    groqKey3:        $('groqKey3').value.trim(),
    geminiKey:       $('geminiKey').value.trim(),
    defaultLang:     $('defaultLang').value,
    defaultTemplate: $('defaultTemplate').value,
  };

  // Only hard block: need at least one Groq key for transcription
  const hasGroq = cfg.groqKey1 || cfg.groqKey2 || cfg.groqKey3;
  if (!hasGroq) {
    showError('Please enter at least one Groq API key (Key 1 is required for transcription).');
    return;
  }

  try {
    await chrome.storage.local.set({ dasSettings: cfg });
    showSaved();

    // Soft warning only — don't block save
    if (!cfg.geminiKey) {
      setTimeout(() => showError('Note: Gemini API key not set. Note generation and Ask DAS will not work until added.'), 2500);
    }
  } catch (err) {
    showError(`Failed to save: ${err.message}`);
  }
}

// ─── Visibility Toggle ────────────────────────────────────────────────────────
function toggleVis(targetId) {
  const inp = $(targetId);
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

// ─── Test Groq Key ────────────────────────────────────────────────────────────
async function testGroqKey(keyId) {
  const key = $(keyId)?.value.trim();
  const tag = $(`tag_${keyId}`);
  const btn = $(`test${capitalize(keyId)}`);

  if (!key) { setTag(tag, '— empty', 'neutral'); return; }

  setTag(tag, 'Testing…', 'neutral');
  if (btn) btn.disabled = true;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });

    if (resp.ok) {
      const data       = await resp.json();
      const hasWhisper = (data.data || []).some((m) => m.id.includes('whisper'));
      setTag(tag, hasWhisper ? '✓ Valid' : '✓ Connected', 'ok');
    } else if (resp.status === 401) {
      setTag(tag, '✗ Invalid key', 'err');
    } else if (resp.status === 429) {
      setTag(tag, '✓ Valid (rate limited)', 'ok'); // key is valid, just rate limited
    } else {
      setTag(tag, `✗ HTTP ${resp.status}`, 'err');
    }
  } catch (err) {
    setTag(tag, '✗ Network error', 'err');
    console.error('Groq test error:', err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ─── Test Gemini Key ────────────────────────────────────────────────────────
async function testGeminiKey() {
  const key = $('geminiKey')?.value.trim();
  const tag = $('tag_geminiKey');
  const btn = $('testGeminiKey');

  if (!key) { setTag(tag, '— empty', 'neutral'); return; }

  setTag(tag, 'Testing…', 'neutral');
  if (btn) btn.disabled = true;

  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);

    if (resp.ok) {
      setTag(tag, '✓ Valid', 'ok');
    } else if (resp.status === 400 || resp.status === 403) {
      setTag(tag, '✗ Invalid key', 'err');
    } else {
      setTag(tag, `✗ HTTP ${resp.status}`, 'err');
    }
  } catch (err) {
    setTag(tag, '✗ Network error', 'err');
    console.error('Gemini test network error:', err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ─── Clear All Data ───────────────────────────────────────────────────────────
async function clearAll() {
  if (!confirm('Delete ALL sessions and API keys? This cannot be undone.')) return;
  await chrome.storage.local.clear();
  location.reload();
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function setTag(el, text, state) {
  if (!el) return;
  el.textContent = text;
  el.className   = `key-tag ${state}`;
}

let savedTimer;
function showSaved() {
  const banner = $('savedBanner');
  const errBnr = $('errorBanner');
  if (errBnr) errBnr.style.display = 'none';
  if (!banner) return;
  banner.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => banner.classList.remove('show'), 3500);
}

let errTimer;
function showError(msg) {
  const errBnr = $('errorBanner');
  if (!errBnr) return;
  errBnr.textContent = msg;
  errBnr.style.display = 'flex';
  clearTimeout(errTimer);
  errTimer = setTimeout(() => { errBnr.style.display = 'none'; }, 5000);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Wire Up All Event Listeners (no inline handlers — MV3 CSP compliant) ────
document.addEventListener('DOMContentLoaded', () => {

  // Load saved values into form
  loadSettings();

  // Save button
  const btnSave = $('btnSave');
  if (btnSave) btnSave.addEventListener('click', saveSettings);

  // Clear all button
  const btnClear = $('btnClear');
  if (btnClear) btnClear.addEventListener('click', clearAll);

  // Visibility toggles — reads data-target attribute
  document.querySelectorAll('.vis-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      toggleVis(targetId);
      const inp  = $(targetId);
      btn.style.color = (inp && inp.type === 'text') ? '#2563eb' : '';
    });
  });

  // Groq test buttons — reads data-key attribute
  ['testGroqKey1', 'testGroqKey2', 'testGroqKey3'].forEach((btnId) => {
    const btn = $(btnId);
    if (!btn) return;
    const keyId = btn.getAttribute('data-key');
    btn.addEventListener('click', () => testGroqKey(keyId));
  });

  // Gemini test button
  const testGemini = $('testGeminiKey');
  if (testGemini) testGemini.addEventListener('click', testGeminiKey);

  // Ctrl+S shortcut to save
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveSettings();
    }
  });
});
