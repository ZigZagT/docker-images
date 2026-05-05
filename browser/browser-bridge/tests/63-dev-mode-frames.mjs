// Dev mode frame listing and navigation.
// Verifies: browser_list_frames returns frame tree, browser_navigate_frame works.
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

// Setup: create a page with an iframe
const html = `data:text/html,<html><body><h1>Main</h1><iframe name="child" src="about:blank" width="400" height="300"></iframe></body></html>`;
const opened = await call('browser_open', { url: html });
const tabId = opened.tabId;
await delay(500);
await call('browser_set_dev_mode', { tabId, enabled: true });

// List frames — should have main + iframe
const frames = await call('browser_list_frames', { tabId });
if (!Array.isArray(frames.frames)) fail('dev-mode-frames', 'missing frames array');
if (frames.frames.length < 2) fail('dev-mode-frames', 'expected 2+ frames, got ' + frames.frames.length);

const mainFrame = frames.frames.find(f => f.parentFrameId === null);
if (!mainFrame) fail('dev-mode-frames', 'no main frame found');

const childFrame = frames.frames.find(f => f.parentFrameId !== null);
if (!childFrame) fail('dev-mode-frames', 'no child frame found');
if (childFrame.parentFrameId !== mainFrame.frameId) {
  fail('dev-mode-frames', 'child parent mismatch');
}

// Navigate the iframe
const navResult = await call('browser_navigate_frame', {
  tabId,
  frameId: childFrame.frameId,
  url: 'data:text/html,<h2>Navigated</h2>',
});
if (!navResult.navigated) fail('dev-mode-frames', 'navigate_frame did not return navigated:true');
await delay(300);

// Verify frame URL changed
const framesAfter = await call('browser_list_frames', { tabId });
const updatedChild = framesAfter.frames.find(f => f.frameId === childFrame.frameId);
if (!updatedChild || !updatedChild.url.includes('Navigated')) {
  fail('dev-mode-frames', 'frame URL not updated after navigate');
}

// Cleanup
await call('browser_close_tab', { tabId });
pass('dev-mode-frames');
process.exit(0);
