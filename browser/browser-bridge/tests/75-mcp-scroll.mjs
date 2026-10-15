// MCP/CDP integration tests launch a dedicated headless Chromium process.
// Set PLAYWRIGHT_MODULE and CHROMIUM_PATH to override the local test binaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createMcpHandler } from '../mcp.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/usr/lib/node_modules/openclaw/node_modules/playwright-core');

test('native wheel, nested seeking, explicit javascript and inactive headless tabs', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/local/bin/chrome-raw', headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><style>
      body{margin:0;height:3200px} #nested{position:absolute;left:30px;top:30px;width:320px;height:200px;overflow:auto;border:2px solid}
      #content{width:1000px;height:1200px} #deep{position:relative;top:1000px;left:750px}
      #blocked{position:absolute;left:500px;top:30px;width:200px;height:180px;overflow:auto}
      #blocked>div{height:1000px} #blockedDeep{position:relative;top:850px}
      #bottom{position:absolute;top:2900px} #hidden{display:none}
      #below{position:absolute;left:20px;top:1800px;width:300px;height:200px;overflow:auto}
      #below>div{height:1000px} #belowDeep{position:relative;top:850px}
      </style><div id="nested"><div id="content"><button id="deep">Deep target</button></div></div>
      <div id="blocked"><div><button id="blockedDeep">Blocked</button></div></div>
      <div id="below"><div><button id="belowDeep">Below</button></div></div>
      <button id="bottom">Bottom</button><button id="hidden">Hidden</button>
      <script>window.wheels=[];document.addEventListener('wheel',e=>wheels.push({trusted:e.isTrusted,x:e.deltaX,y:e.deltaY,target:e.target.id}),true);
      blocked.addEventListener('wheel',e=>e.preventDefault(),{passive:false});</script>`);
    const viewer = await context.newPage();
    const sessions = new Map([['page', await context.newCDPSession(page)], ['viewer', await context.newCDPSession(viewer)]]);
    const commands = [];
    let failWheel = false;
    const deps = {
      sessionPool: new Map([...sessions.keys()].map(id => [id, { sessionId: id }])),
      poolAttach: async () => {}, ensureBrowserConnection: async () => {}, getCdpTargets: async () => [],
      viewedTarget: () => 'viewer', log: { error() {} },
      sessionCommand: async (sid, method, params) => {
        commands.push({ sid, method, params });
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel' && failWheel) return { error: { message: 'injected wheel failure' } };
        try { return { result: await sessions.get(sid).send(method, params) }; }
        catch (error) { return { error: { message: error.message } }; }
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
      if (error) { assert.equal(result.isError, true); assert.match(result.content[0].text, error); return; }
      assert.ok(!result.isError, JSON.stringify(result));
      try { return JSON.parse(result.content[0].text); } catch { return result.content[0].text; }
    };
    const scroll = args => call('browser_scroll', args);
    const seek = args => call('browser_scroll_into_view', args);
    const reset = () => page.evaluate(() => { window.scrollTo(0, 0); nested.scrollTo(0, 0); blocked.scrollTo(0, 0); below.scrollTo(0, 0); wheels.length = 0; });

    const tools = (await rpc('tools/list')).tools;
    assert.deepEqual(tools.find(t => t.name === 'browser_scroll').inputSchema.properties.method.enum, ['wheel', 'javascript']);
    await viewer.bringToFront(); // No screencast; target is inactive.
    const nested = await scroll({ deltaX: 140, deltaY: 260, at: { selector: '#nested' } });
    assert.equal(nested.method, 'wheel');
    assert.equal(nested.moved, true);
    assert.ok(await page.evaluate(() => nested.scrollTop > 0 && nested.scrollLeft > 0 && window.scrollY === 0));
    assert.ok(await page.evaluate(() => wheels.length > 0 && wheels.every(e => e.trusted)));
    assert.equal(commands.filter(c => c.method === 'Page.bringToFront').at(-1).sid, 'viewer');
    assert.ok(!commands.some(c => c.method === 'Page.startScreencast'));

    await reset();
    const root = await scroll({ deltaX: 0, deltaY: 350, at: { x: 900, y: 500 } });
    assert.equal(root.moved, true);
    assert.ok(await page.evaluate(() => window.scrollY > 0));
    await reset();
    const prevented = await scroll({ deltaX: 0, deltaY: 300, at: { selector: '#blocked' } });
    assert.equal(prevented.moved, false);
    assert.equal(await page.evaluate(() => blocked.scrollTop), 0);
    const n = await page.evaluate(() => wheels.length);
    const explicit = await scroll({ deltaX: 0, deltaY: 300, at: { selector: '#blocked' }, method: 'javascript' });
    assert.equal(explicit.method, 'javascript');
    assert.equal(explicit.moved, true);
    assert.equal(await page.evaluate(() => wheels.length), n);

    await reset();
    const deep = await seek({ selector: '#deep' });
    assert.equal(deep.visible, true);
    assert.equal(deep.moved, true);
    assert.ok(deep.steps > 0);
    assert.ok(await page.evaluate(() => nested.scrollTop > 0 && nested.scrollLeft > 0));
    await reset();
    const outside = await seek({ selector: '#belowDeep' });
    assert.equal(outside.visible, true);
    assert.ok(await page.evaluate(() => window.scrollY > 0 && below.scrollTop > 0));
    await reset();
    await call('browser_scroll_into_view', { selector: '#blockedDeep' }, /no progress/);
    await call('browser_scroll_into_view', { selector: '#bottom', maxSteps: 1 }, /maxSteps/);
    await reset();
    const jsSeek = await seek({ selector: '#blockedDeep', method: 'javascript' });
    assert.equal(jsSeek.visible, true);
    assert.equal(jsSeek.moved, true);
    assert.equal(await page.evaluate(() => wheels.length), 0);
    await reset();
    const snapshot = await call('browser_get_snapshot', {});
    const uid = snapshot.match(/\[uid=(\d+)\].*Bottom/)?.[1];
    assert.ok(uid, snapshot);
    assert.equal((await seek({ uid, method: 'javascript' })).visible, true);
    assert.equal((await seek({ uid, method: 'javascript' })).moved, false);
    await reset();
    await call('browser_scroll', { deltaX: 0, deltaY: 10, method: 'automatic' }, /method/);
    await call('browser_scroll', { deltaX: 0, deltaY: 10, at: { x: 20, y: 20, selector: '#nested' } }, /exactly one target/);
    await call('browser_scroll', { deltaX: 0, deltaY: 10, at: { x: -1, y: 20 } }, /outside viewport/);
    await call('browser_scroll_into_view', { selector: '#hidden' }, /no geometry/);
    await call('browser_scroll_into_view', { uid: 'missing' }, /Missing\/stale/);
    failWheel = true;
    const previous = await page.evaluate(() => window.scrollY);
    await call('browser_scroll', { deltaX: 0, deltaY: 300 }, /injected wheel failure/);
    assert.equal(await page.evaluate(() => window.scrollY), previous); // Wheel failure leaves the scroll position unchanged.
    assert.equal(commands.filter(c => c.method === 'Page.bringToFront').at(-1).sid, 'viewer');
    failWheel = false;
    // Fixed descendants escape overflow clips unless the ancestor is a containing block.
    await page.setContent(`<style>body{margin:0;height:2000px}.wrapper{width:30px;height:30px;overflow:hidden}
      button{position:fixed;left:300px;top:200px;width:100px;height:60px}
      #transformed{transform:translateX(0);position:absolute;top:350px}</style>
      <div class="wrapper"><button id="fixed">Visible fixed</button></div>
      <div class="wrapper" id="transformed"><button id="clippedFixed">Clipped fixed</button></div>`);
    assert.equal(await page.evaluate(() => document.elementFromPoint(350, 230).id), 'fixed');
    assert.equal((await seek({ selector: '#fixed' })).steps, 0);
    assert.equal((await scroll({ at: { selector: '#fixed' }, deltaX: 0, deltaY: 100 })).moved, true);
    await call('browser_scroll', { at: { selector: '#clippedFixed' }, deltaX: 0, deltaY: 100 }, /clipped|obscured/);
    await call('browser_scroll_into_view', { selector: '#clippedFixed', maxSteps: 2 }, /clipped|obscured|progress|maxSteps/);

    // Seeking accounts for an outer clip smaller than the inner scroller.
    await page.setContent(`<style>body{margin:0}#outer{width:300px;height:200px;overflow:hidden}
      #inner{width:300px;height:500px;overflow:auto}#content{height:1500px}
      #target{position:relative;top:400px}</style>
      <div id="outer"><div id="inner"><div id="content"><button id="target">Seek</button></div></div></div>`);
    const clippedSeek = await seek({ selector: '#target' });
    assert.equal(clippedSeek.visible, true);
    assert.ok(clippedSeek.steps > 0);
    assert.ok(await page.evaluate(() => inner.scrollTop > 0 && outer.scrollTop === 0));

    // Both methods report the actual open-shadow scroller offsets.
    await page.setContent('<style>body{margin:0}</style><div id="host"></div>');
    await page.evaluate(() => {
      host.attachShadow({ mode: 'open' }).innerHTML = '<div id="shadowScroller" style="width:300px;height:200px;overflow:auto"><div style="height:1500px">Shadow content</div></div>';
    });
    for (const method of ['wheel', 'javascript']) {
      await page.evaluate(() => host.shadowRoot.querySelector('#shadowScroller').scrollTop = 0);
      const result = await scroll({ at: { x: 100, y: 100 }, deltaX: 0, deltaY: 300, method });
      assert.equal(result.moved, true, method);
      const actual = await page.evaluate(() => host.shadowRoot.querySelector('#shadowScroller').scrollTop);
      assert.ok(actual > 0);
      assert.equal(result.before.find(el => el.id === 'shadowScroller').y, 0);
      assert.equal(result.after.find(el => el.id === 'shadowScroller').y, actual);
    }
    // A slotted light-DOM hit must traverse its assigned slot into the scroller.
    await page.evaluate(() => {
      host.shadowRoot.innerHTML = '<div id="slottedScroller" style="width:300px;height:200px;overflow:auto"><slot></slot></div>';
      host.innerHTML = '<div style="height:1500px">Slotted content</div>';
    });
    for (const method of ['wheel', 'javascript']) {
      await page.evaluate(() => host.shadowRoot.querySelector('#slottedScroller').scrollTop = 0);
      const result = await scroll({ at: { x: 100, y: 100 }, deltaX: 0, deltaY: 300, method });
      assert.equal(result.moved, true, method);
      assert.ok(result.after.find(el => el.id === 'slottedScroller').y > 0);
    }
  } finally { await browser.close(); }
});
