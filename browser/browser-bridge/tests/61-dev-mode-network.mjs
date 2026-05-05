// Dev mode network request capture.
// Verifies: requests are logged, filter works, response body retrieval works.
import http from 'http';
import { delay, pass, fail } from './helpers.mjs';

function rpc(method, params, id = Math.floor(Math.random() * 1e9)) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const req = http.request('http://127.0.0.1:6080/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
    }, r => { let buf = ''; r.on('data', c => buf += c); r.on('end', () => { try { res(JSON.parse(buf)); } catch { rej(new Error(buf)); } }); });
    req.on('error', rej); req.write(body); req.end();
  });
}

async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = r.result?.content?.[0]?.text;
  if (r.result?.isError) throw new Error(t);
  return t ? JSON.parse(t) : null;
}

// Setup: navigate to a page that will make a sub-request
const opened = await call('browser_open', { url: 'about:blank' });
const tabId = opened.tabId;
await call('browser_set_dev_mode', { tabId, enabled: true });

// Navigate to example.com to generate network traffic
await call('browser_navigate', { tabId, url: 'https://example.com' });
await delay(2000);

// Get network requests
const net = await call('browser_get_network_requests', { tabId });
if (!Array.isArray(net.requests)) fail('dev-mode-network', 'missing requests array');
if (net.requests.length === 0) fail('dev-mode-network', 'no network requests captured');

// There should be at least the main document request
const docReq = net.requests.find(r => r.url.includes('example.com') && r.method === 'GET');
if (!docReq) fail('dev-mode-network', 'missing document request for example.com');
if (docReq.status !== 200) fail('dev-mode-network', 'document request status not 200: ' + docReq.status);

// Test filter
const filtered = await call('browser_get_network_requests', { tabId, filter: { method: 'POST' } });
if (filtered.requests.some(r => r.method !== 'POST')) {
  fail('dev-mode-network', 'filter by method did not work');
}

// Get response body
if (docReq.done) {
  const body = await call('browser_get_network_response', { tabId, requestId: docReq.requestId });
  if (!body.body || !body.body.includes('Example Domain')) {
    fail('dev-mode-network', 'response body missing expected content');
  }
}

// Cleanup
await call('browser_close_tab', { tabId });
pass('dev-mode-network');
process.exit(0);
