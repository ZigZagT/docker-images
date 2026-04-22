// MCP attention API: request → appears in tabs broadcast + list_tabs;
// update doesn't bump count; clear → removed; cap enforced; tab close
// drops attention.
//
// Why we use USER-opened tabs throughout: MCP-opened tabs are subject to
// the FIFO and could be evicted in the middle of an attention test,
// silently dropping the attention entry and confusing the assertions.
// User tabs are immune to the FIFO so the attention state stays
// deterministic.
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

// Open 4 USER tabs via /ws.
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
async function awaitTabsWith(predicate, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const k = vev.findIndex(m => m.type === 'tabs' && predicate(m));
    if (k >= 0) return vev.splice(k, 1)[0];
    await delay(50);
  }
  throw new Error('awaitTabsWith timeout');
}
await vwait('targetChanged');

// Test isolation: a previous failed run may have left attention entries.
// Clear every existing attention before starting so the cap math is
// deterministic regardless of prior state.
const initialList = await call('browser_list_tabs', {});
for (const t of initialList.tabs) {
  if (t.attention) await call('browser_dismiss_attention', { tabId: t.id });
}

const userTabs = [];
for (let i = 0; i < 4; i++) {
  vev.length = 0;
  v.send(JSON.stringify({ type: 'newTab', url: 'https://example.com/' + i }));
  const tc = await vwait('targetChanged');
  userTabs.push(tc.targetId);
}
vev.length = 0;

// Attention #1 — request, then verify it propagates everywhere.
const attn1 = await call('browser_set_attention', {
  tabId: userTabs[0],
  message: 'Please solve the captcha to continue.',
});
if (attn1.attentionCount !== 1) fail('mcp-attention', 'count after first request: ' + attn1.attentionCount);
if (attn1.message !== 'Please solve the captcha to continue.') {
  fail('mcp-attention', 'message round-trip wrong: ' + JSON.stringify(attn1));
}

// list_tabs reflects it.
const list1 = await call('browser_list_tabs', {});
const t0 = list1.tabs.find(t => t.id === userTabs[0]);
if (!t0?.attention) fail('mcp-attention', 'list_tabs missing attention: ' + JSON.stringify(t0));
if (t0.attention.message !== 'Please solve the captcha to continue.') {
  fail('mcp-attention', 'list_tabs wrong message: ' + JSON.stringify(t0));
}
if (t0.mcpOwned !== false) fail('mcp-attention', 'user tab marked mcpOwned: ' + JSON.stringify(t0));

// Viewer tabs broadcast also reflects it.
const tabsEvent = await awaitTabsWith(m => m.tabs.some(t => t.id === userTabs[0] && t.attention));
const vTab = tabsEvent.tabs.find(t => t.id === userTabs[0]);
if (!vTab.attention || vTab.attention.message !== 'Please solve the captcha to continue.') {
  fail('mcp-attention', 'viewer tabs broadcast wrong: ' + JSON.stringify(vTab));
}

// Long multi-paragraph messages must round-trip intact. The previous
// 200-char silent truncation cap was removed because attention messages
// are intended to carry full instructions, not single sentences.
const longMessage = (
  'Please complete the following steps before I continue:\n\n' +
  '1. Solve the captcha at the top of the page.\n' +
  '2. Dismiss any cookie banner.\n' +
  '3. Confirm the page title contains the search term we used.\n' +
  '4. If a paywall appears, close it via the X in the top-right.\n\n' +
  'Background: this site has been flagged for aggressive bot mitigation. ' +
  'Even after captcha there may be a secondary challenge — keep an eye out ' +
  'for any modal that asks for an email or phone number; just close it.\n\n' +
  'When everything looks normal, switch to a different tab and back, ' +
  'and I will resume scraping.'
);
const longResult = await call('browser_set_attention', {
  tabId: userTabs[0],
  message: longMessage,
});
if (longResult.message !== longMessage) {
  fail('mcp-attention', 'long message was modified in round-trip; len_in=' + longMessage.length + ' len_out=' + longResult.message.length);
}
const listLong = await call('browser_list_tabs', {});
const longBack = listLong.tabs.find(t => t.id === userTabs[0])?.attention?.message;
if (longBack !== longMessage) {
  fail('mcp-attention', 'long message lost via list_tabs; got: ' + longBack?.slice(-40));
}

// Updating an EXISTING attention request must not bump the cap counter.
const attnUpdate = await call('browser_set_attention', {
  tabId: userTabs[0],
  message: 'Updated message',
});
if (attnUpdate.attentionCount !== 1) {
  fail('mcp-attention', 'updating existing attention should not increment count, got ' + attnUpdate.attentionCount);
}

// Attention #2 and #3 fill the cap.
await call('browser_set_attention', { tabId: userTabs[1], message: 'check #2' });
const attn3 = await call('browser_set_attention', { tabId: userTabs[2], message: 'check #3' });
if (attn3.attentionCount !== 3 || attn3.attentionCap !== 3) {
  fail('mcp-attention', 'cap state wrong: ' + JSON.stringify(attn3));
}

// 4th request must fail.
let capError = null;
try {
  await call('browser_set_attention', { tabId: userTabs[3], message: 'over cap' });
} catch (e) { capError = e.message; }
if (!capError || !capError.toLowerCase().includes('cap')) {
  fail('mcp-attention', 'expected cap error, got: ' + capError);
}

// Clear one, then the previously-rejected request must succeed.
const cleared = await call('browser_dismiss_attention', { tabId: userTabs[0] });
if (!cleared.cleared || cleared.attentionCount !== 2) {
  fail('mcp-attention', 'clear result wrong: ' + JSON.stringify(cleared));
}
const attn4 = await call('browser_set_attention', { tabId: userTabs[3], message: 'now ok' });
if (attn4.attentionCount !== 3) fail('mcp-attention', 'count after refill: ' + attn4.attentionCount);

// Idempotent clear (no attention to clear) returns cleared=false.
const noopClear = await call('browser_dismiss_attention', { tabId: userTabs[0] });
if (noopClear.cleared !== false) fail('mcp-attention', 'idempotent clear should report cleared=false');

// Closing an attention-marked tab must drop its attention server-side.
v.send(JSON.stringify({ type: 'closeTab', targetId: userTabs[1] }));
await delay(800);
const listAfter = await call('browser_list_tabs', {});
if (listAfter.tabs.some(t => t.id === userTabs[1])) {
  fail('mcp-attention', 'userTabs[1] still present after close');
}
if (listAfter.attentionCount !== 2) {
  fail('mcp-attention', 'attentionCount should drop to 2 on tab close, got ' + listAfter.attentionCount);
}

// Cleanup remaining tabs.
for (const id of [userTabs[0], userTabs[2], userTabs[3]]) {
  v.send(JSON.stringify({ type: 'closeTab', targetId: id }));
}
await delay(800);
v.close();

pass('mcp-attention (request, update, cap, clear, idempotent, close-cleanup)');
process.exit(0);
