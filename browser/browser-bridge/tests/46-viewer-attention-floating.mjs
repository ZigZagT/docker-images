// Viewer renders the new attention surfaces correctly:
//   1. MCP-owned tabs get the .mcp-owned class (full-row background).
//   2. Tabs with attention get a .tab-attention-dot child (the blinking
//      dot in the tab title).
//   3. The #attention-floating box is VISIBLE only when the currently
//      active tab has an attention request — not for ANY tab with attention.
//   4. Clearing the active tab's attention hides the floating box.
//
// Strategy: have the bridge host its own viewer inside a tab (the bridge
// already supports this — test 13 does the same). Drive that viewer's
// state by setting attention via MCP, then read the rendered DOM from
// the viewer tab via CDP through the bridge's /devtools proxy.
import http from 'http';
import { WebSocket } from 'ws';
import { delay, pass, fail, httpGet } from './helpers.mjs';

function rpc(method, params) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params });
    const req = http.request('http://127.0.0.1:6080/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    }, r => {
      let buf = ''; r.on('data', c => buf += c);
      r.on('end', () => { try { res(JSON.parse(buf)); } catch { rej(new Error(buf.slice(0, 200))); } });
    });
    req.on('error', rej);
    req.write(body); req.end();
  });
}
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) throw new Error(r.error.message);
  if (r.result?.isError) throw new Error(r.result.content?.[0]?.text || 'tool error');
  const t = r.result?.content?.[0]?.text;
  try { return JSON.parse(t); } catch { return t; }
}

// Fresh state: clear any pre-existing attention from earlier runs.
const initial = await call('browser_list_tabs', {});
for (const t of initial.tabs) {
  if (t.attention) await call('browser_dismiss_attention', { tabId: t.id });
}

// Open two MCP tabs (target tabs) so the viewer has tabs to render.
const tabA = await call('browser_open', { url: 'https://example.com/a' });
const tabB = await call('browser_open', { url: 'https://example.com/b' });

// Open a third tab pointed at the bridge UI itself — this is the VIEWER
// we'll inspect. Open via /ws (not MCP) so we don't pollute the MCP FIFO
// and so the viewer tab is user-owned.
const v = new WebSocket('ws://127.0.0.1:6080/ws');
const vev = [];
await new Promise(r => v.on('open', r));
v.on('message', d => { try { const m = JSON.parse(d); if (m.type !== 'frame') vev.push(m); } catch {} });
function vwait(type, ms = 15000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('vwait TO ' + type)), ms);
    const i = setInterval(() => {
      const k = vev.findIndex(m => m.type === type);
      if (k >= 0) { clearTimeout(t); clearInterval(i); res(vev.splice(k, 1)[0]); }
    }, 50);
  });
}
await vwait('targetChanged');
vev.length = 0;
v.send(JSON.stringify({ type: 'newTab', url: 'http://127.0.0.1:6080/' }));
const vc = await vwait('targetChanged');
const viewerTabId = vc.targetId;
// Let the viewer settle — open WS, receive initial broadcasts, render.
await delay(2500);

// Probe the viewer's DOM via CDP through the /devtools proxy.
const cdp = new WebSocket(`ws://127.0.0.1:6080/devtools?target=${viewerTabId}`);
let cmdId = 1;
const pending = new Map();
await new Promise((res, rej) => { cdp.on('open', res); cdp.on('error', rej); });
cdp.on('message', raw => {
  try { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
});
function cmd(method, params = {}) {
  return new Promise((res, rej) => {
    const id = cmdId++;
    const t = setTimeout(() => { pending.delete(id); rej(new Error('CDP TO ' + method)); }, 15000);
    pending.set(id, v => { clearTimeout(t); res(v); });
    cdp.send(JSON.stringify({ id, method, params }));
  });
}
async function probe(expr) {
  const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('eval: ' + r.result.exceptionDetails.text);
  return r.result?.result?.value;
}

// 1. MCP tabs render with .mcp-owned class.
const mcpClassCount = await probe(`document.querySelectorAll('.tab.mcp-owned').length`);
if (mcpClassCount < 2) fail('viewer-attention-floating', `expected ≥2 .tab.mcp-owned, got ${mcpClassCount}`);

// Sanity: the viewer should be on its initial tab (tabA, the most recent
// MCP tab created BEFORE the viewer opened — bridge's last activeTargetId
// gets sent on viewer connect). We don't assume which tab is active; we
// just need a clean baseline.
const initialFloatingVisible = await probe(`document.getElementById('attention-floating').classList.contains('visible')`);
if (initialFloatingVisible !== false) {
  fail('viewer-attention-floating', 'attention-floating already visible at start');
}

// 2. Set attention on tabA. Switch the viewer to tabA. Floating box must
// be visible; tab in viewer must have a .tab-attention-dot child.
await call('browser_set_attention', {
  tabId: tabA.tabId,
  message: 'Solve the captcha then open the menu.\nMulti-line instructions are supported.',
});
// Switch the viewer to tabA via the viewer's protocol so currentTargetId
// inside the viewer matches.
await probe(`window.send && window.send({ type: 'switchTab', targetId: ${JSON.stringify(tabA.tabId)} })`);
await delay(1000);

const dotForTabA = await probe(`!!document.querySelector('.tab[data-tab-id="${tabA.tabId}"] .tab-attention-dot')`);
if (dotForTabA !== true) fail('viewer-attention-floating', 'tab-attention-dot missing on tabA after request');

const floatingVisibleA = await probe(`document.getElementById('attention-floating').classList.contains('visible')`);
if (floatingVisibleA !== true) {
  fail('viewer-attention-floating', 'attention-floating not visible after switching to attention-marked tabA');
}
const messageRendered = await probe(`document.querySelector('#attention-floating .af-message').textContent`);
if (!messageRendered.includes('Multi-line instructions are supported.')) {
  fail('viewer-attention-floating', 'floating message missing or wrong: ' + messageRendered);
}

// 3. Set attention on tabB too. Floating box on the viewer should still
// only show tabA's message (because the viewer is currently on tabA).
await call('browser_set_attention', { tabId: tabB.tabId, message: 'something else' });
await delay(500);
const messageStillA = await probe(`document.querySelector('#attention-floating .af-message').textContent`);
if (messageStillA.includes('something else')) {
  fail('viewer-attention-floating', 'floating box should NOT show tabB message while viewer is on tabA');
}
const dotForTabB = await probe(`!!document.querySelector('.tab[data-tab-id="${tabB.tabId}"] .tab-attention-dot')`);
if (dotForTabB !== true) fail('viewer-attention-floating', 'tab-attention-dot missing on tabB after request');

// 4. Switch the viewer to tabB. Floating box must update to show tabB's message.
await probe(`window.send && window.send({ type: 'switchTab', targetId: ${JSON.stringify(tabB.tabId)} })`);
await delay(1000);
const messageOnB = await probe(`document.querySelector('#attention-floating .af-message').textContent`);
if (!messageOnB.includes('something else')) {
  fail('viewer-attention-floating', 'after switching to tabB, floating box should show tabB message; got: ' + messageOnB);
}

// 5. Clear tabB's attention. Floating box must hide on the viewer.
await call('browser_dismiss_attention', { tabId: tabB.tabId });
await delay(500);
const floatingHidden = await probe(`document.getElementById('attention-floating').classList.contains('visible')`);
if (floatingHidden !== false) {
  fail('viewer-attention-floating', 'attention-floating should hide after clearing tabB');
}
const dotGone = await probe(`!!document.querySelector('.tab[data-tab-id="${tabB.tabId}"] .tab-attention-dot')`);
if (dotGone !== false) fail('viewer-attention-floating', 'tab-attention-dot should be removed after clear');

// 6. Confirm the obsolete banner is GONE — would catch a regression
// where someone reintroduces the always-on top banner we just removed.
const bannerExists = await probe(`!!document.getElementById('attention-banner')`);
if (bannerExists !== false) fail('viewer-attention-floating', 'old #attention-banner still present');

// 7. Synchronized blink: both attention dots (tab + floating box) must
// read the SAME --attention-blink CSS variable from :root, so they
// blink in lockstep regardless of when each element was created.
// Strategy: clear, mark TWO tabs at separated times, switch viewer to
// one of them so both dots are mounted, then sample :root's variable
// and both dots' computed opacity in the same render frame and assert
// they match.
await call('browser_dismiss_attention', { tabId: tabA.tabId });
await call('browser_set_attention', { tabId: tabA.tabId, message: 'first' });
await delay(300);
await call('browser_set_attention', { tabId: tabB.tabId, message: 'second' });
await delay(300);
await probe(`window.send && window.send({ type: 'switchTab', targetId: ${JSON.stringify(tabA.tabId)} })`);
await delay(800);
const sync = await probe(`(() => {
  const rootVar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--attention-blink'));
  const tabDots = [...document.querySelectorAll('.tab-attention-dot')]
    .map(d => parseFloat(getComputedStyle(d).opacity));
  const floatDot = parseFloat(getComputedStyle(document.querySelector('#attention-floating .af-title-dot')).opacity);
  return { rootVar, tabDots, floatDot };
})()`);
if (Number.isNaN(sync.rootVar)) {
  fail('viewer-attention-floating', '--attention-blink not animatable on :root: ' + JSON.stringify(sync));
}
for (const op of sync.tabDots) {
  if (Math.abs(op - sync.rootVar) > 0.01) {
    fail('viewer-attention-floating', `tab dot opacity ${op} out of sync with root var ${sync.rootVar}`);
  }
}
if (Math.abs(sync.floatDot - sync.rootVar) > 0.01) {
  fail('viewer-attention-floating', `floating dot opacity ${sync.floatDot} out of sync with root var ${sync.rootVar}`);
}
await call('browser_dismiss_attention', { tabId: tabB.tabId });

// 8. Collapse toggle: a user-clickable chevron hides the message body
// when the floating box gets in the way. State is per-tab and per-message —
// a fresh attention message re-expands automatically so the user sees it.
// Set attention on tabA so the box is showing, then exercise the toggle.
await call('browser_set_attention', { tabId: tabA.tabId, message: 'collapse-test message v1' });
await probe(`window.send && window.send({ type: 'switchTab', targetId: ${JSON.stringify(tabA.tabId)} })`);
await delay(800);

const toggleExists = await probe(`!!document.getElementById('attention-toggle')`);
if (!toggleExists) fail('viewer-attention-floating', 'collapse toggle button missing');

// Click the toggle → collapsed class added; message body hidden.
await probe(`document.getElementById('attention-toggle').click()`);
await delay(200);
const collapsedState = await probe(`(() => {
  const box = document.getElementById('attention-floating');
  const msgVisible = getComputedStyle(box.querySelector('.af-message')).display !== 'none';
  return JSON.stringify({ collapsed: box.classList.contains('collapsed'), msgVisible, toggleText: document.getElementById('attention-toggle').textContent });
})()`);
const cs = JSON.parse(collapsedState);
if (!cs.collapsed) fail('viewer-attention-floating', 'after click, .collapsed not added: ' + collapsedState);
if (cs.msgVisible) fail('viewer-attention-floating', 'after collapse, message body still visible');
if (cs.toggleText !== '▸') fail('viewer-attention-floating', 'collapse arrow not flipped to ▸: ' + cs.toggleText);

// Click again → expand.
await probe(`document.getElementById('attention-toggle').click()`);
await delay(200);
const expandedAgain = await probe(`document.getElementById('attention-floating').classList.contains('collapsed')`);
if (expandedAgain !== false) fail('viewer-attention-floating', 'second click did not expand');

// Collapse, then update the agent message → should auto-expand.
await probe(`document.getElementById('attention-toggle').click()`);
await delay(200);
await call('browser_set_attention', { tabId: tabA.tabId, message: 'collapse-test message v2 (updated)' });
await delay(500);
const afterUpdate = await probe(`(() => {
  const box = document.getElementById('attention-floating');
  return JSON.stringify({ collapsed: box.classList.contains('collapsed'), msg: box.querySelector('.af-message').textContent });
})()`);
const au = JSON.parse(afterUpdate);
if (au.collapsed) fail('viewer-attention-floating', 'updated message did not auto-expand');
if (!au.msg.includes('v2 (updated)')) fail('viewer-attention-floating', 'updated message not rendered: ' + au.msg);

// 9. Dismiss button: clicking ✕ on the floating box must send the
// dismissAttention WS event to the bridge, which clears server-side
// attention state — equivalent to the agent calling browser_dismiss_attention.
await call('browser_set_attention', { tabId: tabA.tabId, message: 'will be dismissed by user click' });
await delay(500);
const dismissExists = await probe(`!!document.getElementById('attention-dismiss')`);
if (!dismissExists) fail('viewer-attention-floating', 'dismiss button missing from floating box');
await probe(`document.getElementById('attention-dismiss').click()`);
await delay(800);
const afterDismiss = await call('browser_list_tabs', {});
const stillHas = afterDismiss.tabs.find(t => t.id === tabA.tabId)?.attention;
if (stillHas) fail('viewer-attention-floating', 'dismiss button did not clear server-side attention');
if (afterDismiss.attentionCount !== 0) {
  fail('viewer-attention-floating', 'attentionCount should be 0 after dismiss; got ' + afterDismiss.attentionCount);
}

// Cleanup.
await call('browser_dismiss_attention', { tabId: tabA.tabId });
await call('browser_close_tab', { tabId: tabA.tabId });
await call('browser_close_tab', { tabId: tabB.tabId });
v.send(JSON.stringify({ type: 'closeTab', targetId: viewerTabId }));
await delay(500);
cdp.close();
v.close();

pass('viewer-attention-floating (mcp-owned class, dot on tab, floating box visible only on active attention tab)');
process.exit(0);
