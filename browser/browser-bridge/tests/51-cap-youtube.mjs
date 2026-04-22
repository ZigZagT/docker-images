// Capability test: YouTube search results render with video cards.
//
// YouTube serves a stripped consent-gated homepage to headless agents,
// but the /results URL bypasses that and renders a real video grid.
// This is the realistic agent workflow — go straight to search rather
// than fighting the consent UI.
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

const tab = await call('browser_open', { url: 'https://www.youtube.com/results?search_query=puppeteer+vs+playwright' });
const tabId = tab.tabId;

// Wait for the video grid to populate. ytd-video-renderer is YouTube's
// video card custom element.
await call('browser_wait_for', {
  tabId,
  expression: 'document.querySelectorAll("ytd-video-renderer").length >= 5',
  timeoutMs: 15000,
});

const data = await call('browser_evaluate', {
  tabId,
  expression: 'JSON.stringify({title: document.title, count: document.querySelectorAll("ytd-video-renderer").length, firstVideoTitle: document.querySelector("ytd-video-renderer #video-title")?.textContent?.trim()?.slice(0,80)})',
});
const d = JSON.parse(data);
if (!d.title.toLowerCase().includes('puppeteer')) {
  fail('cap-youtube', 'title missing search term: ' + d.title);
}
if (d.count < 5) fail('cap-youtube', 'expected ≥5 video cards, got ' + d.count);
if (!d.firstVideoTitle) fail('cap-youtube', 'first video has no title');

// Snapshot includes the search role + at least 5 video headings.
const snap = await call('browser_get_snapshot', { tabId });
const headingCount = (String(snap).match(/\] heading/g) || []).length;
if (headingCount < 5) fail('cap-youtube', 'snapshot has too few headings: ' + headingCount);
if (!/search/i.test(snap)) fail('cap-youtube', 'snapshot missing search landmark');

await call('browser_close_tab', { tabId });
pass('cap-youtube (search results render ≥5 video cards via /results URL)');
process.exit(0);
