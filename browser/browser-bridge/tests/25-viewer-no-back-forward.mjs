// Verifies the viewer page does NOT send back/forward commands during
// tab switches. This was the root cause of the URL revert bug: the
// viewer's popstate handler sent history.back() through the bridge,
// which executed on the screencasted tab instead of the viewer's own page.
//
// Loads the actual viewer page in Chrome via CDP, switches tabs, then
// checks bridge state for any unexpected navigations.
import http from 'http';
import { WebSocket } from 'ws';
import { delay, pass, fail, httpGet } from './helpers.mjs';

function httpPut(u) {
  return new Promise((r, j) => {
    const q = http.request(u, { method: 'PUT' }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d)));
    }); q.on('error', j); q.end();
  });
}

// Clean tabs first
const preTabs = await httpGet('http://127.0.0.1:18800/json/list');
for (const t of preTabs.filter(t => t.type === 'page').slice(1)) {
  await new Promise(r => http.get('http://127.0.0.1:18800/json/close/' + t.id, () => r()).on('error', () => r()));
}
await delay(1000);

// Connect to Chrome directly
const ver = await httpGet('http://127.0.0.1:18800/json/version');
const cdp = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise(r => cdp.on('open', r));

let cmdId = 1;
const pending = new Map();
cdp.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function cmd(method, params) {
  return new Promise((r, j) => {
    const id = cmdId++;
    pending.set(id, r);
    cdp.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { pending.delete(id); j(new Error('timeout: ' + method)); }, 15000);
  });
}
function scmd(sid, method, params) {
  return new Promise((r, j) => {
    const id = cmdId++;
    pending.set(id, r);
    cdp.send(JSON.stringify({ id, method, params, sessionId: sid }));
    setTimeout(() => { pending.delete(id); j(new Error('timeout: ' + method)); }, 15000);
  });
}

// Open the viewer page in Chrome
const viewerTab = await httpPut('http://127.0.0.1:18800/json/new?http://127.0.0.1:6080');
await delay(1000);
const attResp = await cmd('Target.attachToTarget', { targetId: viewerTab.id, flatten: true });
if (attResp.error) fail('viewer-no-back-forward', 'attach failed: ' + attResp.error.message);
const sid = attResp.result.sessionId;
await scmd(sid, 'Page.enable', {});
await scmd(sid, 'Runtime.enable', {});
await delay(4000);

// Viewer should be connected. Create a tab via the bridge (not through viewer DOM)
const bridgeWs = new WebSocket('ws://127.0.0.1:6080/ws');
await new Promise(r => bridgeWs.on('open', r));
const bridgeEvents = [];
bridgeWs.on('message', d => {
  const m = JSON.parse(d);
  if (m.type === 'frame') return;
  bridgeEvents.push(m);
});
await delay(1000);

// Create a tab with a URL, navigate it
bridgeWs.send(JSON.stringify({ type: 'newTab', url: 'https://example.com' }));
await delay(3000);
bridgeEvents.length = 0;

// Create another tab to switch between
bridgeWs.send(JSON.stringify({ type: 'newTab' }));
await delay(2000);

// Navigate the new tab
bridgeWs.send(JSON.stringify({ type: 'navigate', url: 'https://www.iana.org/' }));
await delay(3000);
bridgeEvents.length = 0;

// Now do rapid tab switches via the bridge — viewer page will receive
// targetChanged events and update location.hash. If the popstate handler
// is still active, it would send back/forward commands.
const tabList = await httpGet('http://127.0.0.1:18800/json/list');
const pages = tabList.filter(t => t.type === 'page' && t.id !== viewerTab.id);
if (pages.length < 2) fail('viewer-no-back-forward', 'need >= 2 tabs, got ' + pages.length);

// Switch back and forth 3 times
for (let i = 0; i < 3; i++) {
  bridgeWs.send(JSON.stringify({ type: 'switchTab', targetId: pages[0].id }));
  await delay(1500);
  bridgeWs.send(JSON.stringify({ type: 'switchTab', targetId: pages[1].id }));
  await delay(1500);
}

// Wait for events to settle
await delay(2000);

// Check: no navigated events with about:blank or chrome://newtab/
// (would indicate history.back() was executed on the active tab)
const revertEvents = bridgeEvents.filter(m =>
  m.type === 'navigated' && (m.url === 'about:blank' || m.url === 'chrome://newtab/'));

// Check Chrome's actual tab URLs — none should have reverted
const finalList = await httpGet('http://127.0.0.1:18800/json/list');
const finalPages = finalList.filter(t => t.type === 'page' && t.id !== viewerTab.id);
const reverted = finalPages.filter(t => t.url === 'about:blank' && pages.some(p => p.id === t.id));

// Cleanup
await cmd('Target.closeTarget', { targetId: viewerTab.id }).catch(() => {});
bridgeWs.close();
cdp.close();

if (revertEvents.length > 0) {
  fail('viewer-no-back-forward', 'viewer caused revert: navigated to ' + revertEvents[0].url);
}
if (reverted.length > 0) {
  fail('viewer-no-back-forward', 'tab reverted: ' + reverted.map(t => t.id.slice(0, 8)).join(', '));
}

pass('viewer-no-back-forward');
process.exit(0);
