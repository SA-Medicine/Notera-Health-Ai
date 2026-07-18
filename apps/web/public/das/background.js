// DAS — Background Service Worker v1.1 (MV3)
// Handles: icon click → open full webapp tab, context menu inject, session persistence

'use strict';

// ─── Extension Installed / Updated ───────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  // Context-menu for smart paste into any editable field on any page
  chrome.contextMenus.create({
    id:       'das-inject',
    title:    'DAS: Paste Clinical Note Here',
    contexts: ['editable'],
  });
});

// ─── Icon Click → Open Full Webapp Tab ───────────────────────────────────────
// Because we have NO default_popup, onClicked fires every time the icon is clicked.
// We open the bundled webapp page (chrome-extension:// URL — portable, no hardcoded paths).
chrome.action.onClicked.addListener(async () => {
  const webappUrl = chrome.runtime.getURL('webapp/index.html');

  // If a DAS tab is already open, focus it instead of opening a new one
  const existing = await chrome.tabs.query({ url: webappUrl });
  if (existing.length > 0) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: webappUrl });
  }
});

// ─── Context Menu Smart Inject ────────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'das-inject') return;

  const data     = await chrome.storage.local.get('currentNote');
  const noteText = data.currentNote;

  if (!noteText) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   () => alert('DAS: No clinical note generated yet.\nRecord a consultation first.'),
    });
    return;
  }

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func:   injectTextIntoField,
    args:   [noteText],
  });
});

// ─── Smart Inject Function (injected into the active page) ───────────────────
// Works across ANY EHR or web-based field — auto-detects the target element.
function injectTextIntoField(text) {
  const active = document.activeElement;

  const tryInject = (el) => {
    if (!el) return false;

    // Standard input / textarea
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const s = el.selectionStart ?? 0;
      const e = el.selectionEnd   ?? s;
      el.value = el.value.slice(0, s) + text + el.value.slice(e);
      el.selectionStart = el.selectionEnd = s + text.length;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    // ContentEditable (rich text editors, Draft.js, ProseMirror, Slate, etc.)
    if (el.isContentEditable) {
      el.focus();
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        el.textContent += text;
      }
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      return true;
    }

    return false;
  };

  // 1. Try the currently focused element
  if (tryInject(active)) return { ok: true, target: 'focused' };

  // 2. Fallback: first visible textarea or contenteditable on the page
  const candidates = [
    ...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]'),
  ];
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      el.focus();
      if (tryInject(el)) return { ok: true, target: 'found' };
    }
  }

  return { ok: false };
}

// ─── Message Handler (from webapp running as chrome-extension:// page) ────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Smart inject triggered from the webapp's "Inject" button
  if (msg.action === 'injectNote') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) { sendResponse({ ok: false, error: 'No active tab' }); return; }
      // Don't inject into our own webapp page
      if (tab.url?.startsWith(chrome.runtime.getURL(''))) {
        sendResponse({ ok: false, error: 'Cannot inject into DAS itself' });
        return;
      }
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, func: injectTextIntoField, args: [msg.text] })
        .then((res) => sendResponse({ ok: res[0]?.result?.ok ?? false }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    });
    return true; // keep channel open for async response
  }

  // Save a session to local storage (called by webapp)
  if (msg.action === 'saveSession') {
    chrome.storage.local.get(['dasSessions', 'currentNote'], (data) => {
      const sessions = data.dasSessions || [];
      sessions.unshift(msg.session);
      if (sessions.length > 100) sessions.splice(100);
      chrome.storage.local.set({
        dasSessions: sessions,
        currentNote: msg.session.note || data.currentNote,
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  // Get all sessions
  if (msg.action === 'getSessions') {
    chrome.storage.local.get('dasSessions', (d) =>
      sendResponse({ sessions: d.dasSessions || [] })
    );
    return true;
  }

  // Delete one session by id
  if (msg.action === 'deleteSession') {
    chrome.storage.local.get('dasSessions', (d) => {
      const sessions = (d.dasSessions || []).filter((s) => s.id !== msg.id);
      chrome.storage.local.set({ dasSessions: sessions });
      sendResponse({ ok: true });
    });
    return true;
  }

  // Clear all sessions
  if (msg.action === 'clearSessions') {
    chrome.storage.local.set({ dasSessions: [] });
    sendResponse({ ok: true });
    return true;
  }

  // Update current note (used by context-menu inject)
  if (msg.action === 'setCurrentNote') {
    chrome.storage.local.set({ currentNote: msg.note });
    sendResponse({ ok: true });
    return true;
  }
});
