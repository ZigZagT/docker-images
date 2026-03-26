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

  function waitFor(type, timeout = 8000) {
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
