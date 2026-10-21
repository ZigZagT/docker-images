import assert from 'node:assert/strict';
import http from 'node:http';
import { connectViewer, createCdpPage, delay, httpGet, pass } from './helpers.mjs';

async function rpc(name, args) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const response = await new Promise((resolve, reject) => {
    const req = http.request('http://127.0.0.1:6080/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Timed out: ' + name)));
    req.on('error', reject);
    req.end(body);
  });
  if (response.error) throw new Error(response.error.message);
  if (response.result.isError) throw new Error(response.result.content[0].text);
  return response.result;
}

async function call(name, args) {
  const result = await rpc(name, args);
  const value = result.content[0].text;
  try { return JSON.parse(value); }
  catch { return value; }
}

const html = `<!doctype html><html><head><title>Native select investigation</title>
<style>
  body { margin:0; background:rgb(30,80,50); }
  select { position:absolute; left:200px; top:120px; width:260px; height:40px; font:20px sans-serif; background:white; color:black; }
  option[value="b"] { background:rgb(255,128,0); color:black; }
  #heartbeat { position:absolute; left:0; top:0; width:8px; height:8px; }
</style><style id="__bb_base_select">select { appearance:base-select !important; }</style>
<style id="mode"></style></head><body>
<div id="heartbeat"></div>
<select id="pick" aria-label="Direction">
  <option value="a">Alpha north</option><option value="b">Beta south</option>
  <option value="c">Gamma east</option><option value="d">Delta west</option>
</select>
<script>
  window.selectionEvents = [];
  for (const type of ['input', 'change']) pick.addEventListener(type, e => {
    selectionEvents.push({type, value:pick.value, trusted:e.isTrusted});
  });
  let tick = 0;
  setInterval(() => { heartbeat.style.background = ++tick % 2 ? 'red' : 'blue'; }, 100);
</script></body></html>`;

const version = await httpGet('http://127.0.0.1:18800/json/version');
const opened = await call('browser_open', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
const tabId = opened.tabId;
const direct = await createCdpPage({ targetId: tabId });
const evaluate = expression => call('browser_evaluate', { tabId, expression });
const viewer = await connectViewer();
let latestFrame;
viewer.ws.on('message', raw => {
  const event = JSON.parse(raw);
  if (event.type !== 'frame') return;
  latestFrame = event;
  viewer.send({ type: 'frameDrawn' });
  viewer.send({ type: 'requestFrame' });
});

async function freshFrame() {
  const previous = latestFrame?.frameId;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (latestFrame && latestFrame.frameId !== previous) return latestFrame.data;
    await delay(25);
  }
  throw new Error('No fresh bridge frame; popup visibility cannot be measured');
}

async function changedPixels(before, after, mime = 'image/jpeg') {
  return evaluate(`(async () => {
    const images = await Promise.all(${JSON.stringify([before, after])}.map(data => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Frame decoding failed'));
      image.src = 'data:${mime};base64,' + data;
    })));
    const r = pick.getBoundingClientRect();
    const buffers = images.map(image => {
      const canvas = document.createElement('canvas');
      canvas.width = innerWidth; canvas.height = innerHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, innerWidth, innerHeight);
      return context.getImageData(0, 0, innerWidth, innerHeight).data;
    });
    let changed = 0, sampled = 0;
    for (let y = Math.max(0, Math.floor(r.top - 80)); y < Math.min(innerHeight, Math.ceil(r.bottom + 300)); y++) {
      for (let x = Math.max(0, Math.floor(r.left - 30)); x < Math.min(innerWidth, Math.ceil(r.right + 50)); x++) {
        if (x >= r.left - 12 && x <= r.right + 12 && y >= r.top - 12 && y <= r.bottom + 12) continue;
        const i = (y * innerWidth + x) * 4;
        const difference = Math.abs(buffers[0][i] - buffers[1][i]) +
          Math.abs(buffers[0][i + 1] - buffers[1][i + 1]) + Math.abs(buffers[0][i + 2] - buffers[1][i + 2]);
        if (difference > 90) changed++;
        sampled++;
      }
    }
    return { changed, sampled };
  })()`);
}

async function optionPoint(screenshot) {
  return evaluate(`(async () => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + ${JSON.stringify(screenshot)};
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = innerWidth; canvas.height = innerHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, innerWidth, innerHeight);
    const data = context.getImageData(0, 0, innerWidth, innerHeight).data;
    const r = pick.getBoundingClientRect();
    let left = Infinity, top = Infinity, right = -1, bottom = -1, count = 0;
    for (let y = Math.max(0, Math.floor(r.top - 80)); y < Math.min(innerHeight, Math.ceil(r.bottom + 300)); y++) {
      for (let x = Math.max(0, Math.floor(r.left - 30)); x < Math.min(innerWidth, Math.ceil(r.right + 50)); x++) {
        const i = (y * innerWidth + x) * 4;
        if (data[i] > 230 && data[i + 1] > 90 && data[i + 1] < 170 && data[i + 2] < 40) {
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y); count++;
        }
      }
    }
    return count > 20 ? {x:(left + right)/2, y:(top + bottom)/2, pixels:count} : null;
  })()`);
}

const observations = [];
const failures = [];
try {
  viewer.send({ type: 'switchTab', targetId: tabId });
  while ((await viewer.waitFor('targetChanged')).targetId !== tabId) {}
  viewer.send({ type: 'requestFrame' });
  await freshFrame();
  assert.equal(await evaluate('document.querySelectorAll("style#__bb_base_select").length'), 1);
  assert.equal(await evaluate('getComputedStyle(pick, "::picker(select)").appearance'), 'base-select',
    'attaching to a page with the old bridge stylesheet must upgrade its picker rule');

  for (const [mode, css] of [
    ['native', '#pick, #pick::picker(select) { appearance:auto !important; }'],
    ['legacy', '#pick { appearance:base-select !important; } #pick::picker(select) { appearance:auto !important; }'],
    ['bridge', ''],
    ['customizable', '#pick, #pick::picker(select) { appearance:base-select !important; }'],
  ]) {
    await call('browser_press_key', { tabId, key: 'Escape' });
    await evaluate(`mode.textContent = ${JSON.stringify(css)}; pick.value = 'a'; selectionEvents.length = 0`);
    await delay(150);
    const before = await freshFrame();
    const unchanged = await freshFrame();
    const baseline = await changedPixels(before, unchanged);
    const closedScreenshot = (await rpc('browser_screenshot', { tabId })).content[0].data;
    await call('browser_click', { tabId, selector: '#pick' });
    await delay(150);
    const after = await freshFrame();
    const frameDifference = await changedPixels(before, after);
    const openScreenshot = (await rpc('browser_screenshot', { tabId })).content[0].data;
    const screenshotDifference = await changedPixels(closedScreenshot, openScreenshot, 'image/png');
    const geometry = await evaluate(`({
      open: pick.matches(':open'),
      appearance: getComputedStyle(pick).appearance,
      pickerAppearance: getComputedStyle(pick, '::picker(select)').appearance,
      options: Array.from(pick.options, option => {
        const r = option.getBoundingClientRect();
        return {value:option.value, width:r.width, height:r.height};
      })
    })`);
    assert.equal(geometry.open, true, mode + ' picker must actually be open');
    assert.equal(geometry.appearance, mode === 'native' ? 'auto' : 'base-select', mode + ' must use the requested rendering mode');
    const result = {
      mode, geometry, baseline,
      bridgePixels: frameDifference.changed,
      screenshotPixels: screenshotDifference.changed,
    };
    observations.push(result);

    await call('browser_press_key', { tabId, key: 'ArrowDown' });
    await call('browser_press_key', { tabId, key: 'Enter' });
    result.keyboard = await evaluate('({value:pick.value, events:selectionEvents})');
    if (result.keyboard.value !== 'b' || !result.keyboard.events.length ||
        result.keyboard.events.some(event => !event.trusted)) {
      failures.push(mode + ': native keyboard selection failed');
    }

    for (const initiallyOpen of [false, true]) {
      if (initiallyOpen) await call('browser_click', { tabId, selector: '#pick' });
      await evaluate('selectionEvents.length = 0');
      try {
        const selected = await call('browser_select', { tabId, selector: '#pick', values: [initiallyOpen ? 'a' : 'c'] });
        assert.deepEqual(selected.selectedValues, [initiallyOpen ? 'a' : 'c']);
        assert.deepEqual(await evaluate('selectionEvents.filter(event => event.type === "change").map(event => event.value)'), selected.selectedValues,
          'single-select must not commit intermediate values that could submit a form');
        result[initiallyOpen ? 'selectOpen' : 'selectClosed'] = selected.selectedValues;
      } catch (error) {
        result[initiallyOpen ? 'selectOpen' : 'selectClosed'] = error.message;
        failures.push(mode + ': ' + error.message);
        await call('browser_press_key', { tabId, key: 'Escape' });
      }
    }
    await call('browser_click', { tabId, selector: '#pick' });
    try {
      const action = await call('browser_click', { tabId, selector: '#pick option[value="b"]' });
      result.optionAction = { value: await evaluate('pick.value'), method: action.method || 'mouse' };
    } catch (error) {
      result.optionAction = { error: error.message };
    } finally {
      await call('browser_press_key', { tabId, key: 'Escape' });
    }
    const point = await optionPoint(openScreenshot);
    result.screenshotOptionPoint = point;
    if (point) {
      await call('browser_select', { tabId, selector: '#pick', values: ['a'] });
      await evaluate('selectionEvents.length = 0');
      await call('browser_click', { tabId, selector: '#pick' });
      await call('browser_click', { tabId, at: { x: point.x, y: point.y } });
      result.coordinateMouse = await evaluate('({value:pick.value, open:pick.matches(":open"), events:selectionEvents})');
      await call('browser_press_key', { tabId, key: 'Escape' });
      await call('browser_select', { tabId, selector: '#pick', values: ['a'] });
      await evaluate('selectionEvents.length = 0');
      await call('browser_click', { tabId, selector: '#pick' });
      for (const action of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        viewer.send({ type: 'mouse', action, x: point.x, y: point.y, button: 'left', clickCount: 1 });
      }
      await delay(300);
      result.viewerMouse = await evaluate('({value:pick.value, open:pick.matches(":open"), events:selectionEvents})');
      await call('browser_press_key', { tabId, key: 'Escape' });

      await call('browser_select', { tabId, selector: '#pick', values: ['a'] });
      await call('browser_click', { tabId, selector: '#pick' });
      await direct.command('Page.bringToFront');
      result.openAfterActivation = await evaluate('pick.matches(":open")');
      await call('browser_press_key', { tabId, key: 'Escape' });

      await evaluate('selectionEvents.length = 0');
      await call('browser_click', { tabId, selector: '#pick' });
      for (const [type, buttons] of [['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0]]) {
        await direct.command('Input.dispatchMouseEvent', {
          type, x: point.x, y: point.y, button: 'left', buttons, clickCount: 1,
        });
      }
      result.directMouse = await evaluate('({value:pick.value, open:pick.matches(":open"), events:selectionEvents})');
      await call('browser_press_key', { tabId, key: 'Escape' });
      if (mode === 'native') {
        for (const gestureSourceType of ['mouse', 'touch']) {
          await call('browser_select', { tabId, selector: '#pick', values: ['a'] });
          await evaluate('selectionEvents.length = 0');
          await call('browser_click', { tabId, selector: '#pick' });
          try {
            await direct.command('Input.synthesizeTapGesture', { x: point.x, y: point.y, gestureSourceType });
            result[gestureSourceType + 'Tap'] = await evaluate('({value:pick.value, open:pick.matches(":open"), events:selectionEvents})');
          } catch (error) {
            result[gestureSourceType + 'Tap'] = { error: error.message };
          }
          await call('browser_press_key', { tabId, key: 'Escape' });
        }
      }
    }
  }
  const report = JSON.stringify({ browser: version.Browser, observations });
  assert.deepEqual(failures, [], 'native select input failures: ' + report);
  for (const result of observations) {
    assert.equal(result.baseline.changed, 0, result.mode + ': fixture outside the control must be stable');
    assert.ok(result.screenshotPixels > 1000, result.mode + ': screenshots must contain the open picker');
  }
  for (const result of observations) {
    assert.equal(result.optionAction.value, 'b', result.mode + ': option actions must work without caller workarounds');
    if (['native', 'legacy'].includes(result.mode)) {
      assert.equal(result.optionAction.method, 'keyboard');
      continue;
    }
    assert.ok(result.bridgePixels > 1000, result.mode + ': picker must appear in real bridge frames');
    assert.ok(result.geometry.options.every(option => option.width > 0 && option.height > 0));
    assert.equal(result.optionAction.method, 'mouse');
    for (const method of ['coordinateMouse', 'viewerMouse', 'directMouse']) {
      assert.equal(result[method]?.value, 'b', result.mode + ': ' + method);
      assert.ok(result[method].events.length && result[method].events.every(event => event.trusted));
    }
  }
  pass('native-select ' + JSON.stringify({
    browser: version.Browser,
    modes: observations.map(result => ({
      mode: result.mode, bridgePixels: result.bridgePixels, screenshotPixels: result.screenshotPixels,
      keyboard: result.keyboard.value, selectClosed: result.selectClosed, selectOpen: result.selectOpen,
      optionAction: result.optionAction, coordinateMouse: result.coordinateMouse?.value,
      viewerMouse: result.viewerMouse?.value, directMouse: result.directMouse?.value,
      mouseTap: result.mouseTap?.value, touchTap: result.touchTap?.value,
    })),
  }));
} finally {
  viewer.close();
  try { await direct.close(); }
  finally { await call('browser_close_tab', { tabId }); }
}
