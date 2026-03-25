/**
 * Background service worker for Ebill Auto-Filler
 * Opens the tool as a persistent standalone window so it stays
 * open while the user switches tabs or windows.
 */

let windowId = null;

chrome.action.onClicked.addListener(async () => {
  // If window is already open, just focus it
  if (windowId !== null) {
    try {
      await chrome.windows.update(windowId, { focused: true });
      return;
    } catch {
      // Window was closed externally — fall through to create a new one
      windowId = null;
    }
  }

  // Open a dedicated popup-style window (stays open independently of browser focus)
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 500,
    height: 720,
    focused: true,
  });

  windowId = win.id;

  // Clean up when the user closes the window
  chrome.windows.onRemoved.addListener(function onRemoved(removedId) {
    if (removedId === windowId) {
      windowId = null;
      chrome.windows.onRemoved.removeListener(onRemoved);
    }
  });
});
