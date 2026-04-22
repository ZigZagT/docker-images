// Verify viewer survives a malformed WebSocket message without breaking
// subsequent handlers. Before fix: one bad message killed all further
// UI updates (JSON.parse threw, onmessage handler crashed).
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

const viewerTab = await httpPut('http://127.0.0.1:18800/json/new?http://127.0.0.1:6080');
await delay(1000);
const att = await cmd('Target.attachToTarget', { targetId: viewerTab.id, flatten: true });
if (att.error) fail('viewer-resilient-to-bad-message', 'attach: ' + att.error.message);
const sid = att.result.sessionId;
await scmd(sid, 'Runtime.enable', {});
await delay(4000);

// Inject a bad message by dispatching a fake MessageEvent on the viewer's ws
// This tests the onmessage handler's error resilience. We can't easily
// inject bad data over a real WebSocket, so we call the handler directly.
const injectResp = await scmd(sid, 'Runtime.evaluate', {
  expression: `
    (() => {
      try {
        // Simulate receiving a malformed message
        ws.dispatchEvent(new MessageEvent('message', { data: 'not-json-at-all' }));
        // If we reach here without exception killing the event loop, handler recovered
        return 'handler-survived';
      } catch (e) {
        return 'handler-threw: ' + e.message;
      }
    })()
  `
});
const result = injectResp.result?.result?.value;

// After bad message, verify the URL bar still updates on subsequent navigate
const bridgeWs = new WebSocket('ws://127.0.0.1:6080/ws');
await new Promise(r => bridgeWs.on('open', r));
await delay(500);
bridgeWs.send(JSON.stringify({ type: 'navigate', url: 'https://example.com' }));
await delay(3000);

const urlResp = await scmd(sid, 'Runtime.evaluate', {
  expression: 'document.getElementById("url-bar").value'
});
const urlBar = urlResp.result?.result?.value;

await cmd('Target.closeTarget', { targetId: viewerTab.id }).catch(() => {});
bridgeWs.close();
cdp.close();

if (result !== 'handler-survived') fail('viewer-resilient-to-bad-message', 'handler result: ' + result);
if (!urlBar?.includes('example.com')) fail('viewer-resilient-to-bad-message', 'URL bar stopped updating: ' + urlBar);

pass('viewer-resilient-to-bad-message');
process.exit(0);
