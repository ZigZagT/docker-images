// Capability test: Steam search → click → product page works.
//
// Uses Hollow Knight (a non-age-gated, well-known title) so the test
// isn't blocked by Steam's mature-content interstitial.
import http from 'http';
import { delay, pass, fail } from './helpers.mjs';

function rpc(method, params) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params });
    const req = http.request('http://127.0.0.1:6080/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    }, r => { let buf = ''; r.on('data', c => buf += c); r.on('end', () => { try { res(JSON.parse(buf)); } catch { rej(new Error(buf.slice(0,200))); } }); });
    req.on('error', rej); req.write(body); req.end();
  });
}
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) throw new Error(r.error.message);
  if (r.result?.isError) throw new Error(r.result.content?.[0]?.text || 'tool error');
  const t = r.result?.content?.[0]?.text;
  try { return JSON.parse(t); } catch { return t; }
}
function findUid(snapshot, role, namePattern) {
  const re = namePattern instanceof RegExp ? namePattern : new RegExp(namePattern);
  for (const line of String(snapshot).split('\n')) {
    const m = line.match(/\[uid=(\d+)\] (\w+)(?: "([^"]*)")?/);
    if (m && m[2] === role && re.test(m[3] || '')) return m[1];
  }
  return null;
}

const tab = await call('browser_open', { url: 'https://store.steampowered.com/search/?term=hollow+knight' });
const tabId = tab.tabId;
const snap = await call('browser_get_snapshot', { tabId });

// First Hollow Knight result link (with price).
const linkUid = findUid(snap, 'link', /^Hollow Knight\b/);
if (!linkUid) fail('cap-steam', 'no Hollow Knight link in search results');

await call('browser_click', { tabId, uid: linkUid });
await call('browser_wait_for', {
  tabId,
  expression: 'location.href.includes("/app/") && document.title.toLowerCase().includes("hollow knight")',
  timeoutMs: 8000,
});

const detail = await call('browser_evaluate', {
  tabId,
  expression: 'JSON.stringify({url: location.href, title: document.title, h2: document.querySelector(".apphub_AppName")?.textContent?.trim()})',
});
const d = JSON.parse(detail);
if (!/\/app\/\d+\//.test(d.url)) fail('cap-steam', 'product url not /app/<id>/...; got ' + d.url);
if (!d.h2 || !d.h2.toLowerCase().includes('hollow knight')) {
  fail('cap-steam', 'product page apphub name wrong: ' + d.h2);
}

await call('browser_close_tab', { tabId });
pass('cap-steam (search → click product → /app/<id>/ store page with title)');
process.exit(0);
