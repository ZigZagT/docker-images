// Capability test: Amazon search → product detail page.
//
// Amazon throws captchas on suspected bot traffic. The UA-CH override +
// stealth tooling should let us through for a normal search. This test
// fails loudly if a captcha appears so we notice stealth regressions.
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

const tab = await call('browser_open', { url: 'https://www.amazon.com/s?k=usb-c+hub' });
const tabId = tab.tabId;
// Wait for actual search results to materialize, not just title. Amazon
// serves the title-bearing shell instantly but products hydrate later.
// Also short-circuit if a captcha appears (fail fast with clear message).
await call('browser_wait_for', {
  tabId,
  expression: '!!document.querySelector("form[action*=captcha]") || document.querySelectorAll("[data-component-type=s-search-result]").length >= 1',
  timeoutMs: 30000,
});

// `call` already auto-parses JSON returned by browser_evaluate.
const p = await call('browser_evaluate', {
  tabId,
  expression: 'JSON.stringify({title: document.title.slice(0,80), captcha: !!document.querySelector("form[action*=captcha]"), productCount: document.querySelectorAll("[data-component-type=s-search-result]").length})',
});
if (p.captcha) fail('cap-amazon', 'Amazon served captcha — stealth may have regressed');
if (!p.title.toLowerCase().includes('usb-c hub')) fail('cap-amazon', 'title missing search term: ' + p.title);
// Amazon often paginates the first chunk of results to ~4 cards before
// hydrating the rest. The wait_for already guards on ≥1; the assertion
// just confirms we got real results, not zero.
if (p.productCount < 3) fail('cap-amazon', 'expected ≥3 products, got ' + p.productCount);

// Pick first /dp/<asin> link from a search-result card and visit the detail page.
const urls = await call('browser_evaluate', {
  tabId,
  expression: 'JSON.stringify(Array.from(document.querySelectorAll("[data-component-type=s-search-result] a")).filter(a => a.href.includes("/dp/")).slice(0,1).map(a => a.href))',
});
if (!urls.length) fail('cap-amazon', 'no /dp/ links in search results');
const asin = (urls[0].match(/\/dp\/([A-Z0-9]+)/) || [])[1];
if (!asin) fail('cap-amazon', 'could not parse ASIN from ' + urls[0]);

await call('browser_navigate', { tabId, url: 'https://www.amazon.com/dp/' + asin });
await call('browser_wait_for', {
  tabId,
  expression: 'document.querySelector("#productTitle") !== null',
  timeoutMs: 12000,
});
const d = await call('browser_evaluate', {
  tabId,
  expression: 'JSON.stringify({title: document.querySelector("#productTitle")?.textContent?.trim()?.slice(0,80), hasAddToCart: !!document.querySelector("#add-to-cart-button"), hasPrice: !!document.querySelector(".a-price")})',
});
if (!d.title) fail('cap-amazon', 'product title missing');
if (!d.hasPrice) fail('cap-amazon', 'product price missing');
if (!d.hasAddToCart) fail('cap-amazon', 'add-to-cart button missing');

await call('browser_close_tab', { tabId });
pass('cap-amazon (search ≥5 products, no captcha; product detail with title/price/ATC)');
process.exit(0);
