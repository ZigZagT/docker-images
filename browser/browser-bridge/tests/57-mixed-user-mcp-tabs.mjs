// Mixed user-opened + MCP-opened tabs: comprehensive combination test.
//
// Setup (intentionally interleaved):
//   1. Open 1 USER tab     (U1)
//   2. Open 3 MCP tabs     (M1, M2, M3)  — fills FIFO cap
//   3. Open 1 USER tab     (U2)
//   → 5 tabs total. mcpOwnedCount=3, U1/U2 are mcpOwned:false.
//
// Coverage matrix walked step by step:
//   A. attention on U1 (user)           → counts 1/3
//   B. attention on M1 (oldest MCP)     → counts 2/3
//   C. attention on M3 (newest MCP)     → counts 3/3 — at cap
//   D. attention on M2 (4th)            → throws cap error
//   E. dismiss attention on M3          → counts 2/3
//   F. browser_open new tab             → throws (M1 oldest MCP has attention)
//   G. dismiss attention on M1          → counts 1/3 (only U1 left)
//   H. browser_open new tab             → succeeds. M1 FIFO-evicted (no longer protected).
//                                          U1 attention SURVIVES (FIFO ignores user tabs).
//   I. browser_close_tab on M2          → mcpOwnedCount drops to 2
//   J. close user tab U1 via /ws        → attentionCount drops (U1 had attention)
//
// Why this exists: attention counts and FIFO are two independent caps
// that interact subtly when user-owned and MCP-owned tabs coexist. A
// regression in either layer would either over-count or under-protect.

import http from 'http';
import { WebSocket } from 'ws';
import { delay, pass, fail } from './helpers.mjs';

function rpc(method, params) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params });
    const req = http.request('http://127.0.0.1:6080/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    }, r => { let buf = ''; r.on('data', c => buf += c); r.on('end', () => { try { res(JSON.parse(buf)); } catch { rej(new Error(buf.slice(0, 200))); } }); });
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

// Cleanup leftover state.
const initial = await call('browser_list_tabs', {});
for (const t of initial.tabs) {
  if (t.attention) await call('browser_dismiss_attention', { tabId: t.id });
  if (t.mcpOwned) await call('browser_close_tab', { tabId: t.id });
}
await delay(300);

// Connect a viewer-style WS to open USER tabs (the only way to create
// non-MCP-owned tabs, since browser_open always marks them MCP-owned).
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

async function userOpen(url) {
  vev.length = 0;
  v.send(JSON.stringify({ type: 'newTab', url }));
  const tc = await vwait('targetChanged');
  return tc.targetId;
}

// Setup — open in the requested order: U1, M1, M2, M3, U2.
const U1 = await userOpen('https://example.com/u1');
const M1 = (await call('browser_open', { url: 'https://example.com/m1' })).tabId;
const M2 = (await call('browser_open', { url: 'https://example.com/m2' })).tabId;
const M3 = (await call('browser_open', { url: 'https://example.com/m3' })).tabId;
const U2 = await userOpen('https://example.com/u2');

const setup = await call('browser_list_tabs', {});
if (setup.mcpOwnedCount !== 3) {
  fail('mixed-user-mcp-tabs', `setup mcpOwnedCount=${setup.mcpOwnedCount}, expected 3`);
}
for (const u of [U1, U2]) {
  const t = setup.tabs.find(t => t.id === u);
  if (!t) fail('mixed-user-mcp-tabs', 'user tab missing: ' + u);
  if (t.mcpOwned !== false) fail('mixed-user-mcp-tabs', 'user tab marked mcpOwned: ' + u);
}

// (A) attention on U1 — counts toward the cap even though U1 isn't MCP-owned.
const A = await call('browser_set_attention', { tabId: U1, message: 'attention on user tab U1' });
if (A.attentionCount !== 1) fail('mixed-user-mcp-tabs', '(A) attentionCount=' + A.attentionCount + ', expected 1');

// (B) attention on M1 (oldest MCP).
const B = await call('browser_set_attention', { tabId: M1, message: 'attention on oldest MCP tab M1' });
if (B.attentionCount !== 2) fail('mixed-user-mcp-tabs', '(B) attentionCount=' + B.attentionCount + ', expected 2');

// (C) attention on M3 (newest MCP) — fills the cap.
const C = await call('browser_set_attention', { tabId: M3, message: 'attention on newest MCP tab M3' });
if (C.attentionCount !== 3) fail('mixed-user-mcp-tabs', '(C) attentionCount=' + C.attentionCount + ', expected 3');

// (D) Try a 4th attention — must throw cap error.
let dErr = null;
try { await call('browser_set_attention', { tabId: M2, message: 'over the cap' }); }
catch (e) { dErr = e.message; }
if (!dErr || !dErr.toLowerCase().includes('cap')) {
  fail('mixed-user-mcp-tabs', '(D) expected cap error, got: ' + dErr);
}

// (E) Dismiss M3's attention. Counter drops to 2; cap freed for one new request.
const E = await call('browser_dismiss_attention', { tabId: M3 });
if (!E.cleared || E.attentionCount !== 2) {
  fail('mixed-user-mcp-tabs', '(E) dismiss returned ' + JSON.stringify(E));
}

// (F) Try browser_open. FIFO would evict M1 (oldest MCP) — but M1 has
// attention, so the open must throw with a protection error.
let fErr = null;
try { await call('browser_open', { url: 'https://example.com/blocked' }); }
catch (e) { fErr = e.message; }
if (!fErr || !fErr.includes(M1)) {
  fail('mixed-user-mcp-tabs', '(F) expected protection error naming M1, got: ' + fErr);
}

// (G) Dismiss M1's attention. Counter drops to 1 (only U1 still attended).
const G = await call('browser_dismiss_attention', { tabId: M1 });
if (G.attentionCount !== 1) fail('mixed-user-mcp-tabs', '(G) attentionCount=' + G.attentionCount + ', expected 1');

// (H) Now browser_open succeeds. M1 (oldest MCP) is FIFO-evicted.
// U1 is older in absolute terms, but FIFO ignores user tabs — they
// must NOT be evicted. U1's attention must SURVIVE.
const H = await call('browser_open', { url: 'https://example.com/m4' });
const M4 = H.tabId;
if ((H.evicted || []).length !== 1 || H.evicted[0] !== M1) {
  fail('mixed-user-mcp-tabs', '(H) expected eviction of ' + M1 + ', got: ' + JSON.stringify(H.evicted));
}
const afterH = await call('browser_list_tabs', {});
if (!afterH.tabs.some(t => t.id === U1)) fail('mixed-user-mcp-tabs', '(H) U1 was wrongly evicted');
if (!afterH.tabs.some(t => t.id === U2)) fail('mixed-user-mcp-tabs', '(H) U2 was wrongly evicted');
if (afterH.attentionCount !== 1) fail('mixed-user-mcp-tabs', '(H) U1 attention lost; count=' + afterH.attentionCount);
const u1AttnSurvived = afterH.tabs.find(t => t.id === U1)?.attention?.message;
if (!u1AttnSurvived?.includes('user tab U1')) {
  fail('mixed-user-mcp-tabs', '(H) U1 attention message lost: ' + u1AttnSurvived);
}

// (I) Close M2 via browser_close_tab. mcpOwnedCount drops to 2 (M3, M4).
await call('browser_close_tab', { tabId: M2 });
await delay(300);
const afterI = await call('browser_list_tabs', {});
if (afterI.mcpOwnedCount !== 2) fail('mixed-user-mcp-tabs', '(I) mcpOwnedCount=' + afterI.mcpOwnedCount + ', expected 2');

// (J) Close U1 via /ws (user-driven close). attentionCount drops because
// U1 had attention; closing any tab purges its attention.
v.send(JSON.stringify({ type: 'closeTab', targetId: U1 }));
await delay(800);
const afterJ = await call('browser_list_tabs', {});
if (afterJ.tabs.some(t => t.id === U1)) fail('mixed-user-mcp-tabs', '(J) U1 still present after close');
if (afterJ.attentionCount !== 0) fail('mixed-user-mcp-tabs', '(J) attentionCount should be 0 after closing U1; got ' + afterJ.attentionCount);

// Cleanup remaining tabs.
for (const id of [M3, M4]) { try { await call('browser_close_tab', { tabId: id }); } catch {} }
v.send(JSON.stringify({ type: 'closeTab', targetId: U2 }));
await delay(500);
v.close();

pass('mixed-user-mcp-tabs (U1, M1, M2, M3, U2; A→J combinations all assert correctly)');
process.exit(0);
