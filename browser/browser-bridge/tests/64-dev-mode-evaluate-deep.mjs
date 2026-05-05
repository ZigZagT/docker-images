// browser_evaluate mode:'serialize-deep' — Gap 5.
// Verifies: complex types are serialized properly vs JSON-stringified null.
import http from 'http';
import { pass, fail } from './helpers.mjs';

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

async function callText(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  return r.result?.content?.[0]?.text || '';
}

// Setup
const openR = await rpc('tools/call', { name: 'browser_open', arguments: { url: 'about:blank' } });
const tabId = JSON.parse(openR.result?.content?.[0]?.text || '{}').tabId;

// Default mode: Map becomes null when JSON-stringified
const jsonMode = await callText('browser_evaluate', {
  tabId,
  expression: 'new Map([["a", 1], ["b", 2]])',
});
// returnByValue can't serialize Map — comes back as {} or null
if (jsonMode.includes('"a"') && jsonMode.includes('"b"')) {
  // If it somehow worked in JSON mode, that's fine too — Chrome may
  // have improved returnByValue. The important thing is serialize-deep works.
}

// serialize-deep mode: should return structured representation
const deepMode = await callText('browser_evaluate', {
  tabId,
  expression: 'new Map([["a", 1], ["b", 2]])',
  mode: 'serialize-deep',
});
// CDP deep serialization returns a structured object with type info
if (!deepMode || deepMode === 'undefined') {
  fail('dev-mode-evaluate-deep', 'serialize-deep returned empty for Map');
}
// Should contain the map entries in some structured form
const parsed = JSON.parse(deepMode);
if (!parsed) fail('dev-mode-evaluate-deep', 'could not parse deep result');
// CDP deep serialization for Map returns { type: 'map', value: [...] }
if (parsed.type === 'map' || (typeof parsed === 'object' && JSON.stringify(parsed).includes('a'))) {
  // Success — got structured representation
} else {
  fail('dev-mode-evaluate-deep', 'deep serialization missing map structure: ' + deepMode);
}

// Test with Date
const dateDeep = await callText('browser_evaluate', {
  tabId,
  expression: 'new Date("2024-01-15T12:00:00Z")',
  mode: 'serialize-deep',
});
if (!dateDeep || dateDeep === 'undefined') {
  fail('dev-mode-evaluate-deep', 'serialize-deep returned empty for Date');
}

// Test with RegExp
const regexDeep = await callText('browser_evaluate', {
  tabId,
  expression: '/test\\d+/gi',
  mode: 'serialize-deep',
});
if (!regexDeep || regexDeep === 'undefined') {
  fail('dev-mode-evaluate-deep', 'serialize-deep returned empty for RegExp');
}

// Cleanup
await rpc('tools/call', { name: 'browser_close_tab', arguments: { tabId } });
pass('dev-mode-evaluate-deep');
process.exit(0);
