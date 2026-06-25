// MCP ownership + attention must survive a bridge restart. The bridge keeps
// all MCP-owned/attention state in memory, so a restart used to wipe it: the
// FIFO count reset to zero and every previously-owned tab looked user-owned.
//
// The fix persists that state to disk and, on the next connect, re-matches
// persisted records to the live tabs by the sessionStorage UUID stamped into
// each owned tab (history-hash fallback for opaque origins). This test drives
// the real path end-to-end:
//   1. open MCP tabs (each gets a stamped UUID marker) + set attention
//   2. `chrome restart-bridge` — kills/respawns the bridge, Chrome stays up so
//      tabs and their sessionStorage survive with the SAME targetIds
//   3. the fresh bridge (empty maps) must rehydrate from disk on first tool
//      call and re-establish ownership + attention, without claiming the
//      user-opened tab.
//
// Restarting only the bridge (not Chrome) deliberately isolates THIS code from
// Chrome's session-restore feature: here the surviving tabs are real, so a
// failure points squarely at persist/load/match, not at Chrome config.
import http from 'http';
import { execFile } from 'child_process';
import { WebSocket } from 'ws';
import { delay, pass, fail } from './helpers.mjs';

function rpc(method, params) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params });
    const req = http.request('http://127.0.0.1:6080/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    }, r => {
      let buf = ''; r.on('data', c => buf += c);
      r.on('end', () => { try { res(JSON.parse(buf)); } catch { rej(new Error('non-JSON: ' + buf.slice(0, 200))); } });
    });
    req.on('error', rej);
    req.write(body); req.end();
  });
}

async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) throw new Error(r.error.message);
  const t = r.result?.content?.[0]?.text;
  try { return JSON.parse(t); } catch { return t; }
}

// Read the sessionStorage marker through the page; JSON.stringify so the value
// round-trips as clean JSON (string uuid or null) through the call() parser.
function readMarker(tabId) {
  return call('browser_evaluate', { tabId, expression: `JSON.stringify(sessionStorage.getItem('__bb_mcp'))` });
}

function healthOk() {
  return new Promise(res => {
    const req = http.get('http://127.0.0.1:6080/health', r => { r.resume(); r.on('end', () => res(r.statusCode === 200)); });
    req.on('error', () => res(false));
    req.setTimeout(1000, () => { req.destroy(); res(false); });
  });
}

async function waitForBridge(downFirst) {
  // After restart-bridge the old process is killed then a new one binds the
  // same port. Optionally wait for it to go DOWN first so we don't observe the
  // pre-restart process as "up".
  if (downFirst) {
    for (let i = 0; i < 50; i++) { if (!(await healthOk())) break; await delay(100); }
  }
  for (let i = 0; i < 100; i++) { if (await healthOk()) return; await delay(200); }
  fail('mcp-ownership-survives-restart', 'bridge did not come back after restart');
}

// --- setup: start from a clean MCP FIFO ---
const initialList = await call('browser_list_tabs', {});
for (const t of initialList.tabs) {
  if (t.mcpOwned) await call('browser_close_tab', { tabId: t.id });
}
await delay(500);

// A user tab opened via /ws — it has no marker and must NOT be re-owned.
const v = new WebSocket('ws://127.0.0.1:6080/ws');
const vev = [];
await new Promise(r => v.on('open', r));
v.on('message', d => { try { const m = JSON.parse(d); if (m.type !== 'frame') vev.push(m); } catch {} });
function vwait(type, ms = 8000) {
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
v.send(JSON.stringify({ type: 'newTab', url: 'https://example.com/user' }));
const userTabId = (await vwait('targetChanged')).targetId;

// Two MCP-owned tabs; attention on the second.
const a = await call('browser_open', { url: 'https://example.com/a' });
const b = await call('browser_open', { url: 'https://example.com/b' });
const ATT = 'please solve the captcha on tab b';
await call('browser_set_attention', { tabId: b.tabId, message: ATT });

// Markers must be stamped on MCP tabs and absent on the user tab.
const markerA = await readMarker(a.tabId);
const markerB = await readMarker(b.tabId);
const markerUser = await readMarker(userTabId);
if (typeof markerA !== 'string' || markerA.length < 8) {
  fail('mcp-ownership-survives-restart', 'tab a missing sessionStorage marker: ' + JSON.stringify(markerA));
}
if (typeof markerB !== 'string' || markerB.length < 8) {
  fail('mcp-ownership-survives-restart', 'tab b missing sessionStorage marker: ' + JSON.stringify(markerB));
}
if (markerA === markerB) {
  fail('mcp-ownership-survives-restart', 'markers must be unique per tab, both = ' + markerA);
}
if (markerUser !== null) {
  fail('mcp-ownership-survives-restart', 'user tab should not be marked, got: ' + JSON.stringify(markerUser));
}

// Let the debounced persist flush to disk before killing the bridge.
await delay(1500);

// --- restart the bridge only (Chrome and its tabs survive) ---
v.close();
await new Promise((res, rej) => execFile('/usr/local/bin/chrome', ['restart-bridge'], err => err ? rej(err) : res()));
await waitForBridge(true);
// First tool call triggers rehydration from disk.
await delay(500);

const list = await call('browser_list_tabs', {});
const byId = new Map(list.tabs.map(t => [t.id, t]));

// Both MCP tabs must be back AND re-owned.
for (const [label, id] of [['a', a.tabId], ['b', b.tabId]]) {
  const t = byId.get(id);
  if (!t) fail('mcp-ownership-survives-restart', `tab ${label} (${id}) missing after restart`);
  if (!t.mcpOwned) fail('mcp-ownership-survives-restart', `tab ${label} lost mcpOwned after restart: ${JSON.stringify(t)}`);
}
// FIFO count must reflect the two recovered tabs (not reset to 0).
if (list.mcpOwnedCount !== 2) {
  fail('mcp-ownership-survives-restart', 'expected mcpOwnedCount=2 after restart, got ' + list.mcpOwnedCount);
}
// Attention must be preserved on tab b (and only b).
const tb = byId.get(b.tabId);
if (!tb.attention || tb.attention.message !== ATT) {
  fail('mcp-ownership-survives-restart', 'attention not restored on tab b: ' + JSON.stringify(tb.attention));
}
const ta = byId.get(a.tabId);
if (ta.attention) {
  fail('mcp-ownership-survives-restart', 'tab a unexpectedly has attention: ' + JSON.stringify(ta.attention));
}
// The user tab must survive too, still un-owned (never wrongly claimed).
const tu = byId.get(userTabId);
if (!tu) fail('mcp-ownership-survives-restart', 'user tab vanished after restart');
if (tu.mcpOwned) fail('mcp-ownership-survives-restart', 'user tab wrongly re-owned after restart');

// The surviving sessionStorage markers must match the re-owned tabs' originals.
if (await readMarker(a.tabId) !== markerA || await readMarker(b.tabId) !== markerB) {
  fail('mcp-ownership-survives-restart', 'sessionStorage markers changed across restart');
}

// --- cleanup ---
for (const t of list.tabs) {
  if (t.mcpOwned) await call('browser_close_tab', { tabId: t.id });
}
const vc = new WebSocket('ws://127.0.0.1:6080/ws');
await new Promise(r => vc.on('open', r));
vc.send(JSON.stringify({ type: 'closeTab', targetId: userTabId }));
await delay(500);
vc.close();

pass('mcp-ownership-survives-restart (ownership + attention rehydrated by sessionStorage UUID; user tab untouched)');
process.exit(0);
