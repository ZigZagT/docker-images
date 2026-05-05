// Dev mode popup log capture.
// Verifies: window.open attempts are logged with url/target/features/blocked.
import http from 'http';
import { delay, pass, fail } from './helpers.mjs';

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
  return t ? JSON.parse(t) : null;
}

// Setup
const opened = await call('browser_open', { url: 'about:blank' });
const tabId = opened.tabId;
await call('browser_set_dev_mode', { tabId, enabled: true });

// Trigger a window.open call (will likely be blocked without user gesture)
await call('browser_evaluate', {
  tabId,
  expression: 'window.open("https://example.com", "_blank", "width=400,height=300")',
});
await delay(300);

// Check popup log
const log = await call('browser_get_popup_log', { tabId });
if (!Array.isArray(log.entries)) fail('dev-mode-popup', 'missing entries array');
if (log.entries.length === 0) fail('dev-mode-popup', 'no popup attempts logged');

const entry = log.entries[0];
if (!entry.url.includes('example.com')) fail('dev-mode-popup', 'wrong url: ' + entry.url);
if (entry.target !== '_blank') fail('dev-mode-popup', 'wrong target: ' + entry.target);
if (!entry.features.includes('width=400')) fail('dev-mode-popup', 'wrong features: ' + entry.features);
if (typeof entry.blocked !== 'boolean') fail('dev-mode-popup', 'blocked not boolean');
if (typeof entry.ts !== 'number') fail('dev-mode-popup', 'missing ts');

// Test clear
const cleared = await call('browser_get_popup_log', { tabId, clear: true });
if (cleared.entries.length === 0) fail('dev-mode-popup', 'clear returned empty');
const afterClear = await call('browser_get_popup_log', { tabId });
if (afterClear.entries.length !== 0) fail('dev-mode-popup', 'not cleared');

// Cleanup
await call('browser_close_tab', { tabId });
pass('dev-mode-popup');
process.exit(0);
