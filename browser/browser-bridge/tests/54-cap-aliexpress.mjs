// Capability test: AliExpress search renders products + product page loads.
//
// AliExpress has aggressive bot-mitigation including the "slide to verify"
// captcha. The UA-CH override + stealth setup should keep us under the
// radar for normal browsing. If the captcha appears, the test fails with
// a clear message — that's a signal something regressed in stealth.
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

const tab = await call('browser_open', { url: 'https://www.aliexpress.com/wholesale?SearchText=mechanical+keyboard' });
const tabId = tab.tabId;
await call('browser_wait_for', {
  tabId,
  expression: 'document.title.length > 0 && document.querySelectorAll("a[href*=\'/item/\']").length > 5',
  timeoutMs: 20000,
});

// `call` already auto-parses JSON returned by browser_evaluate.
const p = await call('browser_evaluate', {
  tabId,
  expression: 'JSON.stringify({title: document.title.slice(0,80), productCount: document.querySelectorAll("a[href*=\'/item/\']").length, captcha: !!document.querySelector("[id*=captcha], [class*=slidetounlock]"), firstHref: document.querySelector("a[href*=\'/item/\']")?.href})',
});
if (p.captcha) fail('cap-aliexpress', 'AliExpress served captcha — stealth setup may have regressed');
if (p.productCount < 5) fail('cap-aliexpress', 'expected ≥5 products, got ' + p.productCount);
if (!p.firstHref) fail('cap-aliexpress', 'no product href');

// Product page — strip query string to a clean canonical /item/<id>.html URL.
const itemMatch = p.firstHref.match(/\/item\/(\d+)\.html/);
if (!itemMatch) fail('cap-aliexpress', 'product href shape unexpected: ' + p.firstHref);
await call('browser_navigate', { tabId, url: 'https://www.aliexpress.com/item/' + itemMatch[1] + '.html' });
// Wait until the product page is more than just shell — body text and a
// recognisable currency symbol both present. AliExpress lazy-loads the
// price block, so just innerText.length isn't enough.
await call('browser_wait_for', {
  tabId,
  expression: 'document.body.innerText.length > 1000 && /(US\\s*\\$|CDN\\s*\\$|€|£|¥|\\$\\s?\\d)/.test(document.body.innerText)',
  timeoutMs: 25000,
});

const d = await call('browser_evaluate', {
  tabId,
  expression: 'JSON.stringify({url: location.href, hasPriceText: /(US\\s*\\$|CDN\\s*\\$|€\\s*\\d|£\\s*\\d|¥\\s*\\d|\\$\\s?\\d)/.test(document.body.innerText)})',
});
if (!d.url.includes('/item/')) fail('cap-aliexpress', 'product url not /item/...');
if (!d.hasPriceText) fail('cap-aliexpress', 'product page has no price text');

await call('browser_close_tab', { tabId });
pass('cap-aliexpress (search ≥5 products, no captcha; product page loads with price)');
process.exit(0);
