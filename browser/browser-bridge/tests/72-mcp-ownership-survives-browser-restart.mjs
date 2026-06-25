// MCP ownership must survive a *browser* (Chrome) restart — the case the whole
// design targets. Unlike a bridge restart, a Chrome relaunch mints brand-new
// targetIds for every tab, so the old in-memory keys are useless. Recovery
// hinges on two things this test proves end-to-end:
//   1. Chrome session-restore preserves the sessionStorage marker across the
//      relaunch (the load-bearing assumption — verified here, not assumed).
//   2. reconnectToBrowser → rehydrateOwnership re-matches persisted records to
//      the restored tabs by that marker and rebuilds ownership against the NEW
//      targetIds (not the dead ones).
//
// Production leaves session-restore to the user's chrome://settings ("continue
// where you left off"); here we force it deterministically by injecting Chrome's
// --restore-last-session switch into the launcher's saved-args file before
// triggering a Chrome-only restart. The bridge process stays alive throughout,
// so its WS-close → reconnect path runs for real.
import http from 'http';
import fs from 'fs';
import { execFile } from 'child_process';
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

function readMarker(tabId) {
  return call('browser_evaluate', { tabId, expression: `JSON.stringify(sessionStorage.getItem('__bb_mcp'))` });
}

// --- setup: clean FIFO ---
const initialList = await call('browser_list_tabs', {});
for (const t of initialList.tabs) {
  if (t.mcpOwned) await call('browser_close_tab', { tabId: t.id });
}
await delay(500);

// Two MCP-owned tabs with attention on the second.
const a = await call('browser_open', { url: 'https://example.com/a' });
const b = await call('browser_open', { url: 'https://example.com/b' });
const ATT = 'verify the page on tab b';
await call('browser_set_attention', { tabId: b.tabId, message: ATT });

const markerA = await readMarker(a.tabId);
const markerB = await readMarker(b.tabId);
if (typeof markerA !== 'string' || typeof markerB !== 'string' || markerA === markerB) {
  fail('mcp-ownership-survives-browser-restart', `bad markers: a=${JSON.stringify(markerA)} b=${JSON.stringify(markerB)}`);
}

// Flush the debounced persist, then force Chrome to restore on next launch.
await delay(1500);
// save_args() stores launch args NUL-delimited (printf '%s\0'); load_args reads
// with `read -d ''`, so the delimiter MUST be an actual NUL byte — a space
// silently drops the arg.
fs.writeFileSync('/tmp/chrome.args', '--restore-last-session\0');

// Restart Chrome only. Bridge stays up, sees its CDP socket close, and
// reconnects to the relaunched (session-restored) browser.
await new Promise((res, rej) => execFile('/usr/local/bin/chrome', ['restart-browser'], err => err ? rej(err) : res()));

// Poll until the restored, re-owned tab a shows up with a DIFFERENT targetId.
let restoredA = null;
for (let i = 0; i < 50; i++) {
  await delay(1000);
  let list;
  try { list = await call('browser_list_tabs', {}); } catch { continue; }
  const t = list.tabs.find(x => x.url && x.url.includes('example.com/a'));
  if (t && t.mcpOwned) { restoredA = t; break; }
}
if (!restoredA) {
  const dump = await call('browser_list_tabs', {}).catch(() => ({}));
  fail('mcp-ownership-survives-browser-restart', 'tab a not restored+re-owned after browser restart; tabs=' + JSON.stringify(dump.tabs));
}

// A real browser restart means a fresh targetId — prove we remapped, not just
// kept the old id.
if (restoredA.id === a.tabId) {
  fail('mcp-ownership-survives-browser-restart', 'targetId unchanged (' + a.tabId + ') — Chrome did not actually restart');
}

// The sessionStorage marker must have survived session-restore and still equal
// the original — this is the assumption the whole approach depends on.
const markerAfter = await readMarker(restoredA.id);
if (markerAfter !== markerA) {
  fail('mcp-ownership-survives-browser-restart',
    `sessionStorage marker did not survive restore: before=${JSON.stringify(markerA)} after=${JSON.stringify(markerAfter)}`);
}

// Tab b must be restored, re-owned, and keep its attention.
const list = await call('browser_list_tabs', {});
const restoredB = list.tabs.find(x => x.url && x.url.includes('example.com/b'));
if (!restoredB || !restoredB.mcpOwned) {
  fail('mcp-ownership-survives-browser-restart', 'tab b not restored+re-owned: ' + JSON.stringify(restoredB));
}
if (!restoredB.attention || restoredB.attention.message !== ATT) {
  fail('mcp-ownership-survives-browser-restart', 'attention lost on tab b across browser restart: ' + JSON.stringify(restoredB.attention));
}
if (list.mcpOwnedCount !== 2) {
  fail('mcp-ownership-survives-browser-restart', 'expected mcpOwnedCount=2 after restart, got ' + list.mcpOwnedCount);
}

// --- cleanup ---
fs.writeFileSync('/tmp/chrome.args', '');
for (const t of list.tabs) {
  if (t.mcpOwned) await call('browser_close_tab', { tabId: t.id });
}
await delay(500);

pass('mcp-ownership-survives-browser-restart (new targetIds remapped by sessionStorage UUID; marker + attention survived Chrome session-restore)');
process.exit(0);
