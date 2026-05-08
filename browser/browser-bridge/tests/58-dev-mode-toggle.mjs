// Dev mode toggle: browser_set_dev_mode enables/disables per-tab dev mode.
// Verifies: toggle on returns devMode:true, list_tabs shows devMode flag,
// tools that require dev mode fail without it, toggle off cleans up.
import http from 'http';
import { pass, fail } from './helpers.mjs';

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

async function callRaw(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  return r.result;
}

// Setup: open a tab
const opened = await call('browser_open', { url: 'data:text/html,<h1>dev-mode-test</h1>' });
const tabId = opened.tabId;

// Before dev mode: console_logs should fail
const consoleFail = await callRaw('browser_get_console_logs', { tabId });
if (!consoleFail?.content?.[0]?.text?.includes('not in dev mode')) {
  fail('dev-mode-toggle', 'expected dev mode error, got: ' + JSON.stringify(consoleFail));
}

// Enable dev mode
const on = await call('browser_set_dev_mode', { tabId, enabled: true });
if (on.devMode !== true) fail('dev-mode-toggle', 'expected devMode:true, got: ' + JSON.stringify(on));

// list_tabs should show devMode:true
const tabs = await call('browser_list_tabs', {});
const ourTab = tabs.tabs.find(t => t.id === tabId);
if (!ourTab?.devMode) fail('dev-mode-toggle', 'list_tabs missing devMode flag');

// Console logs should work now (empty)
const logs = await call('browser_get_console_logs', { tabId });
if (!Array.isArray(logs.entries)) fail('dev-mode-toggle', 'expected entries array');

// Disable dev mode
const off = await call('browser_set_dev_mode', { tabId, enabled: false });
if (off.devMode !== false) fail('dev-mode-toggle', 'expected devMode:false');

// Console logs should fail again
const consoleFail2 = await callRaw('browser_get_console_logs', { tabId });
if (!consoleFail2?.content?.[0]?.text?.includes('not in dev mode')) {
  fail('dev-mode-toggle', 'expected dev mode error after disable');
}

// Cleanup
await call('browser_close_tab', { tabId });
pass('dev-mode-toggle');
process.exit(0);
