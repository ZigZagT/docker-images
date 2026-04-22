// browser_open must REFUSE to FIFO-evict a tab that has a pending
// attention request. Attention represents an in-flight human-in-the-loop
// commitment; silently destroying it would lose context the user is
// actively about to act on.
//
// Behavior under test:
//   1. Fill the MCP FIFO (3 tabs).
//   2. Set attention on the OLDEST MCP tab (the eviction candidate).
//   3. Attempt browser_open of a new URL.
//      → Must throw an error mentioning the protected tab.
//      → No tabs may be closed as a side effect.
//   4. Dismiss the attention.
//   5. browser_open succeeds and evicts that same tab.
import http from 'http';
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
  if (r.result?.isError) throw new Error(r.result.content?.[0]?.text || 'tool error');
  const t = r.result?.content?.[0]?.text;
  try { return JSON.parse(t); } catch { return t; }
}

// Cleanup leftover state from prior tests.
const initial = await call('browser_list_tabs', {});
for (const t of initial.tabs) {
  if (t.attention) await call('browser_dismiss_attention', { tabId: t.id });
  if (t.mcpOwned) await call('browser_close_tab', { tabId: t.id });
}
await delay(500);

// Fill the FIFO.
const tabs = [];
for (let i = 0; i < 3; i++) tabs.push(await call('browser_open', { url: 'https://example.com/' + i }));
const oldest = tabs[0].tabId;

// Mark the oldest with attention — that's the would-be eviction victim.
await call('browser_set_attention', { tabId: oldest, message: 'protect me' });

// Now try to open a 4th. Should error and NOT close any tab.
let evictionError = null;
try {
  await call('browser_open', { url: 'https://example.com/four' });
} catch (err) {
  evictionError = err.message;
}
if (!evictionError) {
  fail('mcp-attention-protects-from-eviction', 'expected error refusing to evict attention tab; got success');
}
if (!evictionError.includes(oldest)) {
  fail('mcp-attention-protects-from-eviction', 'error must name the protected tabId; got: ' + evictionError);
}
if (!evictionError.toLowerCase().includes('attention')) {
  fail('mcp-attention-protects-from-eviction', 'error must mention attention; got: ' + evictionError);
}

// Confirm no tabs were destroyed by the failed attempt.
const afterRefusal = await call('browser_list_tabs', {});
for (const t of tabs) {
  if (!afterRefusal.tabs.some(x => x.id === t.tabId)) {
    fail('mcp-attention-protects-from-eviction', 'tab ' + t.tabId + ' was closed despite refusal');
  }
}

// Dismiss attention. Now the same browser_open should succeed and
// evict the (no-longer-protected) oldest tab.
await call('browser_dismiss_attention', { tabId: oldest });
const fourth = await call('browser_open', { url: 'https://example.com/four' });
if (!(fourth.evicted || []).includes(oldest)) {
  fail('mcp-attention-protects-from-eviction', 'after dismiss, expected eviction of ' + oldest + '; got: ' + JSON.stringify(fourth.evicted));
}

// Cleanup.
for (const t of [tabs[1], tabs[2], fourth]) {
  try { await call('browser_close_tab', { tabId: t.tabId }); } catch {}
}
await delay(300);

pass('mcp-attention-protects-from-eviction (open refuses while attention pending; succeeds after dismiss)');
process.exit(0);
