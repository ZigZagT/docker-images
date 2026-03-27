// Test navigation using Chrome's own renderer to load the viewer page.
// This matches real browser usage — the viewer's JS runs inside Chrome,
// creating the same bfcache/lifecycle conditions as a real user.
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

// Connect directly to Chrome's CDP (not through the bridge)
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
  return new Promise((res, rej) => {
    const id = cmdId++;
    pending.set(id, res);
    cdp.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout: ' + method)); }, 15000);
  });
}
function scmd(sid, method, params) {
  return new Promise((res, rej) => {
    const id = cmdId++;
    pending.set(id, res);
    cdp.send(JSON.stringify({ id, method, params, sessionId: sid }));
    setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout: ' + method)); }, 15000);
  });
}

// Open the viewer page in Chrome's own tab — exactly like a real browser
const viewerTab = await httpPut('http://127.0.0.1:18800/json/new?http://127.0.0.1:6080');
const sid = (await cmd('Target.attachToTarget', { targetId: viewerTab.id, flatten: true })).result.sessionId;
await scmd(sid, 'Page.enable', {});
await scmd(sid, 'Runtime.enable', {});
await delay(3000); // let viewer load and connect

// Interact with the viewer DOM: click "+" to create new tab
await scmd(sid, 'Runtime.evaluate', {
  expression: `document.getElementById('btn-new-tab').click()`
});
await delay(2000);

// Send navigate command through the viewer's WebSocket (same as typing in URL bar + Enter)
await scmd(sid, 'Runtime.evaluate', {
  expression: `send({ type: 'navigate', url: 'https://www.browserscan.net/bot-detection' })`
});
await delay(5000); // let page load

// Get current tab list from the viewer's perspective
const tabsResp = await scmd(sid, 'Runtime.evaluate', {
  expression: `JSON.stringify(Array.from(document.querySelectorAll('.tab')).map(t => ({
    id: t.dataset.tabId,
    active: t.classList.contains('active'),
    title: t.querySelector('.tab-title')?.textContent
  })))`
});
const viewerTabs = JSON.parse(tabsResp.result.result.value);
const activeTab = viewerTabs.find(t => t.active);
const otherTab = viewerTabs.find(t => !t.active);

if (!activeTab || !otherTab) fail('browser-viewer-navigate', 'need 2 tabs, got: ' + JSON.stringify(viewerTabs));

// Click the other tab to switch
await scmd(sid, 'Runtime.evaluate', {
  expression: `document.querySelector('.tab[data-tab-id="${otherTab.id}"]').click()`
});
await delay(3000);

// Click back to the original tab
await scmd(sid, 'Runtime.evaluate', {
  expression: `document.querySelector('.tab[data-tab-id="${activeTab.id}"]').click()`
});
await delay(3000);

// Check: read the URL bar value — does it show browserscan or about:blank/newtab?
const urlResp = await scmd(sid, 'Runtime.evaluate', {
  expression: `document.getElementById('url-bar').value`
});
const urlBarValue = urlResp.result.result.value;

// Also check Chrome's /json/list for the actual URL
const list = await httpGet('http://127.0.0.1:18800/json/list');
// Find the browserscan tab (not the viewer tab, not example.com)
const pages = list.filter(t => t.type === 'page' && t.id !== viewerTab.id);

// Close viewer tab
await cmd('Target.closeTarget', { targetId: viewerTab.id }).catch(() => {});
cdp.close();

// Check results
if (urlBarValue === 'about:blank' || urlBarValue === 'chrome://newtab/') {
  fail('browser-viewer-navigate', 'URL bar shows: ' + urlBarValue + ' (reverted to creation URL)');
}
if (urlBarValue?.includes('browserscan')) {
  pass('browser-viewer-navigate');
} else {
  fail('browser-viewer-navigate', 'URL bar shows: ' + urlBarValue);
}
process.exit(0);
