// MCP FIFO eviction: opening more than MCP_MAX_OPEN_TABS via MCP must
// auto-close the oldest MCP-owned tab and report it in `evicted`.
// User-opened tabs (created via the bridge /ws protocol) must NOT be
// touched, even when the MCP FIFO is at capacity.
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

// Test isolation: a previous test may have left MCP-owned tabs that
// run-all's cleanTabs() doesn't fully drain (it keeps the first page).
// Close any pre-existing MCP-owned tabs so the FIFO starts at zero.
const initialList = await call('browser_list_tabs', {});
for (const t of initialList.tabs) {
  if (t.mcpOwned) await call('browser_close_tab', { tabId: t.id });
}
await delay(500);

// Open a USER tab via /ws (not MCP) — it must survive the FIFO churn below.
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

// Open 4 tabs through MCP. With cap=3, the first MCP tab should be
// FIFO-evicted by the 4th open and reported back.
const opened = [];
for (let i = 0; i < 4; i++) {
  const r = await call('browser_open', { url: 'https://example.com/' + i });
  opened.push(r);
}

// Tab #4 must report exactly one eviction — the targetId of opened[0].
const lastEvicted = opened[3].evicted || [];
if (lastEvicted.length !== 1) {
  fail('mcp-fifo-eviction', 'expected 1 eviction on 4th open, got ' + JSON.stringify(lastEvicted));
}
if (lastEvicted[0] !== opened[0].tabId) {
  fail('mcp-fifo-eviction', `expected oldest (${opened[0].tabId}) evicted, got ${lastEvicted[0]}`);
}

// Eviction must be reported via a `notice` field that prompts the agent
// to reconsider its next move (use list_tabs / reuse existing tabs).
// Without this, the agent silently keeps leaking tabs every turn.
if (typeof opened[3].notice !== 'string' || !opened[3].notice.includes('list_tabs')) {
  fail('mcp-fifo-eviction', 'expected notice prompting list_tabs reuse, got: ' + JSON.stringify(opened[3].notice));
}
// Non-evicting opens (had FIFO room) must NOT include a notice — noise
// pollutes the agent's context and trains it to ignore real warnings.
for (let i = 0; i < 3; i++) {
  if (opened[i].notice !== undefined) {
    fail('mcp-fifo-eviction', `open #${i} had no eviction but includes notice: ${opened[i].notice}`);
  }
}

// Tabs #1-3 should NOT have reported any evictions (FIFO had room).
for (let i = 0; i < 3; i++) {
  if ((opened[i].evicted || []).length !== 0) {
    fail('mcp-fifo-eviction', `open #${i} unexpected evictions: ${JSON.stringify(opened[i].evicted)}`);
  }
}

// browser_list_tabs should now show: user tab (mcpOwned=false) + 3
// MCP-owned tabs (the 2nd, 3rd, 4th MCP opens). The 1st MCP tab must
// be gone entirely.
await delay(500);
const list = await call('browser_list_tabs', {});
const tabIdsNow = new Set(list.tabs.map(t => t.id));
if (tabIdsNow.has(opened[0].tabId)) {
  fail('mcp-fifo-eviction', 'evicted tab ' + opened[0].tabId + ' still present');
}
if (!tabIdsNow.has(userTabId)) {
  fail('mcp-fifo-eviction', 'user-opened tab ' + userTabId + ' was wrongly closed');
}
const userEntry = list.tabs.find(t => t.id === userTabId);
if (userEntry.mcpOwned !== false) {
  fail('mcp-fifo-eviction', 'user tab marked mcpOwned: ' + JSON.stringify(userEntry));
}
const mcpCount = list.tabs.filter(t => t.mcpOwned).length;
if (mcpCount !== 3) {
  fail('mcp-fifo-eviction', 'expected 3 MCP-owned tabs after 4 opens, got ' + mcpCount + '; tabs=' + JSON.stringify(list.tabs));
}
if (list.mcpOwnedCap !== 3) {
  fail('mcp-fifo-eviction', 'expected mcpOwnedCap=3, got ' + list.mcpOwnedCap);
}

// Cleanup: close the surviving MCP tabs and the user tab.
for (const tab of list.tabs) {
  if (tab.mcpOwned) await call('browser_close_tab', { tabId: tab.id });
}
v.send(JSON.stringify({ type: 'closeTab', targetId: userTabId }));
await delay(500);
v.close();

pass('mcp-fifo-eviction (cap=3, oldest evicted, user tabs untouched)');
process.exit(0);
