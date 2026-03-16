// Browser Bridge — lightweight CDP screencast proxy
// No X11, no VNC. Uses Chrome's built-in rendering via CDP.
//
// Both the viewer (screencast) and DevTools connect through a single
// browser-level WebSocket using Target.attachToTarget with flatten:true.
// Each gets an independent sessionId so they don't evict each other.
// (Page-level webSocketDebuggerUrl is exclusive — a second client kills the first.)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';

const execFileAsync = promisify(execFile);

const PORT = parseInt(process.env.BRIDGE_PORT || '6080', 10);
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const CDP_PORT = parseInt(process.env.CDP_PORT || '18800', 10);
const SCREENCAST_QUALITY = parseInt(process.env.SCREENCAST_QUALITY || '80', 10);
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || '1920', 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || '1080', 10);

const HTML_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), 'index.html');
const CHROME_CMD = '/usr/local/bin/chrome';

const LOG_LEVELS = { error: 0, info: 1, debug: 2 };
const LOG_LEVEL = LOG_LEVELS[process.env.BRIDGE_LOG || 'info'] ?? LOG_LEVELS.info;
const log = {
  error: (...args) => { if (LOG_LEVEL >= 0) console.error('[bridge]', ...args); },
  info:  (...args) => { if (LOG_LEVEL >= 1) console.log('[bridge]', ...args); },
  debug: (...args) => { if (LOG_LEVEL >= 2) console.log('[bridge]', ...args); },
};

// --- CDP HTTP helpers ---

async function cdpFetch(p, method = 'GET') {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}${p}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text || `CDP returned ${res.status}`);
  }
}

let tabCounter = 0;
const knownTabs = new Map(); // targetId -> creation integer
const helperTargets = new Set(); // temp targets (sync-internals etc.) hidden from tab list

async function getCdpTargets() {
  const targets = (await cdpFetch('/json/list')).filter(t => !helperTargets.has(t.id));

  const currentIds = new Set();
  for (const t of targets) {
    if (t.type === 'page') {
      currentIds.add(t.id);
      if (!knownTabs.has(t.id)) knownTabs.set(t.id, tabCounter++);
    }
  }
  for (const id of knownTabs.keys()) {
    if (!currentIds.has(id)) knownTabs.delete(id);
  }

  const pages = targets.filter(t => t.type === 'page')
    .sort((a, b) => knownTabs.get(a.id) - knownTabs.get(b.id));
  const nonPages = targets.filter(t => t.type !== 'page');
  return [...pages, ...nonPages];
}

// Debounced broadcast: notify all viewers to refresh tabs when targets change.
// Used by Target.setDiscoverTargets events (targetCreated/Destroyed/InfoChanged).
let tabBroadcastTimer = null;
function scheduleTabBroadcast() {
  if (tabBroadcastTimer) return;
  tabBroadcastTimer = setTimeout(() => {
    tabBroadcastTimer = null;
    const msg = JSON.stringify({ type: 'tabsChanged' });
    for (const client of viewerWss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }, 500);
}

async function findPageTarget(targetId) {
  const targets = await getCdpTargets();
  let page;
  if (targetId) page = targets.find(t => t.id === targetId);
  if (!page) page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('No page target found');
  return { targetId: page.id, url: page.url, title: page.title };
}

function normalizeUrl(input) {
  input = input.trim();
  if (!input) return 'about:blank';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) return input;
  if (/^[^\s/]+\.[^\s/]+/.test(input)) return 'https://' + input;
  return 'https://www.google.com/search?q=' + encodeURIComponent(input);
}

// --- Extension discovery ---
// Attaches to each extension's service worker / background page via CDP to call
// chrome.runtime.getManifest() (returns i18n-resolved names) and fetch the toolbar
// icon as a data URL from within the extension context. No filesystem paths needed.

let extensionCache = null;
let extensionPrefsMtimeMs = 0;

// Read icon file from extension directory and convert to data URL
async function readExtensionIcon(extPath, manifest) {
  const ai = manifest.action?.default_icon || manifest.browser_action?.default_icon;
  const fi = manifest.icons || {};
  let iconRel = null;
  if (typeof ai === 'string') iconRel = ai;
  else if (ai) iconRel = ai['32'] || ai['24'] || ai['48'] || ai['16'];
  if (!iconRel) iconRel = fi['32'] || fi['24'] || fi['48'] || fi['16'] || fi['128'];
  if (!iconRel) return null;
  try {
    const iconPath = path.join(extPath, iconRel);
    const buf = await fs.promises.readFile(iconPath);
    const ext = path.extname(iconRel).toLowerCase();
    const mime = ext === '.svg' ? 'image/svg+xml'
      : ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function ensureProfileDir() {
  if (profileDir) return;
  await ensureBrowserConnection();
  let helperId = null;
  let helperSid = null;
  try {
    const target = await cdpFetch('/json/new?chrome://version/', 'PUT');
    helperId = target.id;
    helperTargets.add(helperId);
    helperSid = await attachToTarget(helperId);
    await sessionCommand(helperSid, 'Page.enable');
    await discoverProfileDir(helperSid);
  } catch {}
  if (helperSid) detachSession(helperSid);
  if (helperId) {
    helperTargets.delete(helperId);
    fetch(`http://${CDP_HOST}:${CDP_PORT}/json/close/${helperId}`).catch(() => {});
  }
}

async function getExtensionInfo() {
  await ensureProfileDir();
  if (!profileDir) return extensionCache || [];

  const prefsPath = path.join(profileDir, 'Preferences');
  try {
    const st = await fs.promises.stat(prefsPath);
    if (extensionCache && st.mtimeMs === extensionPrefsMtimeMs) {
      return extensionCache;
    }
    extensionPrefsMtimeMs = st.mtimeMs;
  } catch {
    return extensionCache || [];
  }

  let prefs;
  try {
    prefs = JSON.parse(await fs.promises.readFile(prefsPath, 'utf8'));
  } catch {
    return extensionCache || [];
  }

  const settings = prefs.extensions?.settings || {};
  const results = [];

  for (const [id, ext] of Object.entries(settings)) {
    if (ext.disable_reasons?.length > 0) continue;
    if (ext.location === 5 || ext.location === 10) continue;
    const manifest = ext.manifest;
    if (!manifest) continue;

    const info = {
      id,
      name: manifest.name || id,
      icon: null,
      popup: manifest.action?.default_popup
        || manifest.browser_action?.default_popup || null
    };

    const extPath = ext.path;
    if (extPath) {
      const fullPath = path.isAbsolute(extPath) ? extPath
        : path.join(profileDir, 'Extensions', extPath);
      info.icon = await readExtensionIcon(fullPath, manifest);
    }

    results.push(info);
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  extensionCache = results;
  return results;
}

// --- Profile / sync status ---
// Avatar + email from Chrome's Preferences file (profile path discovered via chrome://version/).
// Sync status from chrome://sync-internals/ helper tab (hidden from tab list via helperTargets).

let profileCache = null;
let profileCacheTime = 0;
let profileDir = null; // cached after first discovery from chrome://version/
const PROFILE_CACHE_TTL = 60000;

async function discoverProfileDir(helperSid) {
  if (profileDir) return;
  await sessionCommand(helperSid, 'Page.navigate', { url: 'chrome://version/' });
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    const resp = await sessionCommand(helperSid, 'Runtime.evaluate', {
      expression: `document.getElementById('profile_path')?.textContent?.trim()`
    });
    const val = resp?.result?.result?.value;
    if (val) {
      profileDir = val;
      log.debug('discovered profile dir:', profileDir);
      return;
    }
  }
}

async function getProfileStatus() {
  if (profileCache && Date.now() - profileCacheTime < PROFILE_CACHE_TTL) {
    return profileCache;
  }

  await ensureBrowserConnection();
  let helperId = null;
  let helperSid = null;

  try {
    const target = await cdpFetch('/json/new?chrome://sync-internals/', 'PUT');
    helperId = target.id;
    helperTargets.add(helperId);
    helperSid = await attachToTarget(helperId);
    await sessionCommand(helperSid, 'Page.enable');

    // Poll for sync-internals data (replaces fixed 2s delay)
    let syncData = {};
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      const evalResp = await sessionCommand(helperSid, 'Runtime.evaluate', {
        expression: `(() => {
          const result = {};
          document.querySelectorAll('#about-info tr').forEach(r => {
            const cells = r.querySelectorAll('td');
            if (cells.length >= 2)
              result[cells[0].textContent.trim()] = cells[1].textContent.trim();
          });
          return JSON.stringify(result);
        })()`
      });
      if (evalResp?.result?.result?.value) {
        const data = JSON.parse(evalResp.result.result.value);
        if (Object.keys(data).length > 0) {
          syncData = data;
          break;
        }
      }
    }

    // Discover profile dir once via chrome://version/
    if (!profileDir) {
      try { await discoverProfileDir(helperSid); } catch {}
    }

    // Read avatar + account info from Preferences file
    let avatar = null;
    let email = syncData['Username'] || syncData['Authenticated Account ID'] || null;
    let fullName = null;
    if (profileDir) {
      try {
        const prefs = JSON.parse(await fs.promises.readFile(
          path.join(profileDir, 'Preferences'), 'utf8'));
        const account = prefs.account_info?.[0];
        if (account) {
          avatar = account.picture_url || null;
          if (!email) email = account.email || null;
          fullName = account.full_name || null;
        }
      } catch {}
    }

    const transport = syncData['Transport State'] || '';
    const summary = syncData['Summary'] || transport;

    // Transport State "Active" = ok, anything else = problem.
    // Don't interpret non-Active states — surface the exact value.
    let status = 'signed_out';
    if (email) {
      status = (transport === 'Active' || !transport) ? 'ok' : 'error';
    }

    profileCache = { email, fullName, status, summary, avatar, transport };
    profileCacheTime = Date.now();
    return profileCache;
  } catch {
    return { email: null, fullName: null, status: 'unknown', summary: '', avatar: null };
  } finally {
    if (helperSid) detachSession(helperSid);
    if (helperId) {
      helperTargets.delete(helperId);
      fetch(`http://${CDP_HOST}:${CDP_PORT}/json/close/${helperId}`).catch(() => {});
    }
  }
}

// --- Shared browser-level CDP connection ---
// All clients (viewer, devtools) multiplex through one browser WebSocket.
// Each gets an independent session via Target.attachToTarget(flatten:true).

let browserWs = null;
let browserCmdId = 1;
let downloadBehaviorSet = false;
let pendingBrowserCmds = new Map(); // id → { resolve, reject, sessionId }
let sessionHandlers = new Map();    // sessionId → fn(msg)
let browserConnecting = null;       // dedup concurrent connect attempts
const viewerReconnectors = new Set(); // reconnect callbacks for each viewer
const viewerTargetDestroyedHandlers = new Set(); // called when a page target is destroyed
let browserExplicitlyStopped = false; // suppress auto-reconnect after explicit stop

async function getBrowserWsUrl() {
  const version = await cdpFetch('/json/version');
  return version.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${CDP_HOST}:${CDP_PORT}`);
}

function ensureBrowserConnection() {
  if (browserWs && browserWs.readyState === WebSocket.OPEN) return Promise.resolve();
  if (browserConnecting) return browserConnecting;

  browserConnecting = (async () => {
    let wsUrl;
    try {
      wsUrl = await getBrowserWsUrl();
    } catch (err) {
      browserConnecting = null;
      throw err;
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        browserWs = ws;
        browserConnecting = null;
        downloadBehaviorSet = false;
        log.info('browser-level CDP connected');
        // Push target lifecycle events so viewers get real-time tab updates
        browserCommand('Target.setDiscoverTargets', { discover: true }).catch(() => {});
        resolve();
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          // Command responses — msg.id is the authoritative correlation key.
          // Check pending commands first regardless of sessionId, because
          // some browser-level commands (e.g. Target.detachFromTarget) get
          // responses with a sessionId in the envelope.
          if (msg.id && pendingBrowserCmds.has(msg.id)) {
            const pending = pendingBrowserCmds.get(msg.id);
            pendingBrowserCmds.delete(msg.id);
            pending.resolve(msg);
            return;
          }

          // Session-scoped events (no msg.id): route to handler
          if (msg.sessionId) {
            if (sessionHandlers.has(msg.sessionId)) {
              sessionHandlers.get(msg.sessionId)(msg);
            }
            return;
          }

          // Target lifecycle events → push tab updates to all viewers
          if (msg.method === 'Target.targetCreated') {
            const ti = msg.params?.targetInfo;
            if (ti?.type === 'page') scheduleTabBroadcast();
            // Extension installed/enabled — invalidate cache so next
            // getExtensions fetches fresh data
            if (ti?.type === 'service_worker' || ti?.type === 'background_page') {
              extensionCache = null;
              scheduleTabBroadcast();
            }
          }
          if (msg.method === 'Target.targetDestroyed') {
            // targetDestroyed only has params.targetId, no targetInfo —
            // can't filter by type for pages. Always notify viewers for
            // known tabs; always invalidate extension cache (cheap check).
            const destroyedId = msg.params?.targetId;
            if (destroyedId) {
              if (knownTabs.has(destroyedId)) scheduleTabBroadcast();
              for (const fn of viewerTargetDestroyedHandlers) fn(destroyedId);
            }
            extensionCache = null;
          }
          if (msg.method === 'Target.targetInfoChanged') {
            const ti = msg.params?.targetInfo;
            if (ti?.type === 'page') scheduleTabBroadcast();
          }
        } catch { /* ignore parse errors */ }
      });

      ws.on('close', () => {
        log.info('browser-level CDP disconnected');
        browserWs = null;
        browserConnecting = null;
        for (const [, { reject: rej }] of pendingBrowserCmds) rej(new Error('browser WS closed'));
        pendingBrowserCmds.clear();
        sessionHandlers.clear();
        // Invalidate caches — stale after browser restart
        extensionCache = null;
        extensionCacheTime = 0;
        profileCache = null;
        profileCacheTime = 0;
        profileDir = null;
        extensionPrefsMtimeMs = 0;
        // Auto-reconnect viewers unless browser was explicitly stopped
        if (!browserExplicitlyStopped) {
          for (const fn of viewerReconnectors) fn();
        }
      });

      ws.on('error', (err) => {
        log.error('browser CDP error:', err.message);
        browserConnecting = null;
        reject(err);
      });
    });
  })();

  return browserConnecting;
}

// Send a browser-level command and await response
function browserCommand(method, params = {}, timeout = 10000) {
  if (!browserWs || browserWs.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
  const id = browserCmdId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBrowserCmds.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, timeout);
    pendingBrowserCmds.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
      sessionId: null
    });
    browserWs.send(JSON.stringify({ id, method, params }));
  });
}

// Send a session command and await response
function sessionCommand(sessionId, method, params = {}, timeout = 10000) {
  if (!browserWs || browserWs.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
  const id = browserCmdId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBrowserCmds.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, timeout);
    pendingBrowserCmds.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
      sessionId
    });
    browserWs.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

// Send a command within a session (fire-and-forget)
function sessionSend(sessionId, method, params = {}) {
  if (!browserWs || browserWs.readyState !== WebSocket.OPEN) return;
  const id = browserCmdId++;
  browserWs.send(JSON.stringify({ id, method, params, sessionId }));
}

async function attachToTarget(targetId) {
  const resp = await browserCommand('Target.attachToTarget', { targetId, flatten: true });
  if (resp.error) throw new Error(resp.error.message);
  return resp.result.sessionId;
}

function detachSession(sessionId) {
  sessionHandlers.delete(sessionId);
  for (const [id, pending] of pendingBrowserCmds) {
    if (pending.sessionId === sessionId) {
      pendingBrowserCmds.delete(id);
      pending.reject(new Error('session detached'));
    }
  }
  if (browserWs && browserWs.readyState === WebSocket.OPEN) {
    browserCommand('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

// --- HTTP server ---

const KNOWN_ENDPOINTS = new Set(['health', 'tabs', 'devtools-check']);
function routePath(url) {
  const clean = url.split('?')[0];
  const segments = clean.split('/').filter(Boolean);
  const last = segments[segments.length - 1] || '';
  if (KNOWN_ENDPOINTS.has(last)) return '/' + last;
  if (last === 'index.html') return '/index.html';
  return '/';
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const p = routePath(req.url);
  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(HTML_PATH).pipe(res);
  } else if (p === '/health') {
    jsonResponse(res, { ok: true });
  } else if (p === '/devtools-check') {
    // Diagnostic: tests the full devtools proxy chain without WebSocket.
    // Hit /devtools-check?target=<id> to verify target exists and session attaches.
    const reqUrl = new URL(req.url, 'http://localhost');
    const targetId = reqUrl.searchParams.get('target');
    try {
      await ensureBrowserConnection();
      const target = await findPageTarget(targetId);
      const sid = await attachToTarget(target.targetId);
      detachSession(sid);
      jsonResponse(res, {
        ok: true,
        targetId: target.targetId,
        url: target.url,
        title: target.title,
        sessionId: sid,
        browserWsConnected: !!(browserWs && browserWs.readyState === WebSocket.OPEN)
      });
    } catch (err) {
      jsonResponse(res, {
        ok: false,
        error: err.message,
        browserWsConnected: !!(browserWs && browserWs.readyState === WebSocket.OPEN)
      }, 502);
    }
  } else if (p === '/tabs') {
    try {
      const targets = await getCdpTargets();
      const pages = targets.filter(t => t.type === 'page').map(t => ({
        id: t.id, url: t.url, title: t.title
      }));
      jsonResponse(res, pages);
    } catch (err) {
      jsonResponse(res, { error: err.message }, 502);
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// --- WebSocket routing ---

const viewerWss = new WebSocketServer({ noServer: true });
const devtoolsWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  log.debug('WS upgrade request:', req.url);
  if (req.url.match(/\/ws(\?|$)/)) {
    viewerWss.handleUpgrade(req, socket, head, (ws) => viewerWss.emit('connection', ws, req));
  } else if (req.url.match(/\/devtools\b/)) {
    devtoolsWss.handleUpgrade(req, socket, head, (ws) => devtoolsWss.emit('connection', ws, req));
  } else {
    log.debug('WS upgrade rejected — no matching path:', req.url);
    socket.destroy();
  }
});

// --- DevTools proxy ---
// Attaches a new session to the target, relays messages bidirectionally.
// DevTools frontend doesn't know about sessionId — proxy adds/strips it.

devtoolsWss.on('connection', async (client, req) => {
  log.info('devtools client connected');

  const url = new URL(req.url, 'http://localhost');
  const targetId = url.searchParams.get('target');
  log.debug('devtools requested target:', targetId);

  // Buffer messages from DevTools frontend while we attach to the target.
  // DevTools sends commands immediately on connect — without buffering,
  // early commands (Runtime.enable, Page.enable, etc.) are silently dropped.
  let sessionId = null;
  const earlyMessages = [];

  client.on('message', (raw) => {
    if (!sessionId) {
      earlyMessages.push(raw);
      return;
    }
    if (!browserWs || browserWs.readyState !== WebSocket.OPEN) return;
    try {
      const msg = JSON.parse(raw.toString());
      msg.sessionId = sessionId;
      browserWs.send(JSON.stringify(msg));
    } catch { /* ignore */ }
  });

  client.on('close', () => {
    log.info('devtools client disconnected');
    if (sessionId) detachSession(sessionId);
  });
  client.on('error', () => {});

  try {
    await ensureBrowserConnection();
    const target = await findPageTarget(targetId);
    sessionId = await attachToTarget(target.targetId);
    log.debug('devtools session attached:', sessionId, 'target:', target.targetId);
  } catch (err) {
    log.error('devtools attach failed:', err.message);
    client.close(1011, err.message);
    return;
  }

  // Chrome → DevTools: strip sessionId before forwarding
  sessionHandlers.set(sessionId, (msg) => {
    if (client.readyState !== WebSocket.OPEN) return;
    const fwd = Object.assign({}, msg);
    delete fwd.sessionId;
    client.send(JSON.stringify(fwd));
  });

  // Replay buffered messages now that sessionId is set
  const bufferedCount = earlyMessages.length;
  for (const raw of earlyMessages) {
    try {
      const msg = JSON.parse(raw.toString());
      msg.sessionId = sessionId;
      browserWs.send(JSON.stringify(msg));
    } catch { /* ignore */ }
  }
  earlyMessages.length = 0;
  log.debug('devtools proxy ready, replayed', bufferedCount, 'buffered messages');
});

// --- Viewer: screencast + input ---
// Viewport is fixed at Chrome launch via --window-size=1920,1080.
// No Emulation.setDeviceMetricsOverride needed — that was causing white
// frames by creating a virtual viewport that screencast couldn't capture from.

viewerWss.on('connection', async (client, req) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  const preferredTarget = reqUrl.searchParams.get('target');
  log.info('viewer client connected', preferredTarget ? `(preferred: ${preferredTarget})` : '');

  let sessionId = null;
  let screencastStarted = false;
  let currentTargetId = null;
  let connectGen = 0;
  let switching = false;
  let zoomLevel = 1.0;
  let mainFrameId = null;
  let lastKnownOrder = []; // ordered tab IDs from last snapshot, for adjacent-tab selection

  function clientSend(obj) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj));
  }

  // Single reconciliation path for all "tab disappeared" scenarios.
  // Compares current tabs against lastKnownOrder to detect if the active tab
  // is gone, then picks adjacent tab from the OLD order (before removal).
  let reconciling = false;
  async function reconcileTabs() {
    if (reconciling || switching) return;
    reconciling = true;
    try {
      const targets = await getCdpTargets();
      const pages = targets.filter(t => t.type === 'page');
      const currentIds = new Set(pages.map(t => t.id));

      // Update lastKnownOrder for next reconcile
      const newOrder = pages.map(t => t.id);

      if (currentTargetId && !currentIds.has(currentTargetId)) {
        // Active tab is gone — find adjacent from merged order.
        // Merge old snapshot with live state so newly created tabs (not yet
        // in lastKnownOrder due to race) appear after the old tabs.
        const oldSet = new Set(lastKnownOrder);
        const searchOrder = [...lastKnownOrder];
        for (const id of newOrder) {
          if (!oldSet.has(id)) searchOrder.push(id);
        }
        const lostId = currentTargetId;
        const oldIdx = searchOrder.indexOf(lostId);
        let nextId = null;
        if (oldIdx >= 0) {
          for (let i = oldIdx + 1; i < searchOrder.length; i++) {
            if (currentIds.has(searchOrder[i])) { nextId = searchOrder[i]; break; }
          }
          if (!nextId) {
            for (let i = oldIdx - 1; i >= 0; i--) {
              if (currentIds.has(searchOrder[i])) { nextId = searchOrder[i]; break; }
            }
          }
        }
        log.debug('reconcile: active tab %s gone, next=%s (old order had %d tabs, now %d)',
          lostId, nextId, lastKnownOrder.length, pages.length);

        sessionId = null;
        currentTargetId = null;
        screencastStarted = false;

        if (pages.length === 0) {
          const blank = await cdpFetch('/json/new?about:blank', 'PUT');
          await connectToTarget(blank.id);
        } else {
          await connectToTarget(nextId || pages[0].id);
        }
        // connectToTarget already seeded lastKnownOrder from fresh knownTabs
      } else {
        lastKnownOrder = newOrder;
      }

      // Broadcast fresh tab list to client
      const freshPages = pages.map(t => ({
        id: t.id, url: t.url, title: t.title, active: t.id === currentTargetId
      }));
      clientSend({ type: 'tabs', tabs: freshPages });
    } catch (err) {
      log.error('reconcileTabs error:', err.message);
    } finally {
      reconciling = false;
    }
  }

  // CSS zoom: viewport stays 1920x1080, content scales via document.documentElement.style.zoom.
  // addScriptToEvaluateOnNewDocument persists across navigations within the session.
  let zoomScriptId = null;

  async function applyZoom() {
    if (!sessionId) return;
    if (zoomScriptId) {
      await sessionCommand(sessionId, 'Page.removeScriptToEvaluateOnNewDocument', {
        identifier: zoomScriptId
      }).catch(() => {});
      zoomScriptId = null;
    }
    const zoomValue = zoomLevel === 1.0 ? '' : String(zoomLevel);
    await sessionCommand(sessionId, 'Runtime.evaluate', {
      expression: `document.documentElement.style.zoom='${zoomValue}'`
    }).catch(() => {});
    if (zoomLevel !== 1.0) {
      const resp = await sessionCommand(sessionId, 'Page.addScriptToEvaluateOnNewDocument', {
        source: `document.documentElement.style.zoom='${zoomLevel}'`
      }).catch(() => null);
      if (resp?.result?.identifier) zoomScriptId = resp.result.identifier;
    }
  }

  async function connectToTarget(targetId) {
    const ct0 = Date.now();
    const gen = ++connectGen;
    switching = true;

    if (sessionId) {
      if (screencastStarted) {
        sessionSend(sessionId, 'Page.stopScreencast');
      }
      screencastStarted = false;
      detachSession(sessionId);
      sessionId = null;
      zoomScriptId = null;
      log.debug('connectToTarget: detach old %dms', Date.now() - ct0);
    }

    if (gen !== connectGen) return; // preempted by newer connectToTarget call

    let ct1 = Date.now();
    await ensureBrowserConnection();
    log.debug('connectToTarget: ensureBrowser %dms', Date.now() - ct1);
    if (!downloadBehaviorSet) {
      const dlPath = process.env.DOWNLOAD_DIR || (process.env.HOME || '/home/node') + '/downloads';
      await browserCommand('Browser.setDownloadBehavior', {
        behavior: 'allow', downloadPath: dlPath
      }).catch(() => {});
      downloadBehaviorSet = true;
      log.debug('download behavior set:', dlPath);
    }
    ct1 = Date.now();
    const target = await findPageTarget(targetId);
    currentTargetId = target.targetId;
    log.debug('connectToTarget: findPageTarget %dms', Date.now() - ct1);
    ct1 = Date.now();
    sessionId = await attachToTarget(currentTargetId);
    log.debug('connectToTarget: attach %dms (session=%s target=%s)', Date.now() - ct1, sessionId, currentTargetId);

    if (gen !== connectGen) {
      detachSession(sessionId);
      sessionId = null;
      return;
    }

    // Route session events to the viewer
    sessionHandlers.set(sessionId, (msg) => {
      if (msg.method === 'Page.screencastFrame') {
        clientSend({
          type: 'frame',
          data: msg.params.data,
          metadata: msg.params.metadata,
          sessionId: msg.params.sessionId
        });
        sessionSend(sessionId, 'Page.screencastFrameAck', { sessionId: msg.params.sessionId });
      }

      if (msg.method === 'Page.frameNavigated' && !msg.params.frame?.parentId) {
        mainFrameId = msg.params.frame?.id;
        clientSend({ type: 'navigated', url: msg.params.frame?.url });
      }

      // JS-driven URL changes (history.pushState / replaceState)
      if (msg.method === 'Page.navigatedWithinDocument') {
        if (!mainFrameId || msg.params.frameId === mainFrameId) {
          clientSend({ type: 'navigated', url: msg.params.url });
        }
      }

      if (msg.method === 'Page.frameStartedLoading') {
        if (!mainFrameId || msg.params.frameId === mainFrameId) {
          clientSend({ type: 'loading', loading: true });
        }
      }

      if (msg.method === 'Page.frameStoppedLoading') {
        if (!mainFrameId || msg.params.frameId === mainFrameId) {
          clientSend({ type: 'loading', loading: false });
        }
      }

      if (msg.method === 'Inspector.detached') {
        log.debug('viewer session detached:', msg.params?.reason);
        screencastStarted = false;
        if (!switching) reconcileTabs();
      }
    });

    switching = false;

    // Activate the target so Chrome treats it as the foreground tab.
    // Without this, headless=new won't produce composited frames for screencast.
    let t1 = Date.now();
    const activateResp = await browserCommand('Target.activateTarget', { targetId: currentTargetId });
    if (activateResp.error) log.error('activateTarget failed:', activateResp.error.message);
    log.debug('connectToTarget: activateTarget %dms', Date.now() - t1);
    t1 = Date.now();
    await sessionCommand(sessionId, 'Page.bringToFront');
    log.debug('connectToTarget: bringToFront %dms', Date.now() - t1);
    t1 = Date.now();
    await sessionCommand(sessionId, 'Page.enable');
    log.debug('connectToTarget: Page.enable %dms', Date.now() - t1);
    t1 = Date.now();
    const frameTree = await sessionCommand(sessionId, 'Page.getFrameTree').catch(() => null);
    mainFrameId = frameTree?.result?.frameTree?.frame?.id || null;
    log.debug('connectToTarget: getFrameTree %dms', Date.now() - t1);
    t1 = Date.now();
    const scResp = await sessionCommand(sessionId, 'Page.startScreencast', {
      format: 'jpeg', quality: SCREENCAST_QUALITY,
      maxWidth: VIEWPORT_WIDTH, maxHeight: VIEWPORT_HEIGHT
    });
    if (scResp.error) log.error('startScreencast failed:', scResp.error.message);
    screencastStarted = true;
    log.debug('connectToTarget: startScreencast %dms', Date.now() - t1);
    log.debug('connectToTarget: total %dms', Date.now() - ct0);
    if (zoomLevel !== 1.0) await applyZoom();

    clientSend({ type: 'targetChanged', targetId: currentTargetId, url: target.url, title: target.title });

    // Seed lastKnownOrder so reconcileTabs can compute adjacent tabs
    lastKnownOrder = [...knownTabs.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
  }

  let isClosed = false;
  let reconnecting = false;

  function startReconnectLoop() {
    if (reconnecting || isClosed) return;
    reconnecting = true;
    sessionId = null;
    screencastStarted = false;
    (async () => {
      while (!isClosed) {
        clientSend({ type: 'status', message: 'Reconnecting to browser...' });
        await new Promise(r => setTimeout(r, 2000));
        try {
          await connectToTarget(currentTargetId || preferredTarget || null);
          reconnecting = false;
          break;
        } catch {}
      }
    })();
  }

  function onTargetDestroyed(destroyedId) {
    if (destroyedId !== currentTargetId || switching) return;
    log.debug('current target destroyed externally:', destroyedId);
    reconcileTabs();
  }

  viewerReconnectors.add(startReconnectLoop);
  viewerTargetDestroyedHandlers.add(onTargetDestroyed);

  client.on('close', () => {
    isClosed = true;
    viewerReconnectors.delete(startReconnectLoop);
    viewerTargetDestroyedHandlers.delete(onTargetDestroyed);
    log.info('viewer client disconnected');
    switching = true;
    if (sessionId) {
      if (screencastStarted) sessionSend(sessionId, 'Page.stopScreencast');
      detachSession(sessionId);
    }
  });

  (async function connectLoop() {
    let attempts = 0;
    while (!isClosed) {
      try {
        await connectToTarget(preferredTarget || null);
        break;
      } catch (err) {
        if (attempts === 0) {
          log.error('initial connect failed, will retry:', err.message);
        }
        clientSend({ type: 'status', message: 'Waiting for browser to start...' });
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
      }
    }
  })();

  client.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'mouse':
          if (sessionId) sessionSend(sessionId, 'Input.dispatchMouseEvent', {
            type: msg.action, x: msg.x, y: msg.y,
            button: msg.button || 'left',
            clickCount: msg.clickCount || 0,
            modifiers: msg.modifiers || 0
          });
          break;

        case 'key':
          if (sessionId) sessionSend(sessionId, 'Input.dispatchKeyEvent', {
            type: msg.action, key: msg.key, code: msg.code,
            text: msg.text || '',
            windowsVirtualKeyCode: msg.keyCode || 0,
            modifiers: msg.modifiers || 0
          });
          break;

        case 'scroll':
          if (sessionId) sessionSend(sessionId, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: msg.x, y: msg.y,
            deltaX: msg.deltaX || 0, deltaY: msg.deltaY || 0
          });
          break;

        case 'paste':
          if (sessionId && msg.text) {
            sessionSend(sessionId, 'Input.insertText', { text: msg.text });
          }
          break;

        case 'copy':
          if (sessionId) {
            try {
              const resp = await sessionCommand(sessionId, 'Runtime.evaluate', {
                expression: 'window.getSelection().toString()'
              });
              const text = resp?.result?.result?.value;
              if (text) clientSend({ type: 'clipboard', text });
            } catch { /* ignore */ }
          }
          break;

        case 'zoom':
          if (typeof msg.level === 'number') {
            zoomLevel = Math.max(0.25, Math.min(5, msg.level));
            await applyZoom();
          }
          break;

        case 'navigate':
          if (sessionId) sessionSend(sessionId, 'Page.navigate', { url: normalizeUrl(msg.url) });
          break;

        case 'reload':
          if (sessionId) sessionSend(sessionId, 'Page.reload');
          break;

        case 'stop':
          if (sessionId) sessionSend(sessionId, 'Page.stopLoading');
          break;

        case 'back':
          if (sessionId) sessionSend(sessionId, 'Runtime.evaluate', { expression: 'history.back()' });
          break;

        case 'forward':
          if (sessionId) sessionSend(sessionId, 'Runtime.evaluate', { expression: 'history.forward()' });
          break;

        case 'switchTab':
          if (msg.targetId) {
            try {
              await connectToTarget(msg.targetId);
            } catch (err) {
              clientSend({ type: 'error', message: 'Failed to switch tab: ' + err.message });
            }
          }
          break;

        case 'newTab':
          try {
            const newUrl = normalizeUrl(msg.url || '');
            const target = await cdpFetch('/json/new?' + newUrl, 'PUT');
            await connectToTarget(target.id);
          } catch (err) {
            clientSend({ type: 'error', message: 'Failed to create tab: ' + err.message });
          }
          break;

        case 'duplicateTab':
          try {
            if (!currentTargetId) throw new Error('No active tab');
            const curTarget = await findPageTarget(currentTargetId);
            const dup = await cdpFetch('/json/new?' + encodeURI(curTarget.url), 'PUT');
            await connectToTarget(dup.id);
          } catch (err) {
            clientSend({ type: 'error', message: 'Failed to duplicate tab: ' + err.message });
          }
          break;

        case 'closeTab':
          if (msg.targetId) {
            if (!knownTabs.has(msg.targetId)) {
              log.debug('closeTab: %s not in knownTabs, ignoring', msg.targetId);
              break;
            }
            const t0 = Date.now();
            clientSend({ type: 'tabClosing', targetId: msg.targetId });
            try {
              const tClose = Date.now();
              await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/close/${msg.targetId}`);
              log.debug('closeTab: /json/close %dms', Date.now() - tClose);
              // reconcileTabs detects the missing tab, picks adjacent, activates
              await reconcileTabs();
            } catch (err) {
              log.error('closeTab error:', err.message);
              clientSend({ type: 'error', message: 'Failed to close tab: ' + err.message });
            } finally {
              clientSend({ type: 'tabCloseComplete', targetId: msg.targetId });
            }
            log.debug('closeTab: e2e %dms', Date.now() - t0);
          }
          break;

        case 'getTabs':
          // Full reconcile: updates lastKnownOrder, detects missing active tab
          await reconcileTabs();
          break;

        case 'copyInternalState':
          try {
            const jsonList = await cdpFetch('/json/list');
            clientSend({ type: 'internalState', data: {
              jsonList,
              knownTabs: Object.fromEntries(knownTabs),
              helperTargets: [...helperTargets],
              currentTargetId,
              sessionId,
              tabCounter,
              screencastStarted,
              switching,
              browserConnected: !!(browserWs && browserWs.readyState === WebSocket.OPEN)
            }});
          } catch (err) {
            clientSend({ type: 'error', message: 'Failed to get internal state: ' + err.message });
          }
          break;

        case 'getProfileStatus':
          try {
            const profile = await getProfileStatus();
            clientSend({ type: 'profileStatus', ...profile });
          } catch {
            clientSend({ type: 'profileStatus', email: null, fullName: null, status: 'unknown', summary: '', avatar: null });
          }
          break;

        case 'getExtensions':
          try {
            const exts = await getExtensionInfo();
            clientSend({ type: 'extensions', extensions: exts });
          } catch {
            clientSend({ type: 'extensions', extensions: [] });
          }
          break;

        case 'openExtensionPopup': {
          const extId = msg.extensionId;
          if (!extId) break;
          let opened = false;

          // Try native popup API so the popup gets correct active-tab context.
          // After openPopup(), poll using both /json/list (HTTP endpoint) and
          // Target.getTargets (browser WS) — popups may only appear in one.
          try {
            const targets = await cdpFetch('/json/list');
            const sw = targets.find(t =>
              t.url?.startsWith('chrome-extension://' + extId + '/') &&
              (t.type === 'service_worker' || t.type === 'background_page'));

            if (sw) {
              const prevIds = new Set(targets.map(t => t.id));
              const sid = await attachToTarget(sw.id);
              const resp = await sessionCommand(sid, 'Runtime.evaluate', {
                expression: `(async () => {
                  if (typeof chrome.action?.openPopup === 'function')
                    return await chrome.action.openPopup();
                  if (typeof chrome.browserAction?.openPopup === 'function')
                    return await chrome.browserAction.openPopup();
                  throw new Error('no popup API');
                })()`,
                awaitPromise: true
              }).catch(() => null);
              detachSession(sid);

              if (resp && !resp.result?.exceptionDetails) {
                for (let i = 0; i < 6 && !opened; i++) {
                  await new Promise(r => setTimeout(r, 500));
                  // Check both HTTP and WS target lists — popup targets may only
                  // appear in the browser-level Target.getTargets response
                  const [httpTargets, wsResp] = await Promise.all([
                    cdpFetch('/json/list'),
                    browserCommand('Target.getTargets').catch(() => null)
                  ]);
                  const allTargets = [
                    ...httpTargets,
                    ...(wsResp?.result?.targetInfos || []).map(t => ({
                      id: t.targetId, url: t.url, type: t.type, title: t.title
                    }))
                  ];
                  const popup = allTargets.find(t =>
                    t.url?.startsWith('chrome-extension://' + extId + '/') &&
                    !prevIds.has(t.id || t.targetId));
                  if (popup) {
                    await connectToTarget(popup.id);
                    opened = true;
                  }
                }
              }
            }
          } catch {}

          // Fallback: open popup URL in a new tab (loses tab context).
          // If msg.popup is null (manifest fetch missed it), read manifest on the fly.
          if (!opened) {
            let popupPath = msg.popup;
            if (!popupPath) {
              try {
                const targets = await cdpFetch('/json/list');
                const sw = targets.find(t =>
                  t.url?.startsWith('chrome-extension://' + extId + '/') &&
                  (t.type === 'service_worker' || t.type === 'background_page'));
                if (sw) {
                  const sid = await attachToTarget(sw.id);
                  const mResp = await sessionCommand(sid, 'Runtime.evaluate', {
                    expression: `(() => {
                      const m = chrome.runtime.getManifest();
                      return m.action?.default_popup || m.browser_action?.default_popup || null;
                    })()`
                  });
                  detachSession(sid);
                  popupPath = mResp?.result?.result?.value || null;
                }
              } catch {}
            }
            if (popupPath) {
              try {
                const url = 'chrome-extension://' + extId + '/' + popupPath;
                const target = await cdpFetch('/json/new?' + url, 'PUT');
                await connectToTarget(target.id);
              } catch (err) {
                clientSend({ type: 'error', message: 'Popup failed: ' + err.message });
              }
            } else {
              clientSend({ type: 'error', message: 'Extension has no popup' });
            }
          }
          break;
        }

        case 'browserRestart':
          clientSend({ type: 'status', message: 'Restarting browser...' });
          if (sessionId) {
            sessionHandlers.delete(sessionId);
            sessionId = null;
            screencastStarted = false;
          }
          browserExplicitlyStopped = true;
          if (browserWs) { browserWs.close(); browserWs = null; }
          try {
            await execFileAsync(CHROME_CMD, ['browser', 'stop'], { timeout: 15000 }).catch(() => {});
            await execFileAsync(CHROME_CMD, ['browser', 'start'], { timeout: 15000 });
            browserExplicitlyStopped = false;
            for (const fn of viewerReconnectors) fn();
          } catch (err) {
            browserExplicitlyStopped = false;
            clientSend({ type: 'error', message: 'Browser restart failed: ' + err.message });
          }
          break;

        case 'browserStop':
          clientSend({ type: 'status', message: 'Shutting down browser...' });
          if (sessionId) {
            sessionHandlers.delete(sessionId);
            sessionId = null;
            screencastStarted = false;
          }
          browserExplicitlyStopped = true;
          if (browserWs) { browserWs.close(); browserWs = null; }
          try {
            await execFileAsync(CHROME_CMD, ['browser', 'stop'], { timeout: 15000 });
            clientSend({ type: 'browserStopped' });
          } catch (err) {
            clientSend({ type: 'error', message: 'Browser stop failed: ' + err.message });
          }
          break;

        case 'browserStart':
          clientSend({ type: 'status', message: 'Starting browser...' });
          browserExplicitlyStopped = false;
          try {
            await execFileAsync(CHROME_CMD, ['browser', 'start'], { timeout: 15000 });
            for (const fn of viewerReconnectors) fn();
          } catch (err) {
            clientSend({ type: 'error', message: 'Browser start failed: ' + err.message });
          }
          break;

        case 'bridgeRestart': {
          clientSend({ type: 'error', message: 'Restarting bridge...' });
          setTimeout(() => {
            const child = execFile(CHROME_CMD, ['bridge', 'restart'], {
              detached: true, stdio: 'ignore'
            });
            child.unref();
          }, 500);
          break;
        }

        case 'find':
          if (sessionId && msg.text) {
            const textJson = JSON.stringify(msg.text);
            const cs = !!msg.caseSensitive;
            const bw = !!msg.backwards;

            // Reset selection to search from page top when search text changes
            if (msg.fromStart) {
              await sessionCommand(sessionId, 'Runtime.evaluate', {
                expression: 'window.getSelection().removeAllRanges()'
              }).catch(() => {});
            }

            // Count matches using indexOf (avoids regex escaping complexity)
            const countResp = await sessionCommand(sessionId, 'Runtime.evaluate', {
              expression: `(() => {
                const q = ${textJson}${cs ? '' : '.toLowerCase()'};
                const t = document.body.innerText${cs ? '' : '.toLowerCase()'};
                if (!q) return 0;
                let c = 0, i = 0;
                while ((i = t.indexOf(q, i)) !== -1) { c++; i += q.length; }
                return c;
              })()`
            }).catch(() => null);

            // window.find() highlights and scrolls to the match natively,
            // visible through screencast without any custom overlay
            const findResp = await sessionCommand(sessionId, 'Runtime.evaluate', {
              expression: `window.find(${textJson}, ${cs}, ${bw}, true)`
            }).catch(() => null);

            clientSend({
              type: 'findResult',
              found: findResp?.result?.result?.value === true,
              count: countResp?.result?.result?.value || 0
            });
          }
          break;

        case 'findClear':
          if (sessionId) {
            sessionCommand(sessionId, 'Runtime.evaluate', {
              expression: 'window.getSelection().removeAllRanges()'
            }).catch(() => {});
          }
          break;
      }
    } catch (err) {
      log.error('viewer message error:', err?.message || err);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log.info(`Browser bridge listening on http://0.0.0.0:${PORT}`);
});
