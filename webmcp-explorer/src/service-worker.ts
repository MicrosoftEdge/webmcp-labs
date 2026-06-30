// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Service worker — extension lifecycle.
 *
 * The side panel is toggled by Chrome itself: setting
 * `openPanelOnActionClick: true` makes a click on the toolbar icon open the
 * panel and a second click close it.
 */

// Make the toolbar icon toggle the side panel open/closed.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[WebMCP] setPanelBehavior failed:', e));

// Relay toolchange messages from content script to side panel
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'toolchange' && sender.tab?.id != null) {
    // Broadcast to all extension pages (side panel will pick it up)
    chrome.runtime.sendMessage(message).catch(() => {
      // Side panel may not be open — ignore
    });
  }
});
