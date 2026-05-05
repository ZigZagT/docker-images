// MCP /mcp endpoint smoke test.
//
// Verifies the streamable-HTTP MCP protocol surface: initialize handshake,
// tools/list, and a handful of tools/call invocations against the live
// bridge. Stops short of the detector probe (heavy I/O) — just exercises
// the wire format + each tool's happy path so a regression in mcp.mjs
// fails CI before anyone configures an agent.
import http from 'http';
import { pass, fail } from './helpers.mjs';

function rpc(method, params, id = Math.floor(Math.random() * 1e9)) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const req = http.request('http://127.0.0.1:6080/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
      },
    }, r => {
      let buf = '';
      r.on('data', c => buf += c);
      r.on('end', () => {
        if (r.statusCode === 202) return res({ status: 202 });
        try { res({ status: r.statusCode, json: JSON.parse(buf) }); }
        catch { rej(new Error('non-JSON response: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', rej);
    req.write(body);
    req.end();
  });
}

// 1. initialize must return the spec'd handshake shape.
const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test-client', version: '0.0.0' },
});
if (init.json?.result?.protocolVersion !== '2025-06-18') {
  fail('mcp-endpoint', 'initialize wrong protocolVersion: ' + JSON.stringify(init.json));
}
if (init.json?.result?.serverInfo?.name !== 'browser-bridge') {
  fail('mcp-endpoint', 'initialize missing serverInfo: ' + JSON.stringify(init.json));
}
if (!init.json?.result?.capabilities?.tools) {
  fail('mcp-endpoint', 'initialize missing tools capability: ' + JSON.stringify(init.json));
}

// 2. notifications/initialized — server MUST return 202 with no body.
const notif = await rpc('notifications/initialized', {}, undefined);
if (notif.status !== 202) fail('mcp-endpoint', 'notification not 202: ' + notif.status);

// 3. tools/list must include every tool we expect.
const list = await rpc('tools/list', {});
const expected = ['browser_list_tabs', 'browser_navigate', 'browser_open',
                  'browser_reload', 'browser_close_tab',
                  'browser_get_snapshot', 'browser_get_text', 'browser_evaluate',
                  'browser_get_html', 'browser_click', 'browser_type',
                  'browser_press_key', 'browser_scroll', 'browser_scroll_into_view',
                  'browser_screenshot', 'browser_wait_for',
                  'browser_set_attention', 'browser_dismiss_attention',
                  'browser_set_dev_mode', 'browser_get_console_logs',
                  'browser_set_dialog_handler', 'browser_get_pending_dialog',
                  'browser_handle_dialog', 'browser_get_popup_log',
                  'browser_get_network_requests', 'browser_get_network_response',
                  'browser_list_frames', 'browser_navigate_frame'];
const got = (list.json?.result?.tools || []).map(t => t.name);
for (const name of expected) {
  if (!got.includes(name)) fail('mcp-endpoint', 'missing tool: ' + name + '; have ' + got.join(','));
}

// 3b. initialize response carries server-level instructions so agents
// learn ownership/FIFO/attention patterns at handshake.
const init2 = await rpc('initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' },
});
const instr = init2.json?.result?.instructions || '';
if (!instr.includes('FIFO') || !instr.includes('attention') || !instr.includes('browser_open')) {
  fail('mcp-endpoint', 'initialize missing/incomplete instructions field');
}

// 4. browser_open creates a tab and returns the resolved URL.
const nav = await rpc('tools/call', {
  name: 'browser_open',
  arguments: { url: 'https://example.com' },
});
const navText = nav.json?.result?.content?.[0]?.text || '';
let navResult;
try { navResult = JSON.parse(navText); }
catch { fail('mcp-endpoint', 'open non-JSON content: ' + navText); }
if (!navResult.tabId) fail('mcp-endpoint', 'open missing tabId: ' + navText);
if (!navResult.url?.includes('example')) fail('mcp-endpoint', 'open wrong URL: ' + navText);
const tabId = navResult.tabId;

// 5. browser_evaluate runs JS and returns the value.
const evalR = await rpc('tools/call', {
  name: 'browser_evaluate',
  arguments: { tabId, expression: '1 + 2' },
});
if (evalR.json?.result?.content?.[0]?.text !== '3') {
  fail('mcp-endpoint', 'evaluate wrong result: ' + JSON.stringify(evalR.json));
}

// 6. browser_get_text returns the page text (no maxChars param anymore).
const getText = await rpc('tools/call', {
  name: 'browser_get_text',
  arguments: { tabId },
});
const txt = getText.json?.result?.content?.[0]?.text || '';
if (!txt.toLowerCase().includes('example')) {
  fail('mcp-endpoint', 'get_text missing expected word: ' + txt.slice(0, 200));
}

// 6b. browser_get_html with a CSS selector returns matched HTML, depth-truncated.
const getHtml = await rpc('tools/call', {
  name: 'browser_get_html',
  arguments: { tabId, path: 'h1', maxDepth: 2 },
});
const htmlObj = JSON.parse(getHtml.json?.result?.content?.[0]?.text || '{}');
if (!Array.isArray(htmlObj.matches) || htmlObj.matchCount < 1) {
  fail('mcp-endpoint', 'get_html(h1) returned no matches: ' + JSON.stringify(htmlObj));
}
if (!htmlObj.matches[0].toLowerCase().includes('<h1')) {
  fail('mcp-endpoint', 'get_html(h1) first match is not an h1: ' + htmlObj.matches[0]);
}

// 7. browser_list_tabs includes our tab and the mcp metadata wrapper.
const listTabs = await rpc('tools/call', { name: 'browser_list_tabs', arguments: {} });
const tabsText = listTabs.json?.result?.content?.[0]?.text || '{}';
const listObj = JSON.parse(tabsText);
if (!Array.isArray(listObj.tabs)) {
  fail('mcp-endpoint', 'list_tabs missing tabs array: ' + tabsText);
}
if (!listObj.tabs.some(t => t.id === tabId)) {
  fail('mcp-endpoint', 'list_tabs missing our tab: ' + tabsText);
}
if (typeof listObj.mcpOwnedCap !== 'number') {
  fail('mcp-endpoint', 'list_tabs missing mcpOwnedCap: ' + tabsText);
}

// 8. browser_close_tab cleans up.
const close = await rpc('tools/call', {
  name: 'browser_close_tab',
  arguments: { tabId },
});
if (!close.json?.result?.content?.[0]?.text?.includes('closed')) {
  fail('mcp-endpoint', 'close_tab unexpected: ' + JSON.stringify(close.json));
}

// 9. Unknown tool returns isError, not a transport error.
const bogus = await rpc('tools/call', { name: 'browser_nonexistent', arguments: {} });
if (!bogus.json?.error || bogus.json.error.code !== -32602) {
  fail('mcp-endpoint', 'unknown tool: expected -32602, got ' + JSON.stringify(bogus.json));
}

// 10. Unknown JSON-RPC method on a request returns -32601.
const bogusMethod = await rpc('does/not/exist', {});
if (!bogusMethod.json?.error || bogusMethod.json.error.code !== -32601) {
  fail('mcp-endpoint', 'unknown method: expected -32601, got ' + JSON.stringify(bogusMethod.json));
}

pass('mcp-endpoint (initialize, tools/list, navigate, evaluate, get_text, list_tabs, close_tab, errors all OK)');
process.exit(0);
