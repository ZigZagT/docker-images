// When MCP ownership is inherited (via window.open or Ctrl+click) and the
// FIFO cap is already full, the oldest MCP-owned tab must be evicted.
// Without this, inherited children bypass the cap indefinitely.
import http from 'http';
import { delay, pass, fail } from './helpers.mjs';

function rpc(method, params) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params });
    const req = http.request('http://127.0.0.1:6080/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
    }, r => { let buf = ''; r.on('data', c => buf += c); r.on('end', () => { try { res(JSON.parse(buf)); } catch { rej(new Error(buf)); } }); });
    req.on('error', rej); req.write(body); req.end();
  });
}

async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = r.result?.content?.[0]?.text;
  if (r.result?.isError) throw new Error(t);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return t; }
}

// Clean pre-existing MCP tabs
const initial = await call('browser_list_tabs', {});
for (const t of initial.tabs) {
  if (t.mcpOwned) await call('browser_close_tab', { tabId: t.id });
}
await delay(300);

// Fill FIFO to cap (3 tabs)
const tab1 = await call('browser_open', { url: 'https://example.com' });
const tab2 = await call('browser_open', { url: 'data:text/html,<html><body>tab2</body></html>' });
const tab3 = await call('browser_open', {
  url: 'data:text/html,<html><body><a href="https://example.com" id="link">click me</a></body></html>',
});

let tabs = await call('browser_list_tabs', {});
const mcpCount = tabs.tabs.filter(t => t.mcpOwned).length;
if (mcpCount !== 3) {
  fail('inherit-respects-fifo-cap', `expected 3 MCP tabs before Ctrl+click, got ${mcpCount}`);
}

// Ctrl+click the link in tab3 to spawn a child
const snap = await call('browser_get_snapshot', { tabId: tab3.tabId });
const linkLine = snap.split('\n').find(l => l.includes('click me'));
const uidMatch = linkLine?.match(/\[uid=(\d+)\]/);
if (!uidMatch) {
  fail('inherit-respects-fifo-cap', 'could not find link UID in snapshot: ' + snap);
}

await call('browser_click', {
  tabId: tab3.tabId,
  uid: uidMatch[1],
  modifiers: ['ctrl'],
});
await delay(1000);

// After inheritance + eviction, MCP count should still be <= cap
tabs = await call('browser_list_tabs', {});
const mcpAfter = tabs.tabs.filter(t => t.mcpOwned);
if (mcpAfter.length > 3) {
  // Clean up
  for (const t of mcpAfter) await call('browser_close_tab', { tabId: t.id }).catch(() => {});
  fail('inherit-respects-fifo-cap',
    `FIFO cap exceeded: ${mcpAfter.length} MCP tabs after Ctrl+click inheritance; ` +
    `tabs: ${JSON.stringify(mcpAfter.map(t => ({ id: t.id, url: t.url })))}`);
}

// tab1 (oldest) should have been evicted
const tab1Still = tabs.tabs.find(t => t.id === tab1.tabId);
if (tab1Still) {
  for (const t of mcpAfter) await call('browser_close_tab', { tabId: t.id }).catch(() => {});
  fail('inherit-respects-fifo-cap', 'oldest MCP tab was not evicted');
}

// Child tab should exist and be MCP-owned
const child = mcpAfter.find(t => t.id !== tab2.tabId && t.id !== tab3.tabId && t.url?.includes('example.com'));
if (!child) {
  for (const t of mcpAfter) await call('browser_close_tab', { tabId: t.id }).catch(() => {});
  fail('inherit-respects-fifo-cap', 'child tab not found or not MCP-owned');
}

// Clean up
for (const t of mcpAfter) await call('browser_close_tab', { tabId: t.id }).catch(() => {});

pass('inherit-respects-fifo-cap');
process.exit(0);
