// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Service worker — extension lifecycle.
 * Opens the side panel when the extension action icon is clicked.
 */

/** Tabs where we've already verified / injected the content script. */
const injectedTabs = new Set<number>();

/** Ensure the content script is injected on a tab, attempting injection at most once. */
async function ensureContentScript(tabId: number): Promise<void> {
  if (injectedTabs.has(tabId)) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
  } catch {
    console.log(`[WebMCP] Injecting content script into tab ${tabId}`);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-script.js'],
      });
    } catch (e) {
      console.warn(`[WebMCP] Injection failed for tab ${tabId}:`, e);
      return;
    }
  }
  injectedTabs.add(tabId);
}

// Clear tracking when a tab navigates or is closed
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') injectedTabs.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => injectedTabs.delete(tabId));

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id != null) {
    // Open panel first — must happen synchronously within the user gesture
    await chrome.sidePanel.open({ tabId: tab.id });
    await ensureContentScript(tab.id);
  }
});

// Relay toolchange messages from content script to side panel
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'toolchange' && sender.tab?.id != null) {
    // Broadcast to all extension pages (side panel will pick it up)
    chrome.runtime.sendMessage(message).catch(() => {
      // Side panel may not be open — ignore
    });
  }
});
