// Dev mode console log capture.
// Verifies: console.log/warn/error captured, exceptions captured,
// since filter works, clear works.
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
  if (!t) return null;
  try { return JSON.parse(t); } catch { return t; }
}

// Setup
const opened = await call('browser_open', { url: 'about:blank' });
const tabId = opened.tabId;
await call('browser_set_dev_mode', { tabId, enabled: true });

// Trigger console output
await call('browser_evaluate', { tabId, expression: 'console.log("hello from test")' });
await call('browser_evaluate', { tabId, expression: 'console.warn("warn msg")' });
await call('browser_evaluate', { tabId, expression: 'console.error("err msg")' });
await delay(200);

// Read logs
const logs = await call('browser_get_console_logs', { tabId });
if (logs.entries.length < 3) fail('dev-mode-console', 'expected 3+ entries, got ' + logs.entries.length);
const hasLog = logs.entries.some(e => e.text.includes('hello from test') && e.level === 'log');
const hasWarn = logs.entries.some(e => e.text.includes('warn msg') && e.level === 'warning');
const hasErr = logs.entries.some(e => e.text.includes('err msg') && e.level === 'error');
if (!hasLog) fail('dev-mode-console', 'missing console.log entry');
if (!hasWarn) fail('dev-mode-console', 'missing console.warn entry');
if (!hasErr) fail('dev-mode-console', 'missing console.error entry');

// Test since filter
const midTs = logs.entries[1].ts;
const filtered = await call('browser_get_console_logs', { tabId, since: midTs });
if (filtered.returned >= logs.returned) fail('dev-mode-console', 'since filter did not reduce entries');

// Test exception capture
await call('browser_evaluate', { tabId, expression: 'setTimeout(() => { throw new Error("uncaught") }, 0)' });
await delay(300);
const logsAfter = await call('browser_get_console_logs', { tabId });
const hasException = logsAfter.entries.some(e => e.type === 'exception' && e.text.includes('uncaught'));
if (!hasException) fail('dev-mode-console', 'missing exception entry');

// Test clear
const cleared = await call('browser_get_console_logs', { tabId, clear: true });
if (cleared.entries.length === 0) fail('dev-mode-console', 'clear returned empty before read');
const afterClear = await call('browser_get_console_logs', { tabId });
if (afterClear.entries.length !== 0) fail('dev-mode-console', 'buffer not cleared');

// Cleanup
await call('browser_close_tab', { tabId });
pass('dev-mode-console');
process.exit(0);
