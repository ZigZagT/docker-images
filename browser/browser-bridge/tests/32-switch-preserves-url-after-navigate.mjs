// The core bug: navigate a tab, switch away, switch back — URL must be preserved.
// Tests the VIEWER PAGE behavior, not just the bridge WebSocket.
// This catches the root cause: viewer's popstate handler sending history.back()
// through the bridge, which executes on the screencasted tab.
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

const ver = await httpGet('http://127.0.0.1:18800/json/version');
const cdp = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise(r => cdp.on('open', r));
let cmdId = 1;
const pending = new Map();
cdp.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
function cmd(m, p) { return new Promise((r, j) => { const i = cmdId++; const t = setTimeout(() => { pending.delete(i); j(new Error('TO')); }, 15e3); pending.set(i, v => { clearTimeout(t); r(v); }); cdp.send(JSON.stringify({ id: i, method: m, params: p })); }); }
function scmd(s, m, p) { return new Promise((r, j) => { const i = cmdId++; const t = setTimeout(() => { pending.delete(i); j(new Error('TO')); }, 15e3); pending.set(i, v => { clearTimeout(t); r(v); }); cdp.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); }); }

// Open viewer in Chrome — this is the real user scenario
const viewerTab = await httpPut('http://127.0.0.1:18800/json/new?http://127.0.0.1:6080');
await delay(1000);
const att = await cmd('Target.attachToTarget', { targetId: viewerTab.id, flatten: true });
if (att.error) fail('switch-preserves-url', 'attach: ' + att.error.message);
const sid = att.result.sessionId;
await scmd(sid, 'Runtime.enable', {});
await delay(4000);

// Create tab and navigate via the bridge (simulates user clicking + and typing URL)
const bridgeWs = new WebSocket('ws://127.0.0.1:6080/ws');
await new Promise(r => bridgeWs.on('open', r));
const bev = [];
bridgeWs.on('message', d => { const m = JSON.parse(d); if (m.type === 'frame') return; bev.push(m); });
function bwait(type, ms = 8000) {
  return new Promise((r, j) => {
    const t = setTimeout(() => j(new Error('bwait TO: ' + type)), ms);
    const c = setInterval(() => { const i = bev.findIndex(m => m.type === type); if (i >= 0) { clearTimeout(t); clearInterval(c); r(bev.splice(i, 1)[0]); } }, 50);
  });
}
await bwait('targetChanged');
bev.length = 0;

// Create two tabs
bridgeWs.send(JSON.stringify({ type: 'newTab' }));
const tab1 = await bwait('targetChanged');
bev.length = 0;

bridgeWs.send(JSON.stringify({ type: 'newTab', url: 'https://example.com' }));
const tab2 = await bwait('targetChanged');
bev.length = 0;

// Switch to tab1 and navigate it
bridgeWs.send(JSON.stringify({ type: 'switchTab', targetId: tab1.targetId }));
await bwait('targetChanged');
bev.length = 0;

bridgeWs.send(JSON.stringify({ type: 'navigate', url: 'https://www.iana.org/' }));
await bwait('navigated');
await delay(3000);
bev.length = 0;

// Switch to tab2 (viewer page receives targetChanged, updates hash/state)
bridgeWs.send(JSON.stringify({ type: 'switchTab', targetId: tab2.targetId }));
await bwait('targetChanged');
await delay(2000);
bev.length = 0;

// Switch back to tab1 — this is where the revert would happen
bridgeWs.send(JSON.stringify({ type: 'switchTab', targetId: tab1.targetId }));
await bwait('targetChanged');
await delay(3000);

// Check the viewer's URL bar (the DOM element the user sees)
const urlResp = await scmd(sid, 'Runtime.evaluate', {
  expression: 'document.getElementById("url-bar").value'
});
const urlBar = urlResp.result?.result?.value;

// Check Chrome's actual URL
const list = await httpGet('http://127.0.0.1:18800/json/list');
const chromeUrl = list.find(t => t.id === tab1.targetId)?.url;

// Check for revert events
const reverts = bev.filter(m => m.type === 'navigated' && (m.url === 'about:blank' || m.url === 'chrome://newtab/'));

await cmd('Target.closeTarget', { targetId: viewerTab.id }).catch(() => {});
bridgeWs.close();
cdp.close();

if (reverts.length > 0) fail('switch-preserves-url', 'revert events: ' + reverts.map(r => r.url));
if (chromeUrl === 'about:blank' || chromeUrl === 'chrome://newtab/') fail('switch-preserves-url', 'Chrome URL reverted: ' + chromeUrl);
if (urlBar === 'about:blank' || urlBar === 'chrome://newtab/') fail('switch-preserves-url', 'viewer URL bar reverted: ' + urlBar);
if (!chromeUrl?.includes('iana.org')) fail('switch-preserves-url', 'Chrome URL wrong: ' + chromeUrl);

pass('switch-preserves-url');
process.exit(0);
