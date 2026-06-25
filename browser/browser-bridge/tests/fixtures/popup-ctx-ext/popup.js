// Report the active-tab context this popup resolves to. A correctly-hosted
// popup (opened via chrome.action.openPopup, anchored to a browser window)
// gets the user's viewed page from chrome.tabs.query({active,currentWindow}).
// A popup mistakenly opened as its own top-level tab resolves currentWindow to
// itself and reports its own chrome-extension URL — that's the bug we test.
// Surface the result via document.title so it can be read from CDP /json/list
// without evaluating inside this (potentially short-lived) popup document.
(async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = (tabs && tabs[0]) ? tabs[0].url : 'NONE';
    document.title = 'CTX:' + url;
    document.getElementById('out').textContent = JSON.stringify((tabs || []).map(t => t.url));
  } catch (e) {
    document.title = 'CTX-ERR:' + String(e && e.message || e);
  }
})();
