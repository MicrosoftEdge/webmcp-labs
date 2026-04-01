/**
 * Service worker — extension lifecycle.
 * Opens the side panel when the extension action icon is clicked.
 */

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id != null) {
    await chrome.sidePanel.open({ tabId: tab.id });
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
