// Capability test: LinkedIn jobs search renders + can be unblocked.
//
// LinkedIn is one of the most aggressive bot-detection targets — public
// jobs URLs render results but LinkedIn quickly throws a "Join now to
// view more jobs" modal blocking the rest. The agent's natural play is
// to dismiss the modal (the X button is a real interactive element), or
// browse results before the modal appears.
//
// Pass criteria: page loads (not bot wall), shows ≥10 software-engineer
// job links, and after dismissing the modal the snapshot contains job
// headings with company names.
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

const tab = await call('browser_open', { url: 'https://www.linkedin.com/jobs/search?keywords=software%20engineer&location=Remote' });
const tabId = tab.tabId;
await call('browser_wait_for', {
  tabId,
  expression: 'document.title.length > 0 && document.querySelectorAll("a[href*=\'/jobs/view/\']").length > 5',
  timeoutMs: 15000,
});

const probe = await call('browser_evaluate', {
  tabId,
  expression: 'JSON.stringify({title: document.title, jobCount: document.querySelectorAll("a[href*=\'/jobs/view/\']").length, hasModal: !!document.querySelector("[role=dialog]")})',
});
const p = JSON.parse(probe);
if (p.jobCount < 10) fail('cap-linkedin', 'expected ≥10 job links, got ' + p.jobCount);

// If the join-now dialog popped, dismiss it before snapshotting.
if (p.hasModal) {
  const snap = await call('browser_get_snapshot', { tabId });
  const dismissUid = findUid(snap, 'button', /^Dismiss$/);
  if (dismissUid) {
    await call('browser_click', { tabId, uid: dismissUid });
    await delay(800);
  }
}

const finalSnap = await call('browser_get_snapshot', { tabId });
const headingCount = (String(finalSnap).match(/\] heading "Software Engineer/g) || []).length;
if (headingCount < 5) {
  fail('cap-linkedin', 'snapshot has too few Software Engineer headings: ' + headingCount);
}

await call('browser_close_tab', { tabId });
pass('cap-linkedin (jobs search renders ≥10 links; modal dismissable; snapshot shows job headings)');
process.exit(0);
