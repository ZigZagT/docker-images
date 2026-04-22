// Capability test: GitHub end-to-end search workflow.
//
// Why this exists: GitHub is one of the harder MCP targets — extensive
// JS, modal-based search, and detection bots that protect search APIs.
// This test exercises the full open → snapshot → click → type → Enter →
// snapshot result chain that an agent would walk to find a repo.
//
// Pass criteria: snapshot includes the search button + footer landmarks;
// search submission lands on /search?q=... ; result snapshot includes a
// repo heading; clicking the repo link lands on a /<owner>/<repo> page.
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
  const lines = String(snapshot).split('\n');
  for (const line of lines) {
    const m = line.match(/\[uid=(\d+)\] (\w+)(?: "([^"]*)")?/);
    if (m && m[2] === role && re.test(m[3] || '')) return m[1];
  }
  return null;
}

const tab = await call('browser_open', { url: 'https://github.com' });
const tabId = tab.tabId;
const initial = await call('browser_get_snapshot', { tabId });
const searchUid = findUid(initial, 'button', /Search or jump to/);
if (!searchUid) fail('cap-github', 'no search button in initial snapshot');

await call('browser_click', { tabId, uid: searchUid });
await delay(500);

// After click the search modal is open with a focused combobox; type+Enter.
await call('browser_type', { tabId, text: 'anthropic claude-code' });
await call('browser_press_key', { tabId, key: 'Enter' });
await delay(2500);

const results = await call('browser_evaluate', { tabId, expression: 'JSON.stringify({url: location.href, hasResults: document.querySelectorAll("a[href*=\'/anthropics\']").length > 0})' });
const r = JSON.parse(results);
if (!r.url.includes('/search?q=')) fail('cap-github', 'search did not navigate to /search?q=...; url=' + r.url);
if (!r.hasResults) fail('cap-github', 'search results missing anthropics repo links');

// Snapshot result page; pick a repo heading (any) and click it.
const resultsSnap = await call('browser_get_snapshot', { tabId });
// Find the first repo link — the snapshot shows: heading "owner/name" / link "owner/name"
const repoLinkUid = findUid(resultsSnap, 'link', /^anthropics\//);
if (!repoLinkUid) fail('cap-github', 'no anthropics/* repo link in search results snapshot');
await call('browser_click', { tabId, uid: repoLinkUid });
await delay(2000);
const final = await call('browser_evaluate', { tabId, expression: 'JSON.stringify({url: location.href, title: document.title})' });
const f = JSON.parse(final);
if (!f.url.includes('github.com/anthropics/')) fail('cap-github', 'repo click did not land on /anthropics/...; url=' + f.url);

await call('browser_close_tab', { tabId });
pass('cap-github (open → search modal → type+Enter → click result → real repo page)');
process.exit(0);
