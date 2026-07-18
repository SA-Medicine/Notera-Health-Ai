// DAS — Content Script
// Handles Smart Inject: paste clinical note into any web field

'use strict';

// Listen for injection requests from background worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'ping') {
    sendResponse({ ok: true });
    return;
  }
});

// The actual injection is handled directly by background.js via
// chrome.scripting.executeScript for reliability.
// This content script file is kept for future overlay features.
