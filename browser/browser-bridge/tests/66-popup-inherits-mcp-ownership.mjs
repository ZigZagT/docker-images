// When an MCP-owned tab opens a popup (window.open), the child tab
// inherits MCP ownership so it counts against the FIFO cap. Without
// this, popups would escape the cap and never be auto-evicted.
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

// Open a parent MCP tab
const parent = await call('browser_open', { url: 'data:text/html,<html><body>parent</body></html>' });
const parentId = parent.tabId;

// Use evaluate to open a popup via window.open
await call('browser_evaluate', {
  tabId: parentId,
  expression: `void window.open('data:text/html,<html><body>child</body></html>', '_blank')`,
});
await delay(1000);

// List tabs — the child should be mcpOwned
const tabs = await call('browser_list_tabs', {});
const childTab = tabs.tabs.find(t => t.id !== parentId && t.mcpOwned && t.id !== initial.tabs[0]?.id);

if (!childTab) {
  // Clean up
  await call('browser_close_tab', { tabId: parentId });
  fail('popup-inherits-mcp-ownership', 'popup tab did not inherit mcpOwned from parent');
}

// Clean up both tabs
await call('browser_close_tab', { tabId: childTab.id }).catch(() => {});
await call('browser_close_tab', { tabId: parentId }).catch(() => {});

pass('popup-inherits-mcp-ownership');
process.exit(0);
