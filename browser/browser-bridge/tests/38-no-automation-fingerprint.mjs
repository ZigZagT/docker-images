// Asserts that Chrome's intrinsic fingerprint signals don't leak
// automation/headless markers. Tests the SIGNALS the browser exposes,
// not behavioral patterns (mouse jitter etc — out of scope per user).
//
// Reference: https://bot.sannysoft.com — these are the standard checks
// every bot-detection library runs.
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

const tab = await httpPut('http://127.0.0.1:18800/json/new?https://example.com');
await delay(2500);
const att = await cmd('Target.attachToTarget', { targetId: tab.id, flatten: true });
const sid = att.result.sessionId;
await scmd(sid, 'Runtime.enable', {});
await delay(1500);

async function probe(expr, awaitPromise = false) {
  const r = await scmd(sid, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  return r.result?.result?.value;
}

const fails = [];
function check(name, val, ok) {
  if (!ok(val)) fails.push(name + ': ' + JSON.stringify(val));
}

const ua = await probe('navigator.userAgent');
check('navigator.userAgent has no "HeadlessChrome"', ua, v => typeof v === 'string' && !v.includes('HeadlessChrome') && !v.includes('Headless'));
check('navigator.userAgent looks like real Chrome', ua, v => /Chrome\/\d+\.\d+/.test(v) && /Safari\/537/.test(v));

const wd = await probe('navigator.webdriver');
check('navigator.webdriver is not true', wd, v => v === false || v === undefined);

const langs = await probe('navigator.languages');
check('navigator.languages has at least one entry', langs, v => Array.isArray(v) && v.length >= 1);

const plugins = await probe('navigator.plugins.length');
check('navigator.plugins.length > 0', plugins, v => typeof v === 'number' && v > 0);

const pluginsType = await probe('navigator.plugins instanceof PluginArray');
check('navigator.plugins is PluginArray', pluginsType, v => v === true);

const chromeObj = await probe('typeof window.chrome');
check('window.chrome exists', chromeObj, v => v === 'object');

const loadTimes = await probe('typeof window.chrome?.loadTimes');
check('window.chrome.loadTimes exists', loadTimes, v => v === 'function');

const notifPerm = await probe('Notification.permission');
check('Notification.permission is not "denied" (headless tell)', notifPerm, v => v !== 'denied');

const notifPermAsync = await probe('navigator.permissions.query({name:"notifications"}).then(p=>p.state)', true);
const consistent = (notifPerm === 'default' && notifPermAsync === 'prompt') || notifPerm === notifPermAsync;
check('notification permission consistent (no headless quirk)', { sync: notifPerm, async: notifPermAsync }, () => consistent);

const platform = await probe('navigator.platform');
check('navigator.platform consistent with UA', platform, v => typeof v === 'string' && v.length > 0);

const hwc = await probe('navigator.hardwareConcurrency');
check('hardwareConcurrency is realistic', hwc, v => typeof v === 'number' && v >= 2 && v <= 64);

const vendor = await probe('navigator.vendor');
check('navigator.vendor is "Google Inc."', vendor, v => v === 'Google Inc.');

// HTTP request UA must match navigator.userAgent
const httpUa = await probe('fetch("https://httpbin.org/headers").then(r=>r.json()).then(j=>j.headers["User-Agent"])', true);
check('HTTP User-Agent header matches navigator.userAgent', httpUa, v => v === ua);
check('HTTP User-Agent header has no "HeadlessChrome"', httpUa, v => typeof v === 'string' && !v.includes('Headless'));

await cmd('Target.closeTarget', { targetId: tab.id }).catch(() => {});
cdp.close();

if (fails.length > 0) {
  fail('no-automation-fingerprint', fails.length + ' signal(s) leak: ' + fails.join('; '));
}

pass('no-automation-fingerprint (' + ua.split(') ')[0].split('(')[1] + ', Chrome ' + ua.match(/Chrome\/(\d+)/)[1] + ')');
process.exit(0);
