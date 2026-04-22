// MCP can navigate a user-opened tab without consuming an MCP FIFO slot.
// After navigation the tab must remain mcpOwned=false.
import http from 'http';
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
      r.on('end', () => { try { res(JSON.parse(buf)); } catch { rej(new Error(buf.slice(0, 200))); } });
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

// Open user tab via /ws.
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
v.send(JSON.stringify({ type: 'newTab', url: 'https://example.com' }));
const userTab = await vwait('targetChanged');
const userTabId = userTab.targetId;

// Fill MCP FIFO entirely (3 tabs).
const mcp = [];
for (let i = 0; i < 3; i++) {
  mcp.push(await call('browser_open', { url: 'https://example.com/' + i }));
}

// MCP navigates the USER tab. This must:
//  - succeed
//  - return mcpOwned=false (we're operating on someone else's tab)
//  - NOT evict any MCP-owned tab (there's room because we didn't open new)
const navResult = await call('browser_navigate', { tabId: userTabId, url: 'https://example.com/changed' });
if (navResult.tabId !== userTabId) {
  fail('mcp-navigates-user-tab', 'tabId changed: ' + navResult.tabId + ' vs ' + userTabId);
}
if (navResult.mcpOwned !== false) {
  fail('mcp-navigates-user-tab', 'user tab became mcpOwned: ' + JSON.stringify(navResult));
}
// browser_navigate doesn't return `evicted` (only browser_open can evict).
if (navResult.evicted !== undefined) {
  fail('mcp-navigates-user-tab', 'browser_navigate should not include evicted field: ' + JSON.stringify(navResult));
}

// Verify all 3 MCP tabs still alive.
const list = await call('browser_list_tabs', {});
for (const m of mcp) {
  if (!list.tabs.some(t => t.id === m.tabId)) {
    fail('mcp-navigates-user-tab', 'MCP tab disappeared after user-tab navigate: ' + m.tabId);
  }
}
const userEntry = list.tabs.find(t => t.id === userTabId);
if (!userEntry) fail('mcp-navigates-user-tab', 'user tab disappeared');
if (userEntry.mcpOwned) fail('mcp-navigates-user-tab', 'user tab now mcpOwned');
if (!userEntry.url.includes('changed')) {
  fail('mcp-navigates-user-tab', 'navigation did not land: url=' + userEntry.url);
}

// Cleanup.
for (const m of mcp) await call('browser_close_tab', { tabId: m.tabId });
v.send(JSON.stringify({ type: 'closeTab', targetId: userTabId }));
await delay(500);
v.close();

pass('mcp-navigates-user-tab (existing tabs not consumed by FIFO)');
process.exit(0);
