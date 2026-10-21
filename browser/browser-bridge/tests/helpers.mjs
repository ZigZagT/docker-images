import { WebSocket } from 'ws';
import http from 'http';

const BRIDGE = 'ws://127.0.0.1:6080/ws';
const CDP_HOST = '127.0.0.1';
const CDP_PORT = 18800;

export function httpGet(u) {
  return new Promise((r, j) => http.get(u, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d)));
  }).on('error', j));
}

export function httpPut(u) {
  return new Promise((r, j) => {
    const q = http.request(u, { method: 'PUT' }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d)));
    }); q.on('error', j); q.end();
  });
}

export function connectViewer() {
  const ws = new WebSocket(BRIDGE);
  const events = [];
  ws.on('message', d => { const m = JSON.parse(d); if (m.type !== 'frame') events.push(m); });

  function send(obj) { ws.send(JSON.stringify(obj)); }

  function waitFor(type, timeout = 15000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for ' + type)), timeout);
      const c = setInterval(() => {
        const i = events.findIndex(m => m.type === type);
        if (i >= 0) { clearTimeout(t); clearInterval(c); res(events.splice(i, 1)[0]); }
      }, 100);
    });
  }

  function collectEvents(ms) {
    return new Promise(r => setTimeout(() => {
      const collected = events.splice(0);
      r(collected);
    }, ms));
  }

  function clearEvents() { events.length = 0; }

  function close() { ws.close(); }

  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, send, waitFor, collectEvents, clearEvents, close, events }));
    ws.on('error', reject);
  });
}

export function getTabUrl(tabId) {
  return httpGet(`http://${CDP_HOST}:${CDP_PORT}/json/list`)
    .then(list => list.find(t => t.id === tabId)?.url);
}

export const delay = ms => new Promise(r => setTimeout(r, ms));

export async function createCdpPage({ targetId } = {}) {
  const ownsTarget = targetId === undefined;
  const version = await httpGet(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    const request = pending.get(msg.id);
    if (!request) return;
    pending.delete(msg.id);
    if (msg.error) request.reject(new Error(msg.error.message));
    else request.resolve(msg.result);
  });
  const rejectPending = error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  ws.on('error', rejectPending);
  ws.on('close', () => rejectPending(new Error('Test browser connection closed')));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Test browser command timed out: ' + method));
    }, 5000);
    pending.set(id, {
      resolve: result => { clearTimeout(timer); resolve(result); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  try {
    if (ownsTarget) ({ targetId } = await send('Target.createTarget', { url: 'about:blank', background: true }));
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const command = (method, params) => send(method, params, sessionId);
    if (ownsTarget) await command('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', {
        expression: typeof expression === 'function' ? '(' + expression.toString() + ')()' : expression,
        returnByValue: true, awaitPromise: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    return {
      command, evaluate,
      setContent: html => evaluate(`document.open(); document.write(${JSON.stringify(html)}); document.close()`),
      bringToFront: () => command('Page.bringToFront'),
      async waitForFunction(expression) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (await evaluate(expression)) return;
          await delay(25);
        }
        throw new Error('Test page condition timed out: ' + expression);
      },
      async close() {
        try {
          if (ownsTarget) await send('Target.closeTarget', { targetId });
          else await send('Target.detachFromTarget', { sessionId });
        }
        finally { ws.close(); }
      },
    };
  } catch (error) {
    try {
      if (ownsTarget && targetId) await send('Target.closeTarget', { targetId });
    } finally {
      ws.close();
    }
    throw error;
  }
}

export function assert(condition, msg) {
  if (!condition) {
    console.log('FAIL:', msg);
    process.exit(1);
  }
}

export function pass(name) {
  console.log('PASS:', name);
}

export function fail(name, detail) {
  console.log('FAIL:', name, detail || '');
  process.exit(1);
}
