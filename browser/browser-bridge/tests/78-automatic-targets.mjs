import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createMcpHandler } from '../mcp.mjs';
import { createCdpPage, pass } from './helpers.mjs';

const page = await createCdpPage();
try {
  await page.setContent(`<!doctype html><style>
    body { margin:0; height:3200px; }
    #plain { position:absolute; left:30px; top:30px; }
    #partial { position:absolute; left:30px; top:120px; width:200px; height:60px; }
    #partialCover { position:absolute; left:100px; top:120px; width:60px; height:60px; background:red; z-index:2; }
    #nested { position:absolute; left:30px; top:250px; width:300px; height:180px; overflow:auto; border:2px solid; }
    #nestedContent { width:1000px; height:1200px; }
    #deep { position:relative; left:800px; top:1000px; }
    #stickyTarget { position:absolute; left:30px; top:900px; }
    #field { position:absolute; left:30px; top:1800px; }
    #choices { position:absolute; left:30px; top:2100px; }
    #host { position:absolute; left:30px; top:2400px; }
    #contents { display:contents; }
    #contentsChild { position:absolute; left:400px; top:30px; }
    #header { display:none; position:fixed; top:0; left:0; right:0; height:100px; background:gray; z-index:5; }
    #blocker { display:none; position:fixed; inset:0; background:gray; z-index:10; }
    #hidden { display:none; }
  </style>
  <button id="plain">Plain target</button>
  <button id="partial">Partially covered target</button><div id="partialCover"></div>
  <div id="nested"><div id="nestedContent"><button id="deep">Nested target</button></div></div>
  <button id="stickyTarget">Header-covered target</button>
  <input id="field" aria-label="Distant field" value="prefilled">
  <select id="choices" aria-label="Distant choices">
    <option value="a">Alpha</option><option value="same">First duplicate</option>
    <option value="b">Beta</option><option id="secondDuplicate" value="same">Second duplicate</option>
    <option id="disabledOption" value="disabled" disabled>Disabled</option>
    <option id="hiddenOption" value="hidden" hidden>Hidden</option>
  </select>
  <div id="host"></div>
  <div id="contents"><button id="contentsChild">Visible descendant</button></div>
  <div id="header"></div><div id="blocker"></div><button id="hidden">Hidden target</button>
  <script>
    window.events = [];
    for (const type of ['click','input','change','wheel','mousemove']) {
      document.addEventListener(type, e => window.events.push({type, target:e.target.id, trusted:e.isTrusted}), true);
    }
    contents.addEventListener('click', e => window.events.push({type:'contents-click', trusted:e.isTrusted}));
    blocker.addEventListener('wheel', e => e.preventDefault(), {passive:false});
    host.attachShadow({mode:'open'}).innerHTML =
      '<div id="shadowScroller" style="width:300px;height:180px;overflow:auto"><div style="height:1200px"><button style="position:relative;top:1000px">Shadow target</button></div></div>';
  </script>`);

  const commands = [];
  const deps = {
    sessionPool: new Map([['page', { sessionId: 'automatic-page' }]]),
    poolAttach: async () => {}, ensureBrowserConnection: async () => {},
    getCdpTargets: async () => [], log: { error() {} },
    async sessionCommand(sid, method, params) {
      commands.push({ method, params });
      try { return { result: await page.command(method, params) }; }
      catch (error) { return { error: { message: error.message } }; }
    },
  };
  const handler = createMcpHandler(deps);
  let id = 0;
  async function call(name, args) {
    const req = Readable.from([JSON.stringify({
      jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: { tabId: 'page', ...args } },
    })]);
    req.method = 'POST';
    let body;
    await handler(req, { writeHead() {}, end(value) { body = value; } });
    const response = JSON.parse(body);
    if (response.error) throw new Error(response.error.message);
    if (response.result.isError) throw new Error(response.result.content[0].text);
    const value = response.result.content[0].text;
    try { return JSON.parse(value); }
    catch { return value; }
  }
  const clear = () => page.evaluate(() => { window.events.length = 0; });
  const events = () => page.evaluate(() => window.events);

  await call('browser_click', { selector: '#plain' });
  assert.equal(await page.evaluate(() => scrollY), 0);
  assert.ok((await events()).some(e => e.type === 'click' && e.target === 'plain' && e.trusted));
  assert.ok(!(await events()).some(e => e.type === 'wheel'));

  await clear();
  const partial = await call('browser_click', { selector: '#partial' });
  assert.equal(await page.evaluate(() => scrollY), 0);
  assert.ok(partial.clickedAt.x < 100 || partial.clickedAt.x > 160);
  assert.ok((await events()).some(e => e.type === 'click' && e.target === 'partial' && e.trusted));
  assert.ok(!(await events()).some(e => e.type === 'wheel' || e.target === 'partialCover'));

  await clear();
  await call('browser_click', { selector: '#contents' });
  assert.ok((await events()).some(e => e.type === 'contents-click' && e.trusted));

  await clear();
  await call('browser_click', { selector: '#deep' });
  assert.ok(await page.evaluate(() => nested.scrollTop > 0 && nested.scrollLeft > 0 && scrollY === 0));
  assert.ok((await events()).some(e => e.type === 'click' && e.target === 'deep' && e.trusted));
  assert.ok((await events()).some(e => e.type === 'wheel' && e.trusted));

  await page.evaluate(() => { window.scrollTo(0, 1800); nested.scrollTop = 0; });
  const scrolled = await call('browser_scroll', { at: { selector: '#nested' }, deltaX: 0, deltaY: 100 });
  assert.equal(scrolled.moved, true);
  assert.ok(scrolled.revealed?.before && scrolled.revealed?.after);
  assert.ok(await page.evaluate(() => nested.scrollTop > 0 && scrollY < 1800));

  await page.evaluate(() => { header.style.display = 'block'; window.scrollTo(0, 900); });
  await clear();
  await call('browser_click', { selector: '#stickyTarget' });
  assert.ok(await page.evaluate(() => scrollY < 900));
  assert.ok((await events()).some(e => e.type === 'click' && e.target === 'stickyTarget' && e.trusted));
  assert.ok(!(await events()).some(e => e.type === 'click' && e.target === 'header'));
  await page.evaluate(() => { header.style.display = 'none'; window.scrollTo(0, 0); });

  await clear();
  await call('browser_type', { selector: '#field', text: 'replacement', replace: true });
  assert.equal(await page.evaluate(() => field.value), 'replacement');
  assert.ok(await page.evaluate(() => scrollY > 0));
  assert.ok((await events()).some(e => e.type === 'input' && e.target === 'field' && e.trusted));

  await page.evaluate(() => window.scrollTo(0, 0));
  await clear();
  const selected = await call('browser_select', { selector: '#choices', values: ['b'] });
  assert.deepEqual(selected.selectedValues, ['b']);
  assert.equal(await page.evaluate(() => choices.value), 'b');
  assert.ok((await events()).some(e => e.type === 'change' && e.target === 'choices' && e.trusted));

  await page.evaluate(() => window.scrollTo(0, 0));
  await clear();
  const option = await call('browser_click', { selector: '#secondDuplicate' });
  assert.equal(option.method, 'keyboard');
  assert.equal(await page.evaluate(() => choices.selectedIndex), 3, 'option fallback must preserve identity, not choose the first duplicate value');
  assert.ok((await events()).some(e => e.type === 'change' && e.target === 'choices' && e.trusted));
  await assert.rejects(call('browser_click', { selector: '#disabledOption' }), /disabled/);
  await assert.rejects(call('browser_click', { selector: '#hiddenOption' }), /hidden/);
  assert.equal(await page.evaluate(() => choices.selectedIndex), 3);

  const snapshot = await call('browser_get_snapshot', {});
  const uid = snapshot.match(/\[uid=(\d+)\].*Shadow target/)?.[1];
  assert.ok(uid, snapshot);
  await call('browser_click', { uid });
  assert.ok(await page.evaluate(() => host.shadowRoot.querySelector('#shadowScroller').scrollTop > 0));

  await page.evaluate(() => window.scrollTo(0, 0));
  const moved = await call('browser_move_pointer', { to: { selector: '#field' } });
  assert.ok(await page.evaluate(() => scrollY > 0));
  assert.ok(moved.movedTo.y >= 0 && moved.movedTo.y < 700);

  await page.evaluate(() => { window.scrollTo(0, 0); blocker.style.display = 'block'; });
  await clear();
  await assert.rejects(call('browser_click', { selector: '#plain' }), /safely reveal|prevented|no progress/);
  assert.ok(!(await events()).some(e => e.type === 'click'), 'must not click a modal or force-click its covered target');
  await page.evaluate(() => { blocker.style.display = 'none'; });

  await page.evaluate(() => { blocker.style.display = 'block'; setTimeout(() => { blocker.style.display = 'none'; }, 150); });
  await call('browser_click', { selector: '#plain' });
  await assert.rejects(call('browser_click', { selector: '#hidden' }), /hidden|no geometry/);
  assert.ok(!commands.some(command => ['DOM.scrollIntoViewIfNeeded', 'DOM.focus'].includes(command.method)));
  pass('automatic-targets (exposed points, nested/automatic scrolling, shadow roots, native option fallback, blockers)');
} finally {
  await page.close();
}
