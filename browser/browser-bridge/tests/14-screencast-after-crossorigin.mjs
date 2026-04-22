// Verify startScreencast behavior after cross-origin navigation.
// Tests directly against CDP (bypasses bridge) to isolate Chrome behavior.
// Debunks: "startScreencast hangs ~10s after cross-origin renderer swap"
// Actual: Chrome returns fast error or succeeds; no hang.
import http from 'http';
import { WebSocket } from 'ws';
import { pass, fail, delay } from './helpers.mjs';

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 18800;
const SC_OPTS = { format: 'jpeg', quality: 50, maxWidth: 800, maxHeight: 600 };

function httpGet(u) {
  return new Promise((r, j) => http.get(u, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d)));
  }).on('error', j));
}

const ver = await httpGet(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise(r => ws.on('open', r));

let cmdId = 1;
const pending = new Map();
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});

function cmd(method, params, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const id = cmdId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('TIMEOUT ' + method)); }, timeout);
    pending.set(id, v => { clearTimeout(timer); resolve(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function scmd(sid, method, params, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const id = cmdId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('TIMEOUT ' + method)); }, timeout);
    pending.set(id, v => { clearTimeout(timer); resolve(v); });
    ws.send(JSON.stringify({ id, method, params, sessionId: sid }));
  });
}

const cr = await cmd('Target.createTarget', { url: 'about:blank', background: true });
const targetId = cr.result.targetId;
const att = await cmd('Target.attachToTarget', { targetId, flatten: true });
const sid = att.result.sessionId;
await scmd(sid, 'Page.enable', {});

// Baseline: startScreencast on about:blank
let t0 = Date.now();
let sc = await scmd(sid, 'Page.startScreencast', SC_OPTS);
let elapsed = Date.now() - t0;
if (sc.error) fail('screencast-after-crossorigin', 'baseline failed: ' + sc.error.message);
if (elapsed > 2000) fail('screencast-after-crossorigin', 'baseline too slow: ' + elapsed + 'ms');
await scmd(sid, 'Page.stopScreencast', {});

// Start screencast, navigate cross-origin, stop, start again
await scmd(sid, 'Page.startScreencast', SC_OPTS);
await scmd(sid, 'Page.navigate', { url: 'https://example.com' });
await delay(2000);
await scmd(sid, 'Page.stopScreencast', {});

t0 = Date.now();
sc = await scmd(sid, 'Page.startScreencast', SC_OPTS);
elapsed = Date.now() - t0;
if (sc.error) fail('screencast-after-crossorigin', 'after cross-origin failed: ' + sc.error.message);
if (elapsed > 2000) fail('screencast-after-crossorigin', 'after cross-origin too slow: ' + elapsed + 'ms');
await scmd(sid, 'Page.stopScreencast', {});

// Second cross-origin: example.com -> browserscan
await scmd(sid, 'Page.navigate', { url: 'https://www.browserscan.net/bot-detection' });
await delay(3000);

t0 = Date.now();
sc = await scmd(sid, 'Page.startScreencast', SC_OPTS);
elapsed = Date.now() - t0;
if (sc.error) fail('screencast-after-crossorigin', 'after 2nd cross-origin failed: ' + sc.error.message);
if (elapsed > 2000) fail('screencast-after-crossorigin', 'after 2nd cross-origin too slow: ' + elapsed + 'ms');

await cmd('Target.closeTarget', { targetId }).catch(() => {});
ws.close();
pass('screencast-after-crossorigin');
process.exit(0);
