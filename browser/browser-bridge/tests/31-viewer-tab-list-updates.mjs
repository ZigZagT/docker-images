// Viewer page tab list updates when tabs are created/closed.
// Loads viewer in Chrome, creates tabs via bridge, verifies viewer DOM reflects changes.
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
cdp.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function cmd(m, p) { return new Promise((r, j) => { const i = cmdId++; const t = setTimeout(() => { pending.delete(i); j(new Error('TO')); }, 15e3); pending.set(i, v => { clearTimeout(t); r(v); }); cdp.send(JSON.stringify({ id: i, method: m, params: p })); }); }
function scmd(s, m, p) { return new Promise((r, j) => { const i = cmdId++; const t = setTimeout(() => { pending.delete(i); j(new Error('TO')); }, 15e3); pending.set(i, v => { clearTimeout(t); r(v); }); cdp.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); }); }

const viewerTab = await httpPut('http://127.0.0.1:18800/json/new?http://127.0.0.1:6080');
await delay(1000);
const att = await cmd('Target.attachToTarget', { targetId: viewerTab.id, flatten: true });
if (att.error) fail('viewer-tab-list-updates', 'attach: ' + att.error.message);
const sid = att.result.sessionId;
await scmd(sid, 'Runtime.enable', {});
await delay(4000);

// Count tabs in viewer DOM before
const before = await scmd(sid, 'Runtime.evaluate', {
  expression: 'document.querySelectorAll(".tab").length'
});
const countBefore = before.result?.result?.value;

// Create a tab via bridge
const bridgeWs = new WebSocket('ws://127.0.0.1:6080/ws');
await new Promise(r => bridgeWs.on('open', r));
await delay(1000);
bridgeWs.send(JSON.stringify({ type: 'newTab', url: 'https://example.com' }));
await delay(3000);

// Count tabs after
const after = await scmd(sid, 'Runtime.evaluate', {
  expression: 'document.querySelectorAll(".tab").length'
});
const countAfter = after.result?.result?.value;

await cmd('Target.closeTarget', { targetId: viewerTab.id }).catch(() => {});
bridgeWs.close();
cdp.close();

if (countAfter <= countBefore) {
  fail('viewer-tab-list-updates', 'tab count did not increase: before=' + countBefore + ' after=' + countAfter);
}

pass('viewer-tab-list-updates');
process.exit(0);
