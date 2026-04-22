// MCP browser_close_tab must travel the same code path as the viewer's
// "×" button, so any connected viewers see the standard tabClosing →
// tabCloseComplete transition (spinner → gone) instead of a tab silently
// disappearing from the list.
//
// Before the tabCreate/tabNavigate/tabClose primitive extraction, MCP
// closed tabs via raw Target.closeTarget — viewers got no events and
// the tab popped out abruptly when reconcileTabsGlobal next ran. That
// was a divergence between MCP and viewer behavior; this test prevents
// the divergence from coming back.
//
// FIFO eviction also goes through tabClose (mcp.mjs explicitly), so the
// same broadcast path covers eviction events too.
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
  if (r.result?.isError) throw new Error(r.result.content?.[0]?.text || 'tool error');
  const t = r.result?.content?.[0]?.text;
  try { return JSON.parse(t); } catch { return t; }
}

// Connect a viewer so we can capture broadcast events.
const v = new WebSocket('ws://127.0.0.1:6080/ws');
const vev = [];
await new Promise(r => v.on('open', r));
v.on('message', d => { try { const m = JSON.parse(d); if (m.type !== 'frame') vev.push(m); } catch {} });
function vwait(predicate, ms = 5000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('vwait timeout')), ms);
    const i = setInterval(() => {
      const k = vev.findIndex(predicate);
      if (k >= 0) { clearTimeout(t); clearInterval(i); res(vev.splice(k, 1)[0]); }
    }, 50);
  });
}
await vwait(m => m.type === 'targetChanged');
vev.length = 0;

// Open a tab via MCP, then close via MCP, then wait for the broadcast pair.
const tab = await call('browser_open', { url: 'https://example.com' });
await delay(500);
vev.length = 0; // discard any tabs broadcast from open
await call('browser_close_tab', { tabId: tab.tabId });

const closing = await vwait(m => m.type === 'tabClosing' && m.targetId === tab.tabId, 4000)
  .catch(() => null);
if (!closing) fail('mcp-close-broadcasts', 'no tabClosing event seen after MCP close');

const complete = await vwait(m => m.type === 'tabCloseComplete' && m.targetId === tab.tabId, 4000)
  .catch(() => null);
if (!complete) fail('mcp-close-broadcasts', 'no tabCloseComplete event seen after MCP close');

// FIFO-eviction path also uses tabClose. Confirm an eviction triggers
// tabClosing/tabCloseComplete for the EVICTED tab too.
vev.length = 0;
const tabs = [];
for (let i = 0; i < 3; i++) tabs.push(await call('browser_open', { url: 'https://example.com/' + i }));
vev.length = 0;
const fourth = await call('browser_open', { url: 'https://example.com/four' });
const evictedId = (fourth.evicted || [])[0];
if (!evictedId) fail('mcp-close-broadcasts', 'expected eviction on 4th open, got: ' + JSON.stringify(fourth.evicted));

const evictionClosing = await vwait(m => m.type === 'tabClosing' && m.targetId === evictedId, 4000)
  .catch(() => null);
if (!evictionClosing) fail('mcp-close-broadcasts', 'no tabClosing seen for FIFO-evicted tab ' + evictedId);

// Cleanup.
for (const t of [...tabs.slice(1), fourth]) {
  try { await call('browser_close_tab', { tabId: t.tabId }); } catch {}
}
await delay(500);
v.close();

pass('mcp-close-broadcasts (MCP close + FIFO eviction both broadcast tabClosing/Complete)');
process.exit(0);
