// Verifies the viewer page sends resumeScreencast (not switchTab) on
// visibilitychange. switchTab triggers a full switchToTarget which can
// race with in-flight navigations. resumeScreencast just restarts
// frame capture without side effects.
//
// Loads the viewer in Chrome, simulates visibilitychange, and checks
// which message type the viewer sends to the bridge.
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

// Connect to Chrome
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

// Open viewer
const viewerTab = await httpPut('http://127.0.0.1:18800/json/new?http://127.0.0.1:6080');
await delay(1000);
const attResp = await cmd('Target.attachToTarget', { targetId: viewerTab.id, flatten: true });
if (attResp.error) fail('viewer-resumes-not-switches', 'attach failed: ' + attResp.error.message);
const sid = attResp.result.sessionId;
await scmd(sid, 'Page.enable', {});
await scmd(sid, 'Runtime.enable', {});
await delay(4000);

// Intercept at the WebSocket.send level — the viewer's `send` function
// is a script-scope declaration that V8 resolves through the script
// context slot, not window.send. Overriding window.send doesn't affect
// the handler's closure reference. Patching ws.send captures all
// outgoing messages regardless of call path.
await scmd(sid, 'Runtime.evaluate', {
  expression: `
    window._sentMessages = [];
    if (ws && ws.send) {
      const _origWsSend = ws.send.bind(ws);
      ws.send = function(data) {
        try { window._sentMessages.push(JSON.parse(data)); } catch {}
        return _origWsSend(data);
      };
    }
  `
});

// Simulate visibilitychange by dispatching it manually
await scmd(sid, 'Runtime.evaluate', {
  expression: `
    Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  `
});
await delay(1000);

// Read what the viewer sent
const resp = await scmd(sid, 'Runtime.evaluate', {
  expression: 'JSON.stringify(window._sentMessages)'
});
const sent = JSON.parse(resp.result.result.value);

// Cleanup
await cmd('Target.closeTarget', { targetId: viewerTab.id }).catch(() => {});
cdp.close();

// Check: should have resumeScreencast, NOT switchTab
const hasSwitchTab = sent.some(m => m.type === 'switchTab');
const hasResumeScreencast = sent.some(m => m.type === 'resumeScreencast');

if (hasSwitchTab) {
  fail('viewer-resumes-not-switches', 'viewer sent switchTab on visibilitychange (should be resumeScreencast)');
}
if (!hasResumeScreencast) {
  fail('viewer-resumes-not-switches', 'viewer did not send resumeScreencast on visibilitychange');
}

pass('viewer-resumes-not-switches');
process.exit(0);
