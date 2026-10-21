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
import assert from 'node:assert/strict';
import { connectViewer, delay, pass, fail } from './helpers.mjs';

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '6080', 10);

function rpc(method, params) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params });
    const req = http.request(`http://127.0.0.1:${BRIDGE_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    }, r => {
      let buf = ''; r.on('data', c => buf += c);
      r.on('end', () => { try { res(JSON.parse(buf)); } catch { rej(new Error(buf.slice(0, 200))); } });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Timed out calling ' + params?.name)));
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
  if (r.result?.isError) throw new Error(r.result.content?.[0]?.text || 'evaluation failed');
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
<input id="inp" type="text" aria-label="Test input" />
<input id="other" type="text" value="untouched" aria-label="Other input" />
<input id="readonly" readonly value="readonly" />
<input id="blocked-text" value="original" />
<fieldset disabled><input id="disabled" value="disabled" /><select id="disabled-select"><option value="a">A</option></select></fieldset>
<textarea id="textarea">old textarea</textarea>
<div id="editable" contenteditable="true" aria-label="Editable text">old editable</div>
<select id="sel" multiple size="3" aria-label="Choices">
  <option value="a">A</option><option value="disabled" disabled>Disabled</option>
  <optgroup disabled label="Unavailable"><option value="group-disabled">Group disabled</option></optgroup>
  <option value="hidden" hidden>Hidden</option><option value="b">B</option>
  <option value="c">C</option><option value="d">D</option><option value="e">E</option>
</select>
<select id="single" aria-label="Single choice"><option value="x">X</option><option value="y">Y</option></select>
<select id="classic" style="appearance:auto !important"><option value="x">X</option><option value="y">Y</option></select>
<select id="sized" size="3"><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select>
<select id="blocked" size="2"><option value="x">X</option><option value="y">Y</option></select>
<div id="hover" role="button" tabindex="0" style="width:80px;height:40px">Hover Me</div>
<div id="drag" role="button" tabindex="0" draggable="true" style="width:50px;height:50px;background:red">Drag Source</div>
<div id="drop" role="button" tabindex="0" style="margin-left:180px;width:100px;height:100px;background:blue">Drop Target</div>
<div id="spacer" style="height:2000px;background:#eee">scroll past me</div>
<a id="bottom" href="#bottom">Bottom Anchor</a>
<script>
window.recorded = { clicks: [], inputs: [], keys: [], hovers: [], selections: [], drags: [], pointers: [] };
document.getElementById('btn').addEventListener('click', e => {
  window.recorded.clicks.push({ isTrusted: e.isTrusted, target: e.target.id });
});
document.getElementById('inp').addEventListener('input', e => {
  window.recorded.inputs.push({ value: e.target.value, isTrusted: e.isTrusted });
});
document.getElementById('editable').addEventListener('input', e => window.recorded.inputs.push({ value: e.target.textContent, isTrusted: e.isTrusted }));
document.getElementById('textarea').addEventListener('input', e => window.recorded.inputs.push({ value: e.target.value, isTrusted: e.isTrusted }));
document.getElementById('blocked-text').addEventListener('beforeinput', e => e.preventDefault());
document.getElementById('hover').addEventListener('mouseover', e => window.recorded.hovers.push({ isTrusted: e.isTrusted }));
for (const id of ['sel', 'single', 'classic', 'sized']) {
  for (const type of ['input', 'change']) document.getElementById(id).addEventListener(type, e => window.recorded.selections.push({ id, type, isTrusted: e.isTrusted, values: Array.from(e.target.selectedOptions, o => o.value) }));
}
window.blockedKeys = [];
document.getElementById('blocked').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); window.blockedKeys.push(e.defaultPrevented); }
}, true);
for (const type of ['mousemove', 'mousedown', 'mouseup']) {
  document.addEventListener(type, e => window.recorded.pointers.push({ type, target: e.target.id, x: e.clientX, y: e.clientY, button: e.button, buttons: e.buttons, shift: e.shiftKey, isTrusted: e.isTrusted }));
}
document.addEventListener('contextmenu', e => e.preventDefault());
document.getElementById('drag').addEventListener('dragstart', e => window.recorded.drags.push({ type: 'start', isTrusted: e.isTrusted }));
document.getElementById('drop').addEventListener('dragover', e => e.preventDefault());
document.getElementById('drop').addEventListener('drop', e => { e.preventDefault(); window.recorded.drags.push({ type: 'drop', isTrusted: e.isTrusted }); });
document.addEventListener('keydown', e => {
  window.recorded.keys.push({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, isTrusted: e.isTrusted });
});
</script>
</body></html>
`.trim();
const dataUrl = 'data:text/html;base64,' + Buffer.from(HTML).toString('base64');

const tab = await call('browser_open', { url: dataUrl });
const tabId = tab.tabId;
await delay(500);
await assert.rejects(call('browser_move_pointer', { tabId, to: { selector: '#drop' }, mouseButton: 'left' }), /both from and mouseButton/);

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
function uidFor(snapshot, name) {
  const line = snapshot.split('\n').find(l => l.includes(JSON.stringify(name)));
  const match = line?.match(/\[uid=(\d+)\]/);
  if (!match) fail('mcp-interactions', 'snapshot missing UID for ' + name + ': ' + snapshot.slice(0, 500));
  return match[1];
}
let liveSnapshot = snapText;

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


// 4. New MCP interaction tools.
await call('browser_type', { tabId, text: ' appended' });
assert.equal(await evalRaw(tabId, 'document.getElementById("inp").value'), 'hello world appended');
await call('browser_click', { tabId, selector: '#inp', doubleClick: true });
assert.equal(await evalRaw(tabId, 'document.getElementById("inp").selectionEnd > document.getElementById("inp").selectionStart'), 'true');
await call('browser_type', { tabId, text: '' });
assert.equal(await evalRaw(tabId, 'document.getElementById("inp").value'), 'hello world appended');
const replaced = await call('browser_type', { tabId, text: 'replacement', replace: true, uid: uidFor(liveSnapshot, 'Test input'), includeSnapshot: true });
assert.ok(replaced.snapshot?.includes('Test input'));
liveSnapshot = replaced.snapshot;
assert.equal(await evalRaw(tabId, 'document.getElementById("inp").value'), 'replacement');
assert.equal(await evalRaw(tabId, 'window.recorded.keys.some(e => e.key === "a" && (e.ctrl || e.meta) && e.isTrusted)'), 'true');
await call('browser_type', { tabId, text: '', replace: true });
assert.equal(await evalRaw(tabId, 'document.getElementById("inp").value'), '');
await call('browser_type', { tabId, text: 'editable replacement', selector: '#editable', replace: true });
assert.equal(await evalRaw(tabId, 'document.getElementById("editable").textContent'), 'editable replacement');
await call('browser_type', { tabId, text: '', selector: '#editable', replace: true });
assert.equal(await evalRaw(tabId, 'document.getElementById("editable").textContent'), '');
await call('browser_type', { tabId, text: 'new\ntextarea', selector: '#textarea', replace: true });
assert.equal(await evalRaw(tabId, 'document.getElementById("textarea").value'), 'new\ntextarea');
const replacementEvents = JSON.parse(await evalRaw(tabId, 'JSON.stringify(window.recorded.inputs)'));
for (const value of ['replacement', '', 'editable replacement', 'new\ntextarea']) {
  assert.ok(replacementEvents.some(e => e.value === value && e.isTrusted), 'missing trusted replacement event: ' + value);
}
for (const [selector, error] of [['#btn', /not an editable/], ['#readonly', /readonly/], ['#disabled', /disabled/]]) {
  await assert.rejects(call('browser_type', { tabId, text: 'nope', selector, replace: true }), error);
}
await assert.rejects(call('browser_type', { tabId, selector: '#blocked-text', text: 'replacement', replace: true }), /modified or prevented/);
assert.equal(await evalRaw(tabId, 'document.getElementById("blocked-text").value'), 'original');
assert.equal(await evalRaw(tabId, 'document.getElementById("other").value'), 'untouched');
await Promise.all([
  call('browser_type', { tabId, selector: '#inp', text: 'first field', replace: true }),
  call('browser_type', { tabId, selector: '#other', text: 'second field', replace: true }),
]);
assert.equal(await evalRaw(tabId, 'document.getElementById("inp").value'), 'first field');
assert.equal(await evalRaw(tabId, 'document.getElementById("other").value'), 'second field');

const moved = await call('browser_move_pointer', { tabId, to: { uid: uidFor(liveSnapshot, 'Hover Me') }, includeSnapshot: true });
assert.ok(moved.snapshot?.includes('Hover Me'));
liveSnapshot = moved.snapshot;
const hovers = JSON.parse(await evalRaw(tabId, 'JSON.stringify(window.recorded.hovers)'));
if (!hovers.length || !hovers[0].isTrusted) fail('mcp-interactions', 'hover should produce trusted mouse event: ' + JSON.stringify(hovers));
const pointerCount = Number(await evalRaw(tabId, 'window.recorded.pointers.length'));
const path = await call('browser_move_pointer', { tabId, to: { selector: '#drop' } });
const pathEvents = JSON.parse(await evalRaw(tabId, `JSON.stringify(window.recorded.pointers.slice(${pointerCount}))`));
assert.ok(pathEvents.length > 0, 'movement must produce trusted pointer events');
assert.ok(pathEvents.every(e => e.type === 'mousemove' && e.buttons === 0 && e.isTrusted));
assert.ok(!Object.hasOwn(path, 'movedFrom'));
assert.equal(pathEvents.at(-1).x, Math.trunc(path.movedTo.x));
assert.equal(pathEvents.at(-1).y, Math.trunc(path.movedTo.y));
await assert.rejects(call('browser_move_pointer', { tabId, from: { selector: '#drop' }, to: { selector: '#hover' }, mouseButton: 'bad' }), /mouseButton must/);
await call('browser_move_pointer', { tabId, to: { selector: '#bottom' } });
assert.equal(await evalRaw(tabId, 'window.scrollY > 0'), 'true');
await call('browser_move_pointer', { tabId, to: { selector: '#hover' } });
await assert.rejects(call('browser_move_pointer', { tabId, to: { uid: '999999' } }), /snapshot/);

assert.notEqual(await evalRaw(tabId, 'getComputedStyle(sel).appearance'), 'base-select');
assert.notEqual(await evalRaw(tabId, 'getComputedStyle(sized).appearance'), 'base-select');
const selected = await call('browser_select', { tabId, uid: uidFor(liveSnapshot, 'Choices'), values: ['a', 'c'], includeSnapshot: true });
if (!selected.snapshot?.includes('Choices')) fail('mcp-interactions', 'select includeSnapshot missing updated snapshot');
liveSnapshot = selected.snapshot;
if (JSON.stringify(selected.selectedValues) !== JSON.stringify(['a', 'c'])) fail('mcp-interactions', 'selected values wrong: ' + JSON.stringify(selected));
const selectionEvents = JSON.parse(await evalRaw(tabId, 'JSON.stringify(window.recorded.selections)'));
assert.ok(selectionEvents.length >= 2);
assert.ok(selectionEvents.every(e => e.isTrusted), 'select must never dispatch synthetic events');
assert.deepEqual(selectionEvents.at(-1).values, ['a', 'c']);
for (let i = 0; i < selectionEvents.length; i += 2) {
  assert.equal(selectionEvents[i].type, 'input');
  assert.equal(selectionEvents[i + 1]?.type, 'change');
}
const reselected = await call('browser_select', { tabId, selector: '#sel', values: ['e', 'b'] });
assert.deepEqual(reselected.selectedValues, ['b', 'e'], 'selection must replace previous choices and reach offscreen options');
for (const [values, error] of [[['missing'], /not found/], [['disabled'], /disabled/], [['group-disabled'], /disabled/], [['hidden'], /hidden/], [[], /at least one/]]) {
  await assert.rejects(call('browser_select', { tabId, selector: '#sel', values }), error);
}
assert.equal(await evalRaw(tabId, 'Array.from(document.getElementById("sel").selectedOptions, o => o.value).join(",")'), 'b,e');
await assert.rejects(call('browser_select', { tabId, selector: '#disabled-select', values: ['a'] }), /disabled/);
await assert.rejects(call('browser_select', { tabId, selector: '#btn', values: ['a'] }), /not a native/);
const single = await call('browser_select', { tabId, selector: '#single', values: ['y'] });
if (JSON.stringify(single.selectedValues) !== JSON.stringify(['y'])) fail('mcp-interactions', 'single select value wrong: ' + JSON.stringify(single));
const singleEvents = JSON.parse(await evalRaw(tabId, 'JSON.stringify(window.recorded.selections.filter(e => e.id === "single"))'));
assert.ok(singleEvents.length >= 2 && singleEvents.every(e => e.isTrusted));
assert.deepEqual(singleEvents.at(-1).values, ['y']);
await call('browser_click', { tabId, selector: '#single' });
assert.deepEqual((await call('browser_select', { tabId, selector: '#single', values: ['x'] })).selectedValues, ['x']);
assert.deepEqual((await call('browser_select', { tabId, selector: '#single', values: ['y'] })).selectedValues, ['y']);
assert.deepEqual((await call('browser_select', { tabId, selector: '#classic', values: ['y'] })).selectedValues, ['y']);
const classicEvents = JSON.parse(await evalRaw(tabId, 'JSON.stringify(window.recorded.selections.filter(e => e.id === "classic"))'));
assert.ok(classicEvents.length >= 2 && classicEvents.every(e => e.isTrusted));
assert.deepEqual((await call('browser_select', { tabId, selector: '#sized', values: ['y'] })).selectedValues, ['y']);
const sizedEvents = JSON.parse(await evalRaw(tabId, 'JSON.stringify(window.recorded.selections.filter(e => e.id === "sized"))'));
assert.ok(sizedEvents.length >= 2 && sizedEvents.every(e => e.isTrusted));
await assert.rejects(call('browser_select', { tabId, selector: '#single', values: ['x', 'y'] }), /select multiple/);
await assert.rejects(call('browser_select', { tabId, selector: '#blocked', values: ['y'] }), /did not reach/);
assert.equal(await evalRaw(tabId, 'blockedKeys.includes(true)'), 'true');
assert.equal(await evalRaw(tabId, 'document.getElementById("blocked").value'), 'x');
const optionSelection = await call('browser_click', { tabId, selector: '#single option[value="x"]' });
assert.equal(optionSelection.method, 'keyboard');
assert.equal(await evalRaw(tabId, 'document.getElementById("single").value'), 'x');

const dragged = await call('browser_move_pointer', {
  tabId, from: { uid: uidFor(liveSnapshot, 'Drag Source') },
  to: { uid: uidFor(liveSnapshot, 'Drop Target') }, mouseButton: 'left', includeSnapshot: true,
});
if (!dragged.snapshot?.includes('Drop Target')) fail('mcp-interactions', 'drag includeSnapshot missing updated snapshot');
await delay(200);
const drags = JSON.parse(await evalRaw(tabId, 'JSON.stringify(window.recorded.drags)'));
if (!drags.some(e => e.type === 'start' && e.isTrusted) || !drags.some(e => e.type === 'drop' && e.isTrusted)) fail('mcp-interactions', 'drag/drop trusted events missing: ' + JSON.stringify(drags));
for (const [button, code, mask] of [['middle', 1, 4], ['right', 2, 2]]) {
  const count = Number(await evalRaw(tabId, 'window.recorded.pointers.length'));
  const heldMove = await call('browser_move_pointer', {
    tabId, from: { selector: '#hover' }, to: { selector: '#drop' }, mouseButton: button, modifiers: ['shift'],
  });
  const events = JSON.parse(await evalRaw(tabId, `JSON.stringify(window.recorded.pointers.slice(${count}))`));
  assert.ok(events.every(e => e.isTrusted && e.shift));
  assert.ok(events.some(e => e.type === 'mousedown' && e.button === code && e.buttons === mask));
  assert.ok(events.some(e => e.type === 'mousemove' && e.buttons === mask));
  assert.ok(events.filter(e => e.type === 'mousemove' && e.buttons === mask).length >= 8);
  assert.ok(events.some(e => e.x > heldMove.movedFrom.x && e.x < heldMove.movedTo.x));
  assert.equal(events.at(-1).type, 'mouseup');
  assert.equal(events.at(-1).buttons, 0);
}
await call('browser_move_pointer', { tabId, to: { selector: '#hover' } });
assert.equal(await evalRaw(tabId, 'window.recorded.pointers.at(-1).buttons'), '0');

const viewer = await connectViewer();
try {
  viewer.send({ type: 'switchTab', targetId: tabId });
  while ((await viewer.waitFor('targetChanged')).targetId !== tabId) {}
  viewer.send({ type: 'mouse', action: 'mouseMoved', x: 10, y: 10 });
  await call('browser_wait_for', { tabId, expression: 'window.recorded.pointers.at(-1)?.x === 10', timeoutMs: 3000 });
  const count = Number(await evalRaw(tabId, 'window.recorded.pointers.length'));
  await call('browser_move_pointer', {
    tabId, from: { selector: '#hover' }, to: { selector: '#drop' }, mouseButton: 'left',
  });
  const events = JSON.parse(await evalRaw(tabId, `JSON.stringify(window.recorded.pointers.slice(${count}))`));
  assert.equal(events.find(e => e.type === 'mousedown')?.target, 'hover', 'viewer movement must not change the explicit drag origin');
} finally {
  viewer.close();
}

// 5. browser_press_key — Enter on focused input, captured by global keydown listener.
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

// 6. browser_scroll — page scrolls down by deltaY.
const scrollBefore = parseInt(await evalRaw(tabId, 'window.scrollY'), 10);
await call('browser_scroll', { tabId, deltaX: 0, deltaY: 800 });
await delay(300);
const scrollAfter = parseInt(await evalRaw(tabId, 'window.scrollY'), 10);
if (scrollAfter <= scrollBefore) {
  fail('mcp-interactions', `scroll didn't move scrollY: before=${scrollBefore} after=${scrollAfter}`);
}

// 7. browser_scroll_into_view — element below current scroll becomes visible.
// Reset scroll, then scroll the bottom anchor into view.
await evalRaw(tabId, 'window.scrollTo(0, 0)');
await delay(200);
await call('browser_scroll_into_view', { tabId, selector: '#bottom' });
await delay(300);
const bottomVisible = await evalRaw(tabId, `(() => {
  const el = document.getElementById("bottom"), r = el.getBoundingClientRect();
  const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
  const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
  return right > left && bottom > top && document.elementFromPoint((left + right) / 2, (top + bottom) / 2) === el;
})()`);
if (bottomVisible !== 'true') {
  fail('mcp-interactions', '#bottom not visible after scroll_into_view: ' + bottomVisible);
}

// 8. browser_reload — page restarts; window.recorded resets to fresh state.
await call('browser_reload', { tabId });
await delay(1500);
const recordedAfterReload = await evalRaw(tabId, 'JSON.stringify(window.recorded)');
const parsedRec = JSON.parse(recordedAfterReload);
if (parsedRec.clicks.length !== 0 || parsedRec.inputs.length !== 0 || parsedRec.keys.length !== 0 || parsedRec.hovers.length !== 0 || parsedRec.drags.length !== 0) {
  fail('mcp-interactions', 'reload should reset window.recorded; got ' + recordedAfterReload);
}

// Cleanup.
await call('browser_close_tab', { tabId });
await delay(300);

pass('mcp-interactions (trusted click/type/replace/pointer/drag/select, invalid targets, concurrent input, snapshot, keys, scroll, reload)');
process.exit(0);
