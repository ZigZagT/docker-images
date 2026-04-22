// Verify the viewer updates the active tab indicator IMMEDIATELY on
// click, without waiting for the bridge's targetChanged round-trip.
// This is what distinguishes a snappy UI from a "seconds of lag" feel.
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

// Open viewer
const viewerTab = await httpPut('http://127.0.0.1:18800/json/new?http://127.0.0.1:6080');
await delay(1000);
const att = await cmd('Target.attachToTarget', { targetId: viewerTab.id, flatten: true });
if (att.error) fail('viewer-optimistic-tab-click', 'attach: ' + att.error.message);
const sid = att.result.sessionId;
await scmd(sid, 'Runtime.enable', {});
await delay(4000);

// Create 2 tabs via bridge
const bridgeWs = new WebSocket('ws://127.0.0.1:6080/ws');
await new Promise(r => bridgeWs.on('open', r));
await delay(1000);
bridgeWs.send(JSON.stringify({ type: 'newTab', url: 'https://example.com' }));
await delay(2000);
bridgeWs.send(JSON.stringify({ type: 'newTab', url: 'https://www.iana.org/' }));
await delay(3000);

// Install a latency probe in the viewer — measure time between click
// and the active-class changing on the clicked tab
await scmd(sid, 'Runtime.evaluate', {
  expression: `
    window._clickToActiveMs = null;
    const origClick = HTMLElement.prototype.click;
    window._measureTabClick = function(tabId) {
      return new Promise((resolve) => {
        const t0 = performance.now();
        const tabEl = document.querySelector('.tab[data-tab-id="' + tabId + '"]');
        if (!tabEl) { resolve(-1); return; }
        tabEl.click();
        // Poll for active class on clicked tab
        const check = setInterval(() => {
          if (tabEl.classList.contains('active')) {
            clearInterval(check);
            resolve(performance.now() - t0);
          }
        }, 2);
        setTimeout(() => { clearInterval(check); resolve(-1); }, 2000);
      });
    };
  `
});

// Get tab IDs from viewer
const tabsResp = await scmd(sid, 'Runtime.evaluate', {
  expression: `JSON.stringify(Array.from(document.querySelectorAll('.tab')).map(t => ({id: t.dataset.tabId, active: t.classList.contains('active')})))`
});
const viewerTabs = JSON.parse(tabsResp.result.result.value);
const inactive = viewerTabs.filter(t => !t.active && t.id !== viewerTab.id);
if (inactive.length < 1) fail('viewer-optimistic-tab-click', 'no inactive tab to click');

// Click an inactive tab, measure latency
const target = inactive[0].id;
const latencyResp = await scmd(sid, 'Runtime.evaluate', {
  expression: 'window._measureTabClick("' + target + '")',
  awaitPromise: true
});
const latency = latencyResp.result?.result?.value;

// Cleanup
await cmd('Target.closeTarget', { targetId: viewerTab.id }).catch(() => {});
bridgeWs.close();
cdp.close();

if (latency < 0) fail('viewer-optimistic-tab-click', 'tab never became active');
// Optimistic update should be <50ms (DOM manipulation + render).
// Non-optimistic would be 30-100ms+ (WebSocket round-trip to bridge).
// Anything under 50ms proves the UI is not waiting for the bridge.
if (latency >= 50) fail('viewer-optimistic-tab-click', 'tab activation took ' + latency.toFixed(1) + 'ms (expected <50ms for optimistic update)');

pass('viewer-optimistic-tab-click (latency: ' + latency.toFixed(1) + 'ms)');
process.exit(0);
