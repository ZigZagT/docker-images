// Ctrl+click on a link in an MCP-owned tab opens the link in a new tab.
// Chrome does NOT set openerId for Ctrl+click (unlike window.open), so
// the browser_click tool must proactively inherit MCP ownership on the
// child tab.  Without this, Ctrl+click children escape the FIFO cap.
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

// Open an MCP tab with a clickable link
const parent = await call('browser_open', {
  url: 'data:text/html,<html><body><a href="https://example.com">target link</a></body></html>',
});
const parentId = parent.tabId;

// Snapshot to get the link's UID
const snap = await call('browser_get_snapshot', { tabId: parentId });
const linkLine = snap.split('\n').find(l => l.includes('link'));
const uidMatch = linkLine?.match(/\[uid=(\d+)\]/);
if (!uidMatch) {
  await call('browser_close_tab', { tabId: parentId });
  fail('ctrlclick-inherits-mcp-ownership', 'could not find link UID in snapshot: ' + snap);
}

// Ctrl+click the link — should open https://example.com in a new tab
await call('browser_click', {
  tabId: parentId,
  uid: uidMatch[1],
  modifiers: ['ctrl'],
});
await delay(500);

// The child tab should be mcpOwned
const tabs = await call('browser_list_tabs', {});
const childTab = tabs.tabs.find(t => t.id !== parentId && t.mcpOwned
  && t.url && t.url.includes('example.com'));

if (!childTab) {
  await call('browser_close_tab', { tabId: parentId });
  fail('ctrlclick-inherits-mcp-ownership',
    'Ctrl+click child tab did not inherit mcpOwned; tabs: '
    + JSON.stringify(tabs.tabs.map(t => ({ id: t.id, url: t.url, mcpOwned: t.mcpOwned }))));
}

// Clean up
await call('browser_close_tab', { tabId: childTab.id }).catch(() => {});
await call('browser_close_tab', { tabId: parentId }).catch(() => {});

pass('ctrlclick-inherits-mcp-ownership');
process.exit(0);
