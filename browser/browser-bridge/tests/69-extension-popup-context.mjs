// chrome.action.openPopup() binds the popup to Chrome's active tab in the
// focused window. The bridge's viewed tab (activeTargetId) can drift from
// Chrome's active tab, and the popup would then open with the wrong tab's
// context. openExtensionPopup must re-activate the viewed tab before calling
// openPopup so the popup's chrome.tabs.query({active,currentWindow}) resolves
// to what the user is looking at.
//
// Requires the popup-ctx-ext test extension (its popup writes the active tab
// it sees into document.title as "CTX:<url>"). Run with:
//   make run-browser-test LOAD_EXTENSION=/opt/browser-bridge/tests/fixtures/popup-ctx-ext TESTS=69-extension-popup-context
// When no extension is loaded the test self-skips (passes) so it stays safe in
// the default suite, which runs Chrome without --load-extension.
import { WebSocket } from 'ws';
import { connectViewer, httpGet, delay, pass, fail } from './helpers.mjs';

const CDP = 'http://127.0.0.1:18800';

const ver = await httpGet(CDP + '/json/version');
const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
let cmdId = 1; const pending = new Map();
ws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); f(m); } });
function cmd(method, params = {}) { const id = cmdId++; return new Promise((res, rej) => { const t = setTimeout(() => { pending.delete(id); rej(new Error('timeout ' + method)); }, 10000); pending.set(id, m => { clearTimeout(t); res(m); }); ws.send(JSON.stringify({ id, method, params })); }); }

// Locate the loaded extension's service worker. Absent → no extension → skip.
let sw = null;
for (let i = 0; i < 20; i++) {
  const list = await httpGet(CDP + '/json/list');
  sw = list.find(t => /^chrome-extension:\/\//.test(t.url || '') && (t.type === 'service_worker' || t.type === 'background_page'));
  if (sw) break;
  await delay(500);
}
if (!sw) { pass('extension-popup-context (skipped — no extension loaded)'); process.exit(0); }
const EXT = sw.url.split('/')[2];

async function popupTitles() {
  const list = await httpGet(CDP + '/json/list');
  return list.filter(t => (t.url || '').startsWith('chrome-extension://' + EXT + '/') && /popup\.html/.test(t.url || '')).map(t => t.title);
}
async function closeAllPopups() {
  const list = await httpGet(CDP + '/json/list');
  for (const t of list) if ((t.url || '').startsWith('chrome-extension://' + EXT + '/') && /popup\.html/.test(t.url || '')) await cmd('Target.closeTarget', { targetId: t.id });
}
function ctxUrl(titles) {
  const t = titles.find(x => /^CTX:/.test(x || ''));
  return t ? t.slice(4) : null;
}

const v = await connectViewer();
await delay(500);
v.send({ type: 'newTab', url: 'https://example.com/VIEWED' });
await delay(2500);
v.send({ type: 'newTab', url: 'https://example.com/OTHER' });
await delay(2500);

const list0 = await httpGet(CDP + '/json/list');
const viewed = list0.find(t => (t.url || '').includes('/VIEWED'));
const other = list0.find(t => (t.url || '').includes('/OTHER'));
if (!viewed || !other) { v.close(); ws.close(); fail('extension-popup-context', 'could not open the two content tabs'); }

// Normal case: viewed tab is also Chrome-active.
v.send({ type: 'switchTab', targetId: viewed.id });
await delay(1500);
await closeAllPopups();
v.send({ type: 'openExtensionPopup', extensionId: EXT, popup: 'popup.html' });
await delay(3000);
const ctxA = ctxUrl(await popupTitles());
await closeAllPopups();
await delay(500);

// Drift case: viewer shows /VIEWED, but Chrome's active tab is forced to /OTHER
// behind the bridge's back. The fix must re-activate /VIEWED before openPopup.
v.send({ type: 'switchTab', targetId: viewed.id });
await delay(1500);
await cmd('Target.activateTarget', { targetId: other.id });
await delay(500);
v.send({ type: 'openExtensionPopup', extensionId: EXT, popup: 'popup.html' });
await delay(3000);
const ctxB = ctxUrl(await popupTitles());

v.close(); ws.close();

if (ctxA !== 'https://example.com/VIEWED') fail('extension-popup-context', `case A: popup saw ${ctxA}, expected /VIEWED`);
if (ctxB !== 'https://example.com/VIEWED') fail('extension-popup-context', `case B (drift): popup saw ${ctxB}, expected /VIEWED — viewed tab not re-activated before openPopup`);
pass('extension-popup-context');
process.exit(0);
