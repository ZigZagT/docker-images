// MCP pointer integration tests launch headless Chromium and inject CDP failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createMcpHandler } from '../mcp.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/usr/lib/node_modules/openclaw/node_modules/playwright-core');

test('unified move, native click options, balanced release and non-activating failures', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/local/bin/chrome-raw', headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><style>
      body{margin:0} #click{position:absolute;left:30px;top:30px;width:120px;height:50px}
      #handle{position:absolute;left:30px;top:150px;width:120px;height:50px;background:orange}
      #source{position:absolute;left:30px;top:300px;width:100px;height:50px;background:green}
      #destination{position:absolute;left:300px;top:300px;width:100px;height:80px;background:blue}
      #hidden{display:none} #covered{position:absolute;left:500px;top:30px;width:100px;height:50px}
      #cover{position:absolute;left:500px;top:30px;width:100px;height:50px;background:red;z-index:2}
      select{position:absolute;left:600px;top:200px}
      </style><button id="click">Click target</button><div id="handle">Handle</div>
      <div id="source" draggable="true">Source</div><div id="destination">Destination</div>
      <button id="hidden">Hidden</button><button id="covered">Covered</button><div id="cover"></div>
      <select id="select"><option value="a">Alpha</option><option id="option" value="b">Beta</option></select>
      <script>window.events=[];window.drops=0;
      for(const type of ['pointermove','pointerdown','pointerup','click','dblclick','contextmenu','auxclick','dragstart','dragover','drop'])
        document.addEventListener(type,e=>{events.push({type,trusted:e.isTrusted,target:e.target.id,button:e.button,buttons:e.buttons,detail:e.detail,ctrl:e.ctrlKey,shift:e.shiftKey,x:e.clientX,time:performance.now()});if(type==='contextmenu')e.preventDefault();},true);
      handle.addEventListener('pointerdown',e=>handle.setPointerCapture(e.pointerId));
      handle.addEventListener('pointermove',e=>{if(e.buttons)handle.dataset.x=e.clientX});
      source.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','payload'));
      destination.addEventListener('dragover',e=>e.preventDefault());
      destination.addEventListener('drop',e=>{e.preventDefault();drops++;});</script>`);
    const session = await context.newCDPSession(page);
    const commands = [];
    let fault = null;
    const deps = {
      sessionPool: new Map([['page', { sessionId: 'pointer-page' }]]), poolAttach: async () => {},
      ensureBrowserConnection: async () => {}, getCdpTargets: async () => [], log: { error() {} },
      sessionCommand: async (sid, method, params) => {
        commands.push({ method, params });
        const injection = fault?.(method, params);
        if (injection === 'before') return { error: { message: 'injected failure' } };
        try {
          const result = await session.send(method, params);
          return injection === 'after' ? { error: { message: 'injected lost reply' } } : { result };
        } catch (error) { return { error: { message: error.message } }; }
      },
    };
    const handler = createMcpHandler(deps);
    let id = 0;
    const rpc = async (method, params) => {
      const req = Readable.from([JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })]);
      req.method = 'POST';
      let body;
      await handler(req, { writeHead() {}, end(value) { body = value; } });
      return JSON.parse(body).result;
    };
    const call = async (name, args, error) => {
      const result = await rpc('tools/call', { name, arguments: { tabId: 'page', ...args } });
      if (error) { assert.equal(result.isError, true, JSON.stringify(result)); assert.match(result.content[0].text, error); return; }
      assert.ok(!result.isError, JSON.stringify(result));
      try { return JSON.parse(result.content[0].text); } catch { return result.content[0].text; }
    };
    const move = args => call('browser_move_pointer', args);
    const click = args => call('browser_click', args);
    const reset = async () => { commands.length = 0; await page.evaluate(() => { events.length = 0; }); };
    const events = () => page.evaluate(() => events);
    const definitions = (await rpc('tools/list')).tools;
    for (const name of ['browser_click', 'browser_move_pointer']) {
      const properties = definitions.find(t => t.name === name).inputSchema.properties;
      assert.ok(properties.mouseButton);
      assert.ok(!Object.hasOwn(properties, 'button'));
    }
    const tools = definitions.map(t => t.name);
    assert.ok(tools.includes('browser_move_pointer'));
    assert.ok(!tools.includes('browser_hover') && !tools.includes('browser_drag'));

    await move({ to: { selector: '#click' } });
    assert.ok((await events()).some(e => e.type === 'pointermove' && e.target === 'click' && e.trusted && e.buttons === 0));
    assert.ok(!(await events()).some(e => e.type === 'pointerdown'));
    await reset();
    const moved = await move({ from: { selector: '#handle' }, to: { x: 400, y: 175 }, mouseButton: 'left' });
    assert.equal(moved.mouseButton, 'left');
    assert.ok(!Object.hasOwn(moved, 'button'));
    assert.equal(await page.evaluate(() => handle.dataset.x), '400');
    const drag = await events();
    assert.ok(drag.filter(e => e.type.startsWith('pointer')).every(e => e.trusted));
    assert.equal(drag.filter(e => e.type === 'pointerdown').length, 1);
    assert.equal(drag.filter(e => e.type === 'pointerup').length, 1);
    assert.equal(commands.filter(c => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseMoved').length, 3);
    await move({ to: { x: 450, y: 175 } });
    assert.equal((await events()).filter(e => e.type === 'pointermove').at(-1).buttons, 0);

    await reset();
    await move({ from: { selector: '#source' }, to: { selector: '#destination' }, mouseButton: 'left' });
    assert.equal(await page.evaluate(() => drops), 1);
    assert.ok((await events()).some(e => e.type === 'drop' && e.trusted));

    await reset();
    const clicked = await click({ at: { x: 90, y: 55 }, mouseButton: 'right' });
    assert.equal(clicked.mouseButton, 'right');
    assert.ok(!Object.hasOwn(clicked, 'button'));
    assert.ok((await events()).some(e => e.type === 'contextmenu' && e.trusted && e.button === 2));
    await reset();
    await click({ at: { selector: '#click' }, mouseButton: 'middle' });
    assert.ok((await events()).some(e => e.type === 'auxclick' && e.trusted && e.button === 1));
    await reset();
    await click({ at: { selector: '#click' }, doubleClick: true });
    assert.equal((await events()).filter(e => e.type === 'click').length, 2);
    assert.ok((await events()).some(e => e.type === 'dblclick' && e.trusted));
    await reset();
    await click({ selector: '#click', modifiers: ['ctrl', 'shift'], delayMs: 100 });
    const held = await events();
    assert.ok(held.find(e => e.type === 'click').ctrl && held.find(e => e.type === 'click').shift);
    assert.ok(held.find(e => e.type === 'pointerup').time - held.find(e => e.type === 'pointerdown').time >= 90);
    const snap = await call('browser_get_snapshot', {});
    const uid = snap.match(/\[uid=(\d+)\].*Click target/)?.[1];
    assert.ok(uid, snap);
    await click({ at: { uid } });

    for (const args of [{ from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }, { to: { x: 2, y: 2 }, mouseButton: 'left' }])
      await call('browser_move_pointer', args, /both from and mouseButton/);
    await call('browser_move_pointer', { to: { selector: '#covered' } }, /obscured/);
    await call('browser_click', { at: { selector: '#hidden' } }, /offscreen or clipped/);
    await call('browser_click', { at: { x: 9000, y: 20 } }, /outside viewport/);
    await call('browser_click', { selector: '#click', at: { x: 20, y: 20 } }, /not both/);
    await call('browser_click', { selector: '#click', mouseButton: 'invalid' }, /mouseButton/);
    await call('browser_click', { selector: '#click', delayMs: -1 }, /delayMs/);
    await call('browser_click', { selector: '#click', doubleClick: 'yes' }, /boolean/);
    await call('browser_click', { selector: '#click', modifiers: ['invalid'] }, /modifiers/);
    await call('browser_click', { at: { selector: '#option' } }, /offscreen or clipped|geometry/);
    assert.equal(await page.evaluate(() => select.value), 'a'); // Failed hit-testing leaves the selected option unchanged.

    // Fixed targets escape overflow wrappers but remain clipped by transformed
    // containing blocks.
    await page.evaluate(() => {
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'width:30px;height:30px;overflow:hidden';
      wrapper.innerHTML = '<button id="fixed" style="position:fixed;left:700px;top:400px;width:100px;height:60px">Fixed</button>';
      document.body.append(wrapper);
      const transformed = wrapper.cloneNode(true);
      transformed.style.transform = 'translateX(0)';
      transformed.firstChild.id = 'clippedFixed';
      document.body.append(transformed);
    });
    assert.equal(await page.evaluate(() => document.elementFromPoint(750, 430).id), 'fixed');
    await reset();
    await move({ to: { selector: '#fixed' } });
    await click({ at: { selector: '#fixed' } });
    assert.ok((await events()).some(e => e.type === 'pointermove' && e.target === 'fixed' && e.trusted));
    assert.ok((await events()).some(e => e.type === 'click' && e.target === 'fixed' && e.trusted));
    await call('browser_move_pointer', { to: { selector: '#clippedFixed' } }, /clipped|obscured/);
    await call('browser_click', { at: { selector: '#clippedFixed' } }, /clipped|obscured/);

    // The browser accepted a press but its reply was lost. Cleanup must not click.
    await reset();
    fault = (method, params) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' ? 'after' : null;
    await call('browser_click', { at: { selector: '#click' } }, /lost reply/);
    fault = null;
    assert.equal((await events()).filter(e => e.type === 'click').length, 0);
    assert.ok(commands.some(c => c.method === 'Input.setIgnoreInputEvents' && c.params.ignore));
    await click({ at: { selector: '#click' } });
    assert.equal((await events()).filter(e => e.type === 'click').length, 1);

    // Error before release: no activation from the cancellation release.
    await reset();
    let releaseFailed = false;
    fault = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && !releaseFailed) { releaseFailed = true; return 'before'; }
    };
    await call('browser_click', { selector: '#click' }, /injected failure/);
    fault = null;
    assert.equal((await events()).filter(e => e.type === 'click').length, 0);
    assert.equal(commands.filter(c => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseReleased').length, 2);

    // Cleanup after a lost release reply must not duplicate the completed click.
    await reset();
    let released = false;
    fault = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && !released) { released = true; return 'after'; }
    };
    await call('browser_click', { selector: '#click' }, /lost reply/);
    fault = null;
    assert.equal((await events()).filter(e => e.type === 'click').length, 1);

    // Canceling an interrupted drag must not trigger a drop.
    await reset();
    let pressed = false;
    fault = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') pressed = true;
      if (pressed && method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') return 'before';
    };
    await call('browser_move_pointer', { from: { selector: '#source' }, to: { selector: '#destination' }, mouseButton: 'left' }, /injected failure/);
    fault = null;
    assert.equal(await page.evaluate(() => drops), 1);
    await move({ to: { x: 450, y: 175 } });
    assert.equal((await events()).filter(e => e.type === 'pointermove').at(-1).buttons, 0);

    // A held click rejects concurrent spatial gestures on the same tab.
    await reset();
    const pending = click({ selector: '#click', delayMs: 250 });
    await page.waitForFunction(() => events.some(e => e.type === 'pointerdown'));
    await call('browser_move_pointer', { to: { x: 450, y: 175 } }, /gesture is in progress/);
    await call('browser_scroll', { deltaX: 0, deltaY: 20 }, /gesture is in progress/);
    await pending;

    // Failed input suppression blocks release and subsequent spatial gestures.
    await reset();
    fault = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') return 'after';
      if (method === 'Input.setIgnoreInputEvents' && params.ignore) return 'before';
    };
    await call('browser_click', { selector: '#click' }, /cleanup failed/);
    fault = null;
    assert.equal(commands.filter(c => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseReleased').length, 0);
    assert.ok(commands.some(c => c.method === 'Input.setIgnoreInputEvents' && !c.params.ignore));
    await call('browser_move_pointer', { to: { x: 450, y: 175 } }, /fresh tab/);
  } finally { await browser.close(); }
});
