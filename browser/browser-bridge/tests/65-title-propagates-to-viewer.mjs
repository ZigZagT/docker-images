// Title changes must reach the viewer via tabs broadcast.
// Covers: SPA-style document.title updates (no full navigation).
// /json/list is polled periodically and returns current titles, so
// JS-only title changes propagate through the existing tabs broadcast.
import http from 'http';
import { connectViewer, pass, fail } from './helpers.mjs';

function rpc(method, params, id = Math.floor(Math.random() * 1e9)) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
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

const v = await connectViewer();
await v.waitFor('tabs');
v.clearEvents();

const opened = await call('browser_open', { url: 'data:text/html,<html><head><title>initial</title></head><body>test</body></html>' });
const tabId = opened.tabId;
await v.waitFor('tabs');
v.clearEvents();

const newTitle = 'Test Title ' + Date.now();
await call('browser_evaluate', { tabId, expression: `document.title = ${JSON.stringify(newTitle)}` });

// Title arrives via periodic tabs broadcast (poll interval ~2s)
let titleSeen = false;
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !titleSeen) {
  try {
    const ev = await v.waitFor('tabs', Math.max(500, deadline - Date.now()));
    const tab = ev.tabs?.find(t => t.id === tabId && t.title === newTitle);
    if (tab) titleSeen = true;
  } catch { break; }
}

await call('browser_close_tab', { tabId });
v.close();

if (!titleSeen) {
  fail('title-propagates-to-viewer', 'viewer did not receive new title within 5s after document.title change');
}
pass('title-propagates-to-viewer');
process.exit(0);
