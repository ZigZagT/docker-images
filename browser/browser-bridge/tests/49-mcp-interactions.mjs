// Interaction tools (click, type, press_key, scroll, scroll_into_view) and
// the new read tools (snapshot, reload). Verifies:
//   - browser_get_snapshot returns hierarchical role+name text
//   - browser_click produces isTrusted=true events (the whole point of CDP
//     dispatch — synthetic JS clicks have isTrusted=false and are rejected
//     by bot detection)
//   - browser_type inserts text into the focused field
//   - browser_press_key fires keydown/keyup with the right key name
//   - browser_scroll moves window.scrollY
//   - browser_scroll_into_view brings off-screen elements visible
//   - browser_reload restarts page load
//
// Strategy: serve a synthetic data: URL page with a button, an input, a
// scroll-target divs sized large enough to require scrolling, and a
// recorder that captures every event and exposes it via window.recorded.
// All assertions run in-page via browser_evaluate after each interaction.
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
async function evalRaw(tabId, expression) {
  const r = await rpc('tools/call', { name: 'browser_evaluate', arguments: { tabId, expression } });
  if (r.error) throw new Error(r.error.message);
  return r.result?.content?.[0]?.text;
}

// Cleanup leftover state.
const initial = await call('browser_list_tabs', {});
for (const t of initial.tabs) {
  if (t.attention) await call('browser_dismiss_attention', { tabId: t.id });
  if (t.mcpOwned) await call('browser_close_tab', { tabId: t.id });
}
await delay(300);

// Synthetic test page. Records every input event with its isTrusted flag.
const HTML = `
<!DOCTYPE html><html><head><title>interactions</title></head><body>
<h1 id="hdr">Interaction Test Page</h1>
<button id="btn">Click Me</button>
<input id="inp" type="text" />
<div id="spacer" style="height:2000px;background:#eee">scroll past me</div>
<a id="bottom" href="#bottom">Bottom Anchor</a>
<script>
window.recorded = { clicks: [], inputs: [], keys: [] };
document.getElementById('btn').addEventListener('click', e => {
  window.recorded.clicks.push({ isTrusted: e.isTrusted, target: e.target.id });
});
document.getElementById('inp').addEventListener('input', e => {
  window.recorded.inputs.push({ value: e.target.value, isTrusted: e.isTrusted });
});
document.addEventListener('keydown', e => {
  window.recorded.keys.push({ key: e.key, isTrusted: e.isTrusted });
});
</script>
</body></html>
`.trim();
const dataUrl = 'data:text/html;base64,' + Buffer.from(HTML).toString('base64');

const tab = await call('browser_open', { url: dataUrl });
const tabId = tab.tabId;
await delay(500);

// 1. browser_get_snapshot returns hierarchical role+name text including our elements.
const snap = await evalRaw(tabId, '"snapshot test"'); // warm cache
const snapResult = await rpc('tools/call', { name: 'browser_get_snapshot', arguments: { tabId } });
const snapText = snapResult.result?.content?.[0]?.text || '';
if (!snapText.includes('Interaction Test Page')) {
  fail('mcp-interactions', 'snapshot missing heading: ' + snapText.slice(0, 300));
}
if (!snapText.includes('Click Me')) {
  fail('mcp-interactions', 'snapshot missing button name: ' + snapText.slice(0, 300));
}
if (!/heading\b/.test(snapText) || !/button\b/.test(snapText)) {
  fail('mcp-interactions', 'snapshot missing role labels (heading/button): ' + snapText.slice(0, 300));
}

// 2. browser_click — produces a click event with isTrusted=true.
await call('browser_click', { tabId, selector: '#btn' });
await delay(200);
const clicks = JSON.parse(await evalRaw(tabId, 'JSON.stringify(window.recorded.clicks)'));
if (clicks.length !== 1) fail('mcp-interactions', 'expected 1 click, got ' + clicks.length);
if (clicks[0].isTrusted !== true) {
  fail('mcp-interactions', 'CDP click should be isTrusted=true (anti-bot critical), got: ' + JSON.stringify(clicks[0]));
}
if (clicks[0].target !== 'btn') fail('mcp-interactions', 'click target wrong: ' + JSON.stringify(clicks[0]));

// 3. browser_type — focuses input via selector and types. Resulting input
// events have a value matching the typed text.
await call('browser_type', { tabId, text: 'hello world', selector: '#inp' });
await delay(200);
const inputValue = await evalRaw(tabId, 'document.getElementById("inp").value');
if (inputValue !== 'hello world') {
  fail('mcp-interactions', 'input value wrong: "' + inputValue + '"');
}
const inputs = JSON.parse(await evalRaw(tabId, 'JSON.stringify(window.recorded.inputs)'));
if (inputs.length === 0 || !inputs[inputs.length - 1].isTrusted) {
  fail('mcp-interactions', 'input events should be isTrusted=true: ' + JSON.stringify(inputs));
}

// 4. browser_press_key — Enter on focused input, captured by global keydown listener.
await call('browser_press_key', { tabId, key: 'Enter' });
await delay(200);
const keys = JSON.parse(await evalRaw(tabId, 'JSON.stringify(window.recorded.keys)'));
const enterKey = keys.find(k => k.key === 'Enter');
if (!enterKey) fail('mcp-interactions', 'Enter key not recorded; got: ' + JSON.stringify(keys));
if (!enterKey.isTrusted) fail('mcp-interactions', 'press_key should be isTrusted=true: ' + JSON.stringify(enterKey));

// Unknown key should error with allowed-list hint.
let unknownErr = null;
try { await call('browser_press_key', { tabId, key: 'NotARealKey' }); }
catch (e) { unknownErr = e.message; }
if (!unknownErr || !unknownErr.includes('Allowed:')) {
  fail('mcp-interactions', 'unknown key should error with Allowed list: ' + unknownErr);
}

// 5. browser_scroll — page scrolls down by deltaY.
const scrollBefore = parseInt(await evalRaw(tabId, 'window.scrollY'), 10);
await call('browser_scroll', { tabId, deltaX: 0, deltaY: 800 });
await delay(300);
const scrollAfter = parseInt(await evalRaw(tabId, 'window.scrollY'), 10);
if (scrollAfter <= scrollBefore) {
  fail('mcp-interactions', `scroll didn't move scrollY: before=${scrollBefore} after=${scrollAfter}`);
}

// 6. browser_scroll_into_view — element below current scroll becomes visible.
// Reset scroll, then scroll the bottom anchor into view.
await evalRaw(tabId, 'window.scrollTo(0, 0)');
await delay(200);
await call('browser_scroll_into_view', { tabId, selector: '#bottom' });
await delay(300);
const bottomVisible = await evalRaw(tabId, '(() => { const r = document.getElementById("bottom").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()');
if (bottomVisible !== 'true') {
  fail('mcp-interactions', '#bottom not visible after scroll_into_view: ' + bottomVisible);
}

// 7. browser_reload — page restarts; window.recorded resets to fresh state.
await call('browser_reload', { tabId });
await delay(1500);
const recordedAfterReload = await evalRaw(tabId, 'JSON.stringify(window.recorded)');
const parsedRec = JSON.parse(recordedAfterReload);
if (parsedRec.clicks.length !== 0 || parsedRec.inputs.length !== 0 || parsedRec.keys.length !== 0) {
  fail('mcp-interactions', 'reload should reset window.recorded; got ' + recordedAfterReload);
}

// Cleanup.
await call('browser_close_tab', { tabId });
await delay(300);

pass('mcp-interactions (snapshot, click[trusted], type[trusted], press_key[trusted], scroll, scroll_into_view, reload)');
process.exit(0);
