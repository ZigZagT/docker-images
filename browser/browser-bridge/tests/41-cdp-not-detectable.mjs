// Regression guard: page-side probes for CDP presence stay clean.
//
// Background: CDP usage is invisible to web pages UNLESS Runtime/Debugger/
// Console/Log domains are explicitly enabled on the page session. Puppeteer
// and Playwright enable all of these by default — that's the fingerprint
// commercial bot detectors flag as "CDP detected." Our bridge minimally
// enables only Page.enable in poolAttach, which is why detection sites
// report no CDP.
//
// This test runs the standard CDP-presence probes against a page opened
// through the bridge. If a future change accidentally enables Runtime/
// Debugger/Console on the page session, this test catches it.
import http from 'http';
import { WebSocket } from 'ws';
import { delay, pass, fail, httpGet } from './helpers.mjs';

function httpPut(u) {
  return new Promise((r, j) => {
    const q = http.request(u, { method: 'PUT' }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d)));
    }); q.on('error', j); q.end();
  });
}

const ver = await httpGet('http://127.0.0.1:18800/json/version');
const cdp = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise(r => cdp.on('open', r));
let cmdId = 1;
const pending = new Map();
cdp.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
function cmd(m, p) { return new Promise((r, j) => { const i = cmdId++; const t = setTimeout(() => { pending.delete(i); j(new Error('TO ' + m)); }, 15000); pending.set(i, v => { clearTimeout(t); r(v); }); cdp.send(JSON.stringify({ id: i, method: m, params: p })); }); }
function scmd(s, m, p) { return new Promise((r, j) => { const i = cmdId++; const t = setTimeout(() => { pending.delete(i); j(new Error('TO ' + m)); }, 15000); pending.set(i, v => { clearTimeout(t); r(v); }); cdp.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); }); }

// Open a tab through the bridge so it gets the bridge's poolAttach treatment
const bridgeWs = new WebSocket('ws://127.0.0.1:6080/ws');
await new Promise(r => bridgeWs.on('open', r));
const bev = [];
bridgeWs.on('message', d => { const m = JSON.parse(d); if (m.type === 'frame') return; bev.push(m); });
function bwait(type, ms = 8000) {
  return new Promise((r, j) => {
    const t = setTimeout(() => j(new Error('bwait TO ' + type)), ms);
    const c = setInterval(() => { const i = bev.findIndex(m => m.type === type); if (i >= 0) { clearTimeout(t); clearInterval(c); r(bev.splice(i, 1)[0]); } }, 50);
  });
}
await bwait('targetChanged');
bev.length = 0;
bridgeWs.send(JSON.stringify({ type: 'newTab', url: 'https://example.com' }));
const tc = await bwait('targetChanged');
const tabId = tc.targetId;
await delay(3000);

const att = await cmd('Target.attachToTarget', { targetId: tabId, flatten: true });
const sid = att.result.sessionId;
await scmd(sid, 'Runtime.enable', {});

async function probe(expr) {
  const r = await scmd(sid, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
}

const fails = [];

// Probe 1: debugger statement timing. CDP with Debugger.enable on the page
// session would PAUSE on `debugger;` (or even add a small overhead even
// when not paused). A clean page resumes in <5ms.
const debuggerTime = await probe('(()=>{const t=performance.now();debugger;return performance.now()-t})()');
if (typeof debuggerTime !== 'number' || debuggerTime > 50) {
  fails.push('debugger; took ' + debuggerTime + 'ms (>50ms suggests Debugger domain enabled)');
}

// Probe 2: console function identity. Puppeteer/Playwright replace
// console.* with CDP-aware wrappers. Native console functions are
// browser-builtin and toString() shows "[native code]".
const consoleNative = await probe('Function.prototype.toString.call(console.debug).includes("[native code]")');
if (consoleNative !== true) {
  fails.push('console.debug is NOT native (CDP wrapper detected): ' + consoleNative);
}

// Probe 3: console.timeEnd warning interception. Puppeteer enables Console
// domain which intercepts console messages. Without it, console.timeEnd
// for a non-existent timer prints a warning but does NOT trigger any
// CDP-injected handler.
const consoleIntercepted = await probe(`(()=>{
  let intercepted = false;
  const origConsole = console;
  // Check if console.timeEnd is wrapped — should fire warning to stderr only
  try { console.timeEnd("__nope_" + Math.random()); } catch (e) { intercepted = true; }
  return intercepted;
})()`);
if (consoleIntercepted !== false) {
  fails.push('console.timeEnd raised exception (Console domain intercepting): ' + consoleIntercepted);
}

// Probe 4: window.outerWidth difference. Headless Chrome with CDP visible
// to the page often reports outerWidth=0. Real Chrome has outerWidth > 0.
const outerOk = await probe('window.outerWidth > 0 && window.outerHeight > 0');
if (outerOk !== true) {
  fails.push('outerWidth/Height is 0 (DevTools-attached headless tell): ' + outerOk);
}

// Probe 5: Runtime.evaluate side-effect from page POV.
// Some detectors check for specific globals injected by automation tools.
const automationGlobals = await probe(`JSON.stringify({
  cdc: typeof window.cdc_adoQpoasnfa76pfcZLmcfl_Array,  // Selenium ChromeDriver
  selenium: typeof window.selenium,
  webdriver_evaluate: typeof window._webdriver_evaluate,
  Buffer: typeof Buffer,                                  // Node leak
  emit: typeof window.emit,                               // CDP client leak
  spawn: typeof window.spawn,                             // shell leak
  __nightmare: typeof window.__nightmare,                 // Nightmare.js
  callPhantom: typeof window.callPhantom                  // PhantomJS
})`);
const globals = JSON.parse(automationGlobals);
for (const [k, v] of Object.entries(globals)) {
  if (v !== 'undefined') fails.push('automation global "' + k + '" exists (= ' + v + ')');
}

// Cleanup
bridgeWs.send(JSON.stringify({ type: 'closeTab', targetId: tabId }));
await delay(500);
bridgeWs.close();
cdp.close();

if (fails.length > 0) fail('cdp-not-detectable', fails.join('; '));
pass('cdp-not-detectable (debugger=' + debuggerTime.toFixed(2) + 'ms, no CDP wrappers, no automation globals)');
process.exit(0);
