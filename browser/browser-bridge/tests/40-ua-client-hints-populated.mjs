// UA Client Hints high-entropy values must be populated.
//
// Background: passing --user-agent="..." to Chrome strips Chrome's ability
// to populate UA-CH high-entropy fields (architecture/bitness/uaFullVersion/
// fullVersionList all become empty), because the flat string override
// carries no version metadata. Detectors that read UA-CH (modern bot
// detection like rebrowser-bot-detector) report "Cannot detect Chrome
// version" — a meaningful tell.
//
// Fix: bridge applies CDP Network.setUserAgentOverride per session with
// userAgentMetadata derived from the chrome-ua file + dpkg arch. The CDP
// override populates UA-CH while keeping the same UA string.
//
// This test asserts the populated state. Without the fix it FAILS because
// of the --user-agent flag; with the bridge's CDP override applied it PASSES.
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

// userAgentData is HTTPS-only. Open an HTTPS page so the API is available.
// Open via the BRIDGE so the bridge's per-session CDP override gets applied —
// raw CDP would bypass the bridge.
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

// Now attach our own CDP session to that tab and query UA-CH
const att = await cmd('Target.attachToTarget', { targetId: tabId, flatten: true });
const sid = att.result.sessionId;
await scmd(sid, 'Runtime.enable', {});

const r = await scmd(sid, 'Runtime.evaluate', {
  expression: 'navigator.userAgentData.getHighEntropyValues(["fullVersionList","uaFullVersion","architecture","bitness","platformVersion"]).then(v=>JSON.stringify(v))',
  awaitPromise: true,
  returnByValue: true
});
const hev = JSON.parse(r.result?.result?.value || '{}');

const ua = (await scmd(sid, 'Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })).result?.result?.value;

// Brands ↔ UA cross-check probes — must run BEFORE cleanup closes CDP.
const brandList = (await scmd(sid, 'Runtime.evaluate', {
  expression: 'JSON.stringify(navigator.userAgentData.brands || [])',
  returnByValue: true,
})).result?.result?.value;
const brands = JSON.parse(brandList || '[]');

// Cleanup
bridgeWs.send(JSON.stringify({ type: 'closeTab', targetId: tabId }));
await delay(500);
bridgeWs.close();
cdp.close();

const fails = [];
function check(name, ok, val) { if (!ok) fails.push(name + ' = ' + JSON.stringify(val)); }

check('uaFullVersion populated', !!hev.uaFullVersion, hev.uaFullVersion);
check('uaFullVersion looks like version', /^\d+\.\d+\.\d+\.\d+$/.test(hev.uaFullVersion || ''), hev.uaFullVersion);
check('architecture populated (x86 or arm)', /^(x86|arm)$/.test(hev.architecture || ''), hev.architecture);
check('bitness populated (32 or 64)', /^(32|64)$/.test(hev.bitness || ''), hev.bitness);
check('fullVersionList populated', Array.isArray(hev.fullVersionList) && hev.fullVersionList.length > 0, hev.fullVersionList);
check('UA still has no Headless marker', typeof ua === 'string' && !ua.includes('Headless'), ua);

// Brands ↔ UA consistency. Detectors flag "Chrome/X" UA paired with a
// brands list that omits "Google Chrome" as Chrome-for-Testing (the
// rebrowser-bot-detector message: "Google Chrome is not presented in
// navigator.userAgentData. You might be using Google Chrome for Testing
// which is a red flag"). If we claim Chrome in the UA token, we must
// claim Google Chrome in brands.
const brandNames = brands.map(b => b.brand);
const uaClaimsChrome = /\bChrome\/\d/.test(ua);
if (uaClaimsChrome) {
  check('brands includes Google Chrome (UA claims Chrome/X)',
    brandNames.includes('Google Chrome'), brandNames);
}
check('brands includes Chromium', brandNames.includes('Chromium'), brandNames);
// Full version list must mirror the short brands list — same names, same
// count. A mismatch (e.g. Google Chrome in brands but missing in
// fullVersionList) would also tip off detectors that compare the two.
const fullBrandNames = (hev.fullVersionList || []).map(b => b.brand);
for (const name of brandNames) {
  check('fullVersionList mirrors brand "' + name + '"',
    fullBrandNames.includes(name), fullBrandNames);
}

if (fails.length > 0) fail('ua-client-hints-populated', fails.join('; '));

pass('ua-client-hints-populated (uaFullVersion=' + hev.uaFullVersion + ', arch=' + hev.architecture + '/' + hev.bitness + ', brands=[' + brandNames.join(',') + '])');
process.exit(0);
