// Dev mode dialog handling.
// Verifies: manual mode captures pending dialog, handle_dialog resolves it,
// auto-accept mode auto-resolves, auto-dismiss mode auto-resolves.
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

// 1. Manual mode: trigger alert, check pending, handle it
// Use setTimeout so the evaluate doesn't block waiting for dialog
await call('browser_evaluate', { tabId, expression: 'setTimeout(() => alert("test alert"), 50)' });
await delay(300);

const pending = await call('browser_get_pending_dialog', { tabId });
if (!pending.pendingDialog) fail('dev-mode-dialog', 'no pending dialog after alert');
if (pending.pendingDialog.type !== 'alert') fail('dev-mode-dialog', 'wrong dialog type: ' + pending.pendingDialog.type);
if (!pending.pendingDialog.message.includes('test alert')) fail('dev-mode-dialog', 'wrong message');

// Handle it
const handled = await call('browser_handle_dialog', { tabId, accept: true });
if (handled.handled !== 'alert') fail('dev-mode-dialog', 'handle_dialog wrong type');

// No pending after handling
const noPending = await call('browser_get_pending_dialog', { tabId });
if (noPending.pendingDialog !== null) fail('dev-mode-dialog', 'dialog still pending after handle');

// 2. Auto-accept mode: confirm returns true
await call('browser_set_dialog_handler', { tabId, mode: 'auto-accept' });
const confirmResult = await call('browser_evaluate', { tabId, expression: 'confirm("accept this?")' });
// In auto-accept mode, confirm() should return true (the string "true")
// The evaluate tool returns it as a string
if (confirmResult !== undefined && String(confirmResult) !== 'true') {
  // When auto-accept fires fast enough, the confirm resolves immediately
  // If it returned something else, that's a failure
  fail('dev-mode-dialog', 'auto-accept confirm did not return true');
}

// 3. Auto-dismiss mode: confirm returns false
await call('browser_set_dialog_handler', { tabId, mode: 'auto-dismiss' });
const dismissResult = await call('browser_evaluate', { tabId, expression: 'confirm("dismiss this?")' });
if (dismissResult !== undefined && String(dismissResult) !== 'false') {
  fail('dev-mode-dialog', 'auto-dismiss confirm did not return false');
}

// Cleanup
await call('browser_close_tab', { tabId });
pass('dev-mode-dialog');
process.exit(0);
