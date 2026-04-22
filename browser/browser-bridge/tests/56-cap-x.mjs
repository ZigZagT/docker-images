// Capability test: X (Twitter) public profile renders posts.
//
// X serves limited content to logged-out visitors but a public profile
// shows ~10 posts before the sign-up sidebar takes over. The agent can
// extract those posts even without auth. For deeper interaction, the
// realistic flow is browser_set_attention asking the user to log in.
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

// Use a stable, well-known public account that's been around for years.
// (@elonmusk and @anthropic both work; picking @elonmusk because @anthropic
// is held by an individual not the company.)
const tab = await call('browser_open', { url: 'https://x.com/elonmusk' });
const tabId = tab.tabId;
await call('browser_wait_for', {
  tabId,
  expression: 'document.body.innerText.length > 200',
  timeoutMs: 12000,
});

const probe = await call('browser_evaluate', {
  tabId,
  expression: 'JSON.stringify({url: location.href, articleCount: document.querySelectorAll("article").length, hasLogIn: /log in/i.test(document.body.innerText)})',
});
const p = JSON.parse(probe);
if (p.articleCount < 1) fail('cap-x', 'no article elements (timeline empty)');
if (!p.hasLogIn) fail('cap-x', 'expected sign-in prompt visible');

const snap = await call('browser_get_snapshot', { tabId });
const articleCount = (String(snap).match(/\] article/g) || []).length;
if (articleCount < 1) fail('cap-x', 'snapshot has no article entries: ' + articleCount);
if (!/Log in/i.test(snap)) fail('cap-x', 'snapshot missing Log in link');

await call('browser_close_tab', { tabId });
pass('cap-x (public profile renders ≥1 article + sign-in prompt visible)');
process.exit(0);
