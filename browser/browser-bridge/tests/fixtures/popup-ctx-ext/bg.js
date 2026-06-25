// Minimal MV3 service worker. Exists so the extension has a SW target the
// bridge can attach to and call chrome.action.openPopup() in — mirroring how
// real extensions (uBlock etc.) expose a SW. Touch chrome.action on startup so
// the worker has a reason to spin up and stay findable in /json/list.
chrome.runtime.onInstalled.addListener(() => {});
self.addEventListener('activate', () => {});
