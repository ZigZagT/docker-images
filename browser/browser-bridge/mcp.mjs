// MCP (Model Context Protocol) endpoint for the browser bridge.
//
// Mounted at /mcp by server.mjs. Spec: streamable HTTP transport from
// modelcontextprotocol.io 2025-06-18. Stateless — every POST is
// self-contained, no Mcp-Session-Id tracking. Multiple agents share the
// same browser session (which is the bridge itself).
//
// Three integration points with server.mjs:
//   - createMcpHandler(deps)  → the HTTP handler
//   - getMcpState()           → MCP per-tab metadata for the tabs broadcast
//   - noteTabClosed(targetId) → cleanup hook fired on Target.targetDestroyed
//
// MCP tools dispatch the SAME bridge events the viewer's WS handler uses
// (deps.dispatchBridgeEvent). The events ARE the API. MCP-specific
// concerns (FIFO ownership, attention) ride ON TOP — they don't reinvent
// tab mutation.
//
// Stealth: tools deliberately avoid Runtime.enable / Console.enable /
// Debugger.enable on tab sessions. test 41 (cdp-not-detectable) catches
// any regression. Runtime.evaluate is a one-shot command and does NOT
// require enable; we use it directly.

import crypto from 'node:crypto';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'browser-bridge', version: '1.0.0' };

const MCP_MAX_OPEN_TABS = Math.max(1, parseInt(process.env.MCP_MAX_OPEN_TABS || '3', 10));
const MCP_MAX_ATTENTION = Math.max(1, parseInt(process.env.MCP_MAX_ATTENTION || '3', 10));

// Insertion-order Map → FIFO. Key = targetId, value = { openedAt, uuid,
// markerInstalled }. uuid is the sessionStorage marker stamped into the tab
// for cross-restart identity (see "Persistence & cross-restart identity"
// below); markerInstalled tracks whether the stamp succeeded on this session.
const mcpOwnedTabs = new Map();
// Map<targetId, { message, since }>. Capacity-limited at MCP_MAX_ATTENTION.
const attentionRequests = new Map();
// Per-tab snapshot UID map. After browser_get_snapshot we hand the agent
// stable UIDs ([uid=42]) to use with browser_click/type/etc instead of
// authoring CSS selectors. Each entry: { snapshotId, idToBackend: Map<string, number> }.
// Replaced wholesale on each new snapshot — UIDs from a stale snapshot
// throw a clear error so the agent re-snapshots before retrying.
const tabSnapshots = new Map();

// --- Dev mode per-tab state ---
// Opt-in dev mode enables CDP domains (Runtime, Log, Network) on a tab's
// session, unlocking console/network/dialog/popup tools. Default tabs stay
// clean (no Runtime.enable etc.) preserving stealth posture.
const DEV_LOG_CAP = 1000;
const DEV_NET_CAP = 1000;
const DEV_POPUP_CAP = 200;

// targetId → { consoleLogs[], networkRequests: Map, networkBodies: Map,
//   popupLog[], dialogHandler, pendingDialog, popupScriptId }
const devModeTabs = new Map();

export function isDevMode(targetId) {
  return devModeTabs.has(targetId);
}

function requireDevMode(tabId) {
  if (!devModeTabs.has(tabId)) {
    throw new Error('tab ' + tabId + ' is not in dev mode — call browser_set_dev_mode(tabId, true) first');
  }
  return devModeTabs.get(tabId);
}

// Called by server.mjs's poolSessionHandler for every CDP event on dev-mode tabs.
export function devModeSessionHandler(targetId, msg, deps) {
  const state = devModeTabs.get(targetId);
  if (!state) return;

  if (msg.method === 'Runtime.consoleAPICalled') {
    const p = msg.params;
    const entry = {
      type: 'console',
      level: p.type,
      text: (p.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '),
      ts: Date.now(),
    };
    state.consoleLogs.push(entry);
    if (state.consoleLogs.length > DEV_LOG_CAP) state.consoleLogs.shift();
  }

  if (msg.method === 'Runtime.exceptionThrown') {
    const ex = msg.params?.exceptionDetails;
    if (ex) {
      const entry = {
        type: 'exception',
        level: 'error',
        text: ex.text + (ex.exception?.description ? ' ' + ex.exception.description : ''),
        source: ex.url || '',
        line: ex.lineNumber,
        col: ex.columnNumber,
        ts: Date.now(),
      };
      state.consoleLogs.push(entry);
      if (state.consoleLogs.length > DEV_LOG_CAP) state.consoleLogs.shift();
    }
  }

  if (msg.method === 'Log.entryAdded') {
    const e = msg.params?.entry;
    if (e) {
      const entry = {
        type: 'log',
        level: e.level,
        text: e.text || '',
        source: e.source || '',
        url: e.url || '',
        line: e.lineNumber,
        ts: Date.now(),
      };
      state.consoleLogs.push(entry);
      if (state.consoleLogs.length > DEV_LOG_CAP) state.consoleLogs.shift();
    }
  }

  if (msg.method === 'Network.requestWillBeSent') {
    const p = msg.params;
    if (state.networkRequests.size >= DEV_NET_CAP) {
      const oldest = state.networkRequests.keys().next().value;
      state.networkRequests.delete(oldest);
      state.networkBodies.delete(oldest);
    }
    state.networkRequests.set(p.requestId, {
      requestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      type: p.type || '',
      ts: Date.now(),
      status: null,
      mimeType: null,
      size: 0,
      done: false,
      failed: false,
      errorText: null,
    });
  }

  if (msg.method === 'Network.responseReceived') {
    const p = msg.params;
    const req = state.networkRequests.get(p.requestId);
    if (req) {
      req.status = p.response.status;
      req.mimeType = p.response.mimeType;
    }
  }

  if (msg.method === 'Network.dataReceived') {
    const p = msg.params;
    const req = state.networkRequests.get(p.requestId);
    if (req) req.size += p.dataLength || 0;
  }

  if (msg.method === 'Network.loadingFinished') {
    const req = state.networkRequests.get(msg.params.requestId);
    if (req) req.done = true;
  }

  if (msg.method === 'Network.loadingFailed') {
    const p = msg.params;
    const req = state.networkRequests.get(p.requestId);
    if (req) {
      req.done = true;
      req.failed = true;
      req.errorText = p.errorText || null;
    }
  }

  if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__devPopup') {
    try {
      const data = JSON.parse(msg.params.payload);
      state.popupLog.push({
        url: data.url || '',
        target: data.target || '',
        features: data.features || '',
        blocked: !!data.blocked,
        ts: Date.now(),
        resultingTabId: null,
      });
      if (state.popupLog.length > DEV_POPUP_CAP) state.popupLog.shift();
    } catch {}
  }

  if (msg.method === 'Page.javascriptDialogOpening') {
    const p = msg.params;
    const dialog = {
      type: p.type,
      message: p.message || '',
      defaultPrompt: p.defaultPrompt || '',
      url: p.url || '',
      ts: Date.now(),
    };

    if (state.dialogHandler === 'auto-accept') {
      const entry = deps.sessionPool.get(targetId);
      if (entry) deps.sessionCommand(entry.sessionId, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    } else if (state.dialogHandler === 'auto-dismiss') {
      const entry = deps.sessionPool.get(targetId);
      if (entry) deps.sessionCommand(entry.sessionId, 'Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    } else {
      state.pendingDialog = dialog;
    }
  }

  if (msg.method === 'Page.javascriptDialogClosed') {
    state.pendingDialog = null;
  }
}

const stateListeners = new Set();
function notifyStateChanged() {
  for (const fn of stateListeners) {
    try { fn(); } catch { /* ignore */ }
  }
  // Every ownership/attention mutation flushes to disk (debounced) so the
  // persisted snapshot tracks memory. schedulePersist is hoisted.
  schedulePersist();
}

export function getMcpState() {
  const owned = {};
  for (const [id, meta] of mcpOwnedTabs) owned[id] = { openedAt: meta.openedAt };
  const attention = {};
  for (const [id, meta] of attentionRequests) attention[id] = { message: meta.message, since: meta.since };
  const devMode = {};
  for (const id of devModeTabs.keys()) devMode[id] = true;
  return { owned, attention, devMode, limits: { maxTabs: MCP_MAX_OPEN_TABS, maxAttention: MCP_MAX_ATTENTION } };
}

export function noteTabClosed(targetId) {
  let changed = false;
  if (mcpOwnedTabs.delete(targetId)) changed = true;
  if (attentionRequests.delete(targetId)) changed = true;
  tabSnapshots.delete(targetId);
  if (devModeTabs.delete(targetId)) changed = true;
  if (changed) notifyStateChanged();
}

// When a page opens a child (window.open, target=_blank, Ctrl+click), the
// child inherits MCP ownership from its opener so the FIFO cap applies
// transitively.  Returns { inherited, evicted: [targetId...] }.  Callers
// must close evicted tabs themselves (async) — this function only removes
// them from the ownership map synchronously.
export function inheritMcpOwnership(childTargetId, openerTargetId) {
  if (!openerTargetId || !mcpOwnedTabs.has(openerTargetId)) return { inherited: false, evicted: [] };
  const evicted = [];
  while (mcpOwnedTabs.size >= MCP_MAX_OPEN_TABS) {
    const oldest = mcpOwnedTabs.keys().next().value;
    if (attentionRequests.has(oldest)) break;
    mcpOwnedTabs.delete(oldest);
    evicted.push(oldest);
  }
  mcpOwnedTabs.set(childTargetId, { openedAt: Date.now(), uuid: crypto.randomUUID(), markerInstalled: false });
  notifyStateChanged();
  // Stamp the marker so the inherited child survives a restart too. Async +
  // best-effort: the child target may not be attached yet, in which case
  // stampOwnershipMarker re-tries on the tab's next navigation.
  if (mcpDeps) stampOwnershipMarker(mcpDeps, childTargetId).catch(() => {});
  return { inherited: true, evicted };
}

// Used by the viewer's "dismiss" button on the attention floating box.
// Equivalent to browser_dismiss_attention but originates from the human,
// not the agent — server-side state is the same either way.
export function clearAttention(targetId) {
  if (attentionRequests.delete(targetId)) {
    notifyStateChanged();
    return true;
  }
  return false;
}

export function onMcpStateChange(fn) {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

// --- Persistence & cross-restart identity ---
//
// Background: MCP-owned/attention state lived only in these in-memory Maps, so
// it evaporated on any bridge restart and — worse — on a browser (Chrome)
// restart, where session-restore brings the *tabs* back but Chrome mints
// brand-new targetIds. The old code's pruneStaleTabs() deliberately discarded
// every entry whose targetId no longer matched, so ownership was lost. There
// is no CDP-exposed identifier stable across a Chrome restart, so we anchor on
// two restored properties instead of targetId, in priority order:
//
//   1. sessionStorage UUID — stamped into each owned tab and read back after
//      restart. Chrome session-restore preserves sessionStorage, so the UUID
//      is an exact, unique key. Stamped via Page.addScriptToEvaluateOnNewDocument
//      (re-applies on every future document, so it self-heals across
//      cross-origin navigations that would otherwise drop the per-origin value)
//      plus an immediate Runtime.evaluate for the already-loaded document.
//      Unavailable on opaque origins (data:, sandboxed) where sessionStorage
//      throws — those fall back to (2).
//   2. navigation-history hash — sha256 of the back/forward entry URL list +
//      current index (Page.getNavigationHistory). This is *browser* metadata,
//      restored regardless of the document's origin, so it covers the
//      opaque-origin tabs the UUID can't. Hashed because a data: URL history
//      entry can be huge. Matched only when it resolves to exactly ONE
//      unclaimed live tab — an ambiguous match is left unclaimed rather than
//      risk stealing a user tab. There is deliberately NO tab-order tier:
//      restore does not guarantee stable order.
//
// about:blank / contentless tabs are intentionally unsupported: no marker, no
// history, nothing to re-own — and they carry no state worth preserving.
//
// The whole scheme only pays off when Chrome is configured to restore the
// session ("continue where you left off"); the launcher leaves that to the
// user's chrome://settings (see chrome-launcher). Without restore the tabs
// don't come back and there's nothing to match against — a no-op, not a bug.

const MARKER_KEY = '__bb_mcp';

// Module-level deps handle, set by createMcpHandler — lets mutation, persist,
// and rehydrate paths reach CDP (sessionCommand/poolAttach) and disk
// (persistMcpState/loadMcpState) without threading `deps` through every caller.
let mcpDeps = null;

function markerSource(uuid) {
  // Stamp only the top document. Subframe sessionStorage is per-origin; marking
  // frames would scatter extra detectable keys across embedded origins for no
  // benefit (we only re-identify the top-level tab).
  return `try{if(window.top===window){var k=${JSON.stringify(MARKER_KEY)};` +
         `if(!sessionStorage.getItem(k))sessionStorage.setItem(k,${JSON.stringify(uuid)});}}catch(e){}`;
}

async function stampOwnershipMarker(d, targetId) {
  const meta = mcpOwnedTabs.get(targetId);
  if (!meta || meta.markerInstalled) return;
  if (!meta.uuid) meta.uuid = crypto.randomUUID();
  try {
    await d.poolAttach(targetId);
    const entry = d.sessionPool.get(targetId);
    if (!entry) return;
    // Register for every future document so the marker survives navigation...
    await d.sessionCommand(entry.sessionId, 'Page.addScriptToEvaluateOnNewDocument', { source: markerSource(meta.uuid) });
    // ...and stamp the document that's already loaded.
    await d.sessionCommand(entry.sessionId, 'Runtime.evaluate', {
      expression: `(()=>{try{if(window.top===window)sessionStorage.setItem(${JSON.stringify(MARKER_KEY)},${JSON.stringify(meta.uuid)});}catch(e){}})()`,
      returnByValue: true,
    });
    meta.markerInstalled = true;
  } catch {
    // Opaque origin (sessionStorage throws) or transient CDP error. Leave
    // markerInstalled false so onOwnedTabNavigated retries once the tab lands
    // on a storable origin. History-hash identity still covers it meanwhile.
  }
}

async function readOwnershipMarker(d, targetId) {
  try {
    await d.poolAttach(targetId);
    const entry = d.sessionPool.get(targetId);
    if (!entry) return null;
    const r = await d.sessionCommand(entry.sessionId, 'Runtime.evaluate', {
      expression: `(()=>{try{return window.top===window?(sessionStorage.getItem(${JSON.stringify(MARKER_KEY)})||null):null;}catch(e){return null;}})()`,
      returnByValue: true,
    });
    return r.result?.result?.value || null;
  } catch { return null; }
}

async function navHistoryHash(d, targetId) {
  try {
    await d.poolAttach(targetId);
    const entry = d.sessionPool.get(targetId);
    if (!entry) return null;
    const r = await d.sessionCommand(entry.sessionId, 'Page.getNavigationHistory', {});
    const h = r.result;
    if (!h || !Array.isArray(h.entries) || h.entries.length === 0) return null;
    const basis = h.entries.map(e => e.url).join('\n') + '\0' + h.currentIndex;
    return crypto.createHash('sha256').update(basis).digest('hex');
  } catch { return null; }
}

// Persist writes are serialized and coalesced. Serialization matters for
// correctness: two overlapping persists could finish out of order and leave an
// older snapshot on disk. The persisting/persistQueued pair guarantees a fresh
// write always follows the latest mutation, with no overlap.
let persistTimer = null;
let persisting = false;
let persistQueued = false;

function schedulePersist() {
  if (!mcpDeps || !mcpDeps.persistMcpState) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; runPersist(); }, 400);
}

async function runPersist() {
  if (persisting) { persistQueued = true; return; }
  persisting = true;
  try {
    await persistNow(mcpDeps);
  } catch (e) {
    mcpDeps?.log?.error?.('mcp state persist failed:', e.message);
  } finally {
    persisting = false;
    if (persistQueued) { persistQueued = false; runPersist(); }
  }
}

async function persistNow(d) {
  // Snapshot the id set + metadata synchronously, THEN read histories. The
  // hash reads await, but the record set is fixed up front so it stays
  // internally consistent even if a tool mutates the Maps mid-flight.
  const ids = new Set([...mcpOwnedTabs.keys(), ...attentionRequests.keys()]);
  const snap = [];
  for (const id of ids) snap.push({ id, meta: mcpOwnedTabs.get(id) || null, att: attentionRequests.get(id) || null });
  for (const s of snap) s.hash = await navHistoryHash(d, s.id);
  const tabs = snap.map(s => ({
    owned: !!s.meta,
    uuid: s.meta?.uuid || null,
    historyHash: s.hash,
    openedAt: s.meta?.openedAt ?? null,
    attention: s.att ? { message: s.att.message, since: s.att.since } : null,
  }));
  tabs.sort((a, b) => (a.openedAt ?? Infinity) - (b.openedAt ?? Infinity));
  await d.persistMcpState(JSON.stringify({ version: 1, tabs }));
}

// Re-establish ownership after a (re)connect by matching persisted records to
// live tabs. Serialized via a promise chain so a reconnect-triggered rehydrate
// and the cold-start one never interleave. Called by server.mjs on reconnect,
// and once lazily on the first tool call (ensureRehydrated) for a cold bridge.
let rehydrateChain = Promise.resolve();
let ensureRehydratedPromise = null;

export function rehydrateOwnership(d, pages) {
  rehydrateChain = rehydrateChain.then(() => doRehydrate(d, pages)).catch(e => {
    d?.log?.error?.('mcp rehydrate failed:', e.message);
  });
  return rehydrateChain;
}

// Cold-bridge rehydration, run exactly once. Memoized as a PROMISE (not a
// boolean) so concurrent first tool calls all await the same in-flight
// rehydration — a boolean flag would let the second caller proceed against a
// not-yet-rebuilt map.
function ensureRehydrated(d) {
  if (!ensureRehydratedPromise) {
    ensureRehydratedPromise = (async () => {
      let pages = [];
      try {
        const targets = await d.getCdpTargets();
        pages = targets.filter(t => t.type === 'page');
      } catch { /* not connected yet — nothing to rehydrate against */ }
      await rehydrateOwnership(d, pages);
    })();
  }
  return ensureRehydratedPromise;
}

async function doRehydrate(d, pages) {
  if (!d.loadMcpState) return;
  let records = [];
  const raw = await d.loadMcpState();
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.tabs)) records = obj.tabs;
    } catch { /* corrupt state file — start clean */ }
  }
  // Nothing persisted and nothing stale in memory → no work.
  if (!records.length && mcpOwnedTabs.size === 0 && attentionRequests.size === 0) return;

  const probes = await Promise.all(pages.map(async p => ({
    id: p.id,
    marker: await readOwnershipMarker(d, p.id),
    hash: await navHistoryHash(d, p.id),
  })));

  records.sort((a, b) => (a.openedAt ?? Infinity) - (b.openedAt ?? Infinity));
  const used = new Set();
  const matched = []; // { rec, id }

  // Pass 1 — exact UUID match (normal origins).
  for (const rec of records) {
    if (!rec.uuid) continue;
    const m = probes.find(pr => !used.has(pr.id) && pr.marker && pr.marker === rec.uuid);
    if (m) { used.add(m.id); matched.push({ rec, id: m.id }); rec._matched = true; }
  }
  // Pass 2 — history hash, only when it resolves to exactly one free tab
  // (opaque-origin tabs the UUID couldn't reach). Ambiguous → left unclaimed.
  for (const rec of records) {
    if (rec._matched || !rec.historyHash) continue;
    const cands = probes.filter(pr => !used.has(pr.id) && pr.hash && pr.hash === rec.historyHash);
    if (cands.length === 1) { used.add(cands[0].id); matched.push({ rec, id: cands[0].id }); }
  }

  const owned = matched.filter(m => m.rec.owned)
    .sort((a, b) => (a.rec.openedAt ?? Infinity) - (b.rec.openedAt ?? Infinity));
  const live = new Set(pages.map(p => p.id));

  // Synchronous commit — no awaits between clear and rebuild, so no concurrent
  // tool handler ever observes a half-rebuilt Map. Map insertion order follows
  // openedAt, preserving FIFO age.
  mcpOwnedTabs.clear();
  attentionRequests.clear();
  for (const m of owned) {
    mcpOwnedTabs.set(m.id, { openedAt: m.rec.openedAt ?? Date.now(), uuid: m.rec.uuid || null, markerInstalled: false });
  }
  for (const m of matched) {
    if (m.rec.attention) attentionRequests.set(m.id, { message: m.rec.attention.message, since: m.rec.attention.since });
  }
  // targetIds changed on a browser restart; drop session-bound state for any id
  // not live (same cleanup the old pruneStaleTabs did for these two Maps).
  for (const id of tabSnapshots.keys()) if (!live.has(id)) tabSnapshots.delete(id);
  for (const id of devModeTabs.keys()) if (!live.has(id)) devModeTabs.delete(id);
  notifyStateChanged();

  // Re-arm markers on the new sessions, and upgrade history-only matches (no
  // uuid) to a fresh UUID so next restart can match them exactly. Best-effort,
  // after the commit.
  for (const id of mcpOwnedTabs.keys()) stampOwnershipMarker(d, id).catch(() => {});
}

// Called by server.mjs when an MCP-owned tab finishes a main-frame navigation:
// refresh the persisted history fingerprint, and stamp the UUID marker if it
// wasn't installable before (e.g. the tab just moved off an opaque origin).
export function onOwnedTabNavigated(targetId) {
  if (!mcpOwnedTabs.has(targetId)) return;
  if (mcpDeps) stampOwnershipMarker(mcpDeps, targetId).catch(() => {});
  schedulePersist();
}

// --- Server-level instructions ---
//
// MCP spec: the `initialize` response can include an `instructions` field
// that's the canonical "read me first" doc shown to every agent at
// handshake. This is where cross-cutting concerns live (ownership, FIFO,
// attention workflow, recommended sequencing). Per-tool descriptions stay
// focused on what THAT tool does.

const SERVER_INSTRUCTIONS = `
You are driving a real Chromium browser through a long-lived bridge. Multiple agents
and a human user can share this browser at the same time, so be a good neighbor.

# Tab ownership

There are two kinds of tabs:

- **MCP-owned**: tabs YOU opened via browser_open. Counted against an FIFO cap
  (default ${MCP_MAX_OPEN_TABS}). When you exceed the cap, the OLDEST MCP-owned tab is auto-closed.
- **User-owned**: tabs the human opened (or another agent opened). Never counted
  against your FIFO; never auto-closed. You can navigate/read/interact with them
  freely, but only CLOSE them if the user explicitly asks.

You don't manage cleanup — FIFO eviction handles MCP-owned tabs automatically.

# Recommended workflow

1. Call browser_list_tabs FIRST. The browser may already have what you need.
2. If a tab fits your purpose, reuse it via browser_navigate(tabId, url) — does
   not consume an FIFO slot.
3. Only call browser_open(url) when you genuinely need a new tab.
4. browser_reload(tabId) re-fetches a tab if it got into a bad state.
5. browser_close_tab(tabId) closes any tab — but you don't usually need to
   close MCP-owned tabs (FIFO handles it). Only close USER-owned tabs if the
   user explicitly asked you to.

# Reading pages — pick the right tool

- **browser_get_snapshot** is the PRIMARY page-read tool. Returns a compact
  hierarchical view of the page based on the accessibility tree, with stable
  UIDs you pass directly to browser_click / browser_type / browser_scroll_into_view.
  Each line is \`[uid=N] role "name" [state]\`. Filter is Puppeteer's
  interestingOnly — landmarks, controls, focusable, named leaves only;
  layout/decorative noise dropped. Start here.
- browser_get_text — full document.body.innerText (or scoped to a selector).
  Use for raw content with no structure (article body text).
- browser_get_html(tabId, path, maxDepth) — last resort, single-element
  inspection. HTML is markup-heavy and burns tokens; only when you need
  exact attributes or hidden DOM the snapshot dropped.
- browser_screenshot — only for visual confirmation (layout, image content).

# Interacting with pages — use UIDs from snapshot, never browser_evaluate

For ANY user input — clicks, typing, key presses, scrolling — use the dedicated
tools. They dispatch trusted CDP input events (isTrusted=true) that bot-protected
sites can't distinguish from a real human. Synthetic JS events from
browser_evaluate (element.click(), dispatchEvent) carry isTrusted=false and
will be rejected by captchas, payment flows, and login forms.

The intended workflow:

1. browser_get_snapshot(tabId) → see the page structure with [uid=N] markers.
2. browser_click({tabId, uid}) / browser_type({tabId, uid, text}) / etc. — pass
   the UID directly. No CSS selectors needed.
3. Optionally pass includeSnapshot:true on actions to get an updated snapshot
   in the same response (saves a round-trip when DOM changes).

UIDs are stable until the next browser_get_snapshot on that tab. If the DOM
mutates between actions, re-snapshot. Stale UIDs throw a clear error.

Choose a location with {uid} for a snapshot element, {selector} for a matching
page element, or {x,y} for a point on the page. x/y are CSS-pixel
positions in the visible web content area (page viewport): (0,0) is its top-left
corner, x increases rightward and y downward. Browser tabs, address bar and window
borders are excluded. These are not element, document or OS-window coordinates;
screenshot pixels may be scaled differently. Scroll deltaX/deltaY specify how
far to scroll, not where to place the mouse pointer.

Available interaction tools:

- browser_click({tabId, at, mouseButton?, doubleClick?, delayMs?}) — click.
  Choose at:{uid}, at:{selector}, or at:{x,y}; uid or selector also work without at.
- browser_move_pointer({tabId, to, from?, mouseButton?}) — Move mouse pointer.
- browser_type({tabId, text, uid?, selector?}) — trusted keystrokes; uid/selector
  to focus first, omit to continue typing into already-focused element.
- browser_press_key({tabId, key}) — single named key (Enter, Tab, Escape,
  ArrowDown, etc.). Acts on currently focused element.
- browser_scroll({tabId, deltaX, deltaY, at?, method?}) — scroll the page or a
  scrollable area at the chosen location. at defaults to the visible page center.
- browser_scroll_into_view({tabId, uid}) or ({tabId, selector}) — scroll an
  element into view. method:"javascript" scrolls without mouse wheel input.

browser_evaluate is for JS evaluation specifically — reading window properties,
computing values from the DOM, dispatching custom events you wrote. NOT for
clicking or typing.

# Captcha / human-in-the-loop

If a page presents a captcha, MFA, paywall, age gate, sign-in wall, or any
human-only verification step:

1. Do NOT try to solve it yourself.
2. browser_set_attention(tabId, message). The bridge viewer pulses the tab
   and shows your message in a floating box on that tab.
3. browser_wait_for(tabId, jsExpr, timeoutMs) for an expression that becomes
   truthy after the human resolved the obstacle.
4. browser_dismiss_attention(tabId) once you confirmed progress.

A tab with PENDING attention is protected: browser_open REFUSES to evict it
via FIFO and errors with a message naming the protected tab. Dismiss the
attention or close another tab first.

Attention is capped at ${MCP_MAX_ATTENTION} concurrent requests across all agents.

# Errors and notices

- Tools throw on real errors (tab not found, attention cap reached, eviction
  blocked by attention). Read the message — it tells you what to do.
- browser_open returns a \`notice\` field when an FIFO eviction occurred. When
  present, READ IT — it explains the auto-close and how to avoid it next time.

# Dev mode

By default, tabs run in stealth posture — no extra CDP domains enabled, minimal
fingerprint surface. For debugging and inspection tasks, enable dev mode per tab:

1. browser_set_dev_mode(tabId, enabled: true) — activates Runtime, Log, and
   Network CDP domains on that tab. The viewer shows a wrench icon on dev-mode tabs.
2. Dev-mode-only tools (all require dev mode ON, error otherwise):
   - browser_get_console_logs — ring buffer of console.* calls + exceptions
   - browser_set_dialog_handler / browser_get_pending_dialog / browser_handle_dialog
     — intercept alert/confirm/prompt dialogs
   - browser_get_popup_log — captures window.open attempts (blocked or not)
   - browser_get_network_requests / browser_get_network_response — HTTP traffic log
   - browser_list_frames / browser_navigate_frame — iframe tree inspection
3. browser_evaluate gains a \`mode\` param in dev mode: 'serialize-deep' returns
   CDP deep serialization (preserves Map, Set, Date, RegExp structure).
4. Disable with browser_set_dev_mode(tabId, enabled: false) — cleans up all
   captured state for that tab.

Dev mode does NOT affect FIFO, attention, or tab ownership. It only adds
observability. Turn it on when you need to debug network, console, or dialogs;
leave it off for normal browsing to minimize detection surface.
`.trim();

// --- Helpers ---

function text(str, extra = {}) {
  return { content: [{ type: 'text', text: str }], ...extra };
}

// --- Tool registry ---
//
// Per-tool descriptions are intentionally short and focused on THIS tool's
// semantics + return shape. Cross-cutting workflow guidance lives in
// SERVER_INSTRUCTIONS so we don't repeat ourselves and agents can find
// the patterns in one place.

// --- Accessibility snapshot ---
//
// The PRIMARY page-read tool. Translates Chromium's accessibility tree
// (Accessibility.getFullAXTree) into compact role+name lines an agent
// can scan top-to-bottom, with stable UIDs the agent can pass to
// browser_click / browser_type / browser_scroll_into_view.
//
// Filter algorithm is ported verbatim from Puppeteer's
// Accessibility.serializeTree (MIT licensed). The full unfiltered AX tree
// includes every text-leaf (StaticText, InlineTextBox), every layout
// table, every anonymous div — produces 50+KB of mostly noise. Puppeteer
// solved this with `interestingOnly:true` filtering: nodes are skipped
// unless they're landmarks, controls, focusable, or leaf-with-name; the
// CHILDREN of skipped nodes are lifted up to the parent so structure is
// preserved.
//
// Reference: https://github.com/puppeteer/puppeteer .../cdp/Accessibility.ts

const TEXT_ONLY_ROLES = new Set(['LineBreak', 'text', 'InlineTextBox', 'StaticText']);
const LANDMARK_ROLES = new Set([
  'banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search',
]);
const CONTROL_ROLES = new Set([
  'button', 'checkbox', 'ColorWell', 'combobox', 'DisclosureTriangle', 'listbox',
  'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'radio',
  'scrollbar', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox',
  'tree', 'treeitem',
]);
const LEAFY_ROLES = new Set([
  'doc-cover', 'graphics-symbol', 'img', 'image', 'Meter', 'scrollbar',
  'slider', 'separator', 'progressbar',
]);

function axProp(node, key) {
  return node[key]?.value;
}
function axBoolProp(node, name) {
  for (const p of (node.properties || [])) {
    if (p.name === name) return p.value?.value === true;
  }
  return false;
}

function isPlainTextField(role, node) {
  if (role === 'textbox' || role === 'searchbox') return true;
  const editable = axBoolProp(node, 'editable');
  const richlyEditable = axBoolProp(node, 'richlyEditable');
  return editable && !richlyEditable;
}

function isLeafNode(node, role) {
  if (!node.childIds || node.childIds.length === 0) return true;
  if (TEXT_ONLY_ROLES.has(role)) return true;
  if (isPlainTextField(role, node)) return true;
  if (LEAFY_ROLES.has(role)) return true;
  if (role === 'heading' && axProp(node, 'name')) return true;
  return false;
}

function isInteresting(node, insideControl) {
  const role = axProp(node, 'role') || '';
  if (role === 'Ignored' || role === 'none' || role === 'presentation') return false;
  if (node.ignored) return false;
  // Text-leaf roles (StaticText, InlineTextBox, LineBreak, text) are NEVER
  // interesting — their content is already exposed via the named parent's
  // `name` property. Without this guard the snapshot triplicates every
  // labelled element (`link "X" / StaticText "X" / InlineTextBox "X"`).
  if (TEXT_ONLY_ROLES.has(role)) return false;
  // 'generic' wrappers without a name or description are anonymous div
  // wrappers — usually layout, no semantic content. Skip and lift children.
  if (role === 'generic' && !axProp(node, 'name') && !axProp(node, 'description')) return false;
  // Layout-table family ('LayoutTable', 'LayoutTableRow', 'LayoutTableCell')
  // is structural-only — lift children, don't emit the wrappers.
  if (role.startsWith('Layout')) return false;
  if (LANDMARK_ROLES.has(role)) return true;
  if (CONTROL_ROLES.has(role)) return true;
  if (axBoolProp(node, 'focusable')) return true;
  // Leaf with a name (or value/description) is interesting unless it's
  // already inside a control — the control's own label already conveys it.
  if (insideControl) return false;
  if (isLeafNode(node, role)) {
    return !!(axProp(node, 'name') || axProp(node, 'value') || axProp(node, 'description'));
  }
  return false;
}

// Walk the AX tree, build the interesting set + a node lookup. Mirrors
// Puppeteer's collectInterestingNodes — propagates insideControl through
// descent so a button's text children get suppressed (their text is in
// the button's name).
function collectInteresting(nodes) {
  const byId = new Map();
  for (const n of nodes) byId.set(n.nodeId, n);
  const root = nodes.find(n => !n.parentId) || nodes[0];
  const interesting = new Set();
  function visit(nodeId, insideControl) {
    const n = byId.get(nodeId);
    if (!n) return;
    if (isInteresting(n, insideControl)) interesting.add(nodeId);
    const role = axProp(n, 'role') || '';
    // 'link' isn't strictly a control in Puppeteer's CONTROL_ROLES list,
    // but for our purposes its child leaves (heading/image/text) usually
    // duplicate the link's accessible name — Amazon product cards are
    // the worst offenders. Treat link as "control-like" so child leaves
    // are suppressed.
    const childInsideControl = insideControl || CONTROL_ROLES.has(role) || role === 'link';
    for (const childId of (n.childIds || [])) visit(childId, childInsideControl);
  }
  if (root) visit(root.nodeId, false);
  return { byId, root, interesting };
}

// Format one interesting node as a single line. UIDs are sequential
// integers assigned during the walk.
function formatNode(node, uid, depth) {
  const role = axProp(node, 'role') || 'unknown';
  const name = axProp(node, 'name');
  const value = axProp(node, 'value');
  const description = axProp(node, 'description');

  let line = '  '.repeat(depth) + '[uid=' + uid + '] ' + role;
  if (name) line += ' ' + JSON.stringify(String(name).replace(/\s+/g, ' ').slice(0, 200));
  if (value !== undefined && value !== null && value !== '' && value !== name) {
    line += ' value=' + JSON.stringify(String(value).slice(0, 100));
  }
  if (description && description !== name) {
    line += ' description=' + JSON.stringify(String(description).slice(0, 100));
  }
  // Boolean states the agent might care about for action planning.
  const states = [];
  for (const stateName of ['focused', 'disabled', 'required', 'expanded', 'checked', 'selected', 'invalid', 'readonly']) {
    if (axBoolProp(node, stateName)) states.push(stateName);
  }
  if (states.length) line += ' [' + states.join(',') + ']';
  return line;
}

// Render the tree as text + populate idToBackend so subsequent
// browser_click(uid) can resolve to a real element.
function renderSnapshot(nodes) {
  if (!nodes || nodes.length === 0) return { text: '(empty accessibility tree)', idToBackend: new Map() };
  const { byId, root, interesting } = collectInteresting(nodes);
  const idToBackend = new Map();
  let nextUid = 1;
  const lines = [];
  function walk(nodeId, depth) {
    const n = byId.get(nodeId);
    if (!n) return;
    const isKept = interesting.has(nodeId);
    const childDepth = isKept ? depth + 1 : depth;
    if (isKept) {
      const uid = String(nextUid++);
      lines.push(formatNode(n, uid, depth));
      // Map uid → backend DOM node so click/type can find the real
      // element later. Some AX nodes don't have a backendDOMNodeId
      // (e.g. iframe wrappers) — those uids won't be clickable; the
      // resolver throws a clear error in that case.
      if (n.backendDOMNodeId !== undefined) idToBackend.set(uid, n.backendDOMNodeId);
    }
    for (const childId of (n.childIds || [])) walk(childId, childDepth);
  }
  if (root) walk(root.nodeId, 0);
  return { text: lines.join('\n'), idToBackend };
}

// Shared JS body for selecting an <option> element and returning the
// parent <select>'s center. Used by both UID and selector resolve paths.
const OPTION_SELECT_JS = `
  if (this.tagName !== 'OPTION') return null;
  this.selected = true;
  const sel = this.closest('select');
  if (!sel) return null;
  sel.dispatchEvent(new Event('input', {bubbles: true}));
  sel.dispatchEvent(new Event('change', {bubbles: true}));
  const r = sel.getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2 };
`;

// Resolve a uid (or selector) to bounding-box center coords. Used by
// click and type for trusted CDP input dispatch.
async function resolveTarget(d, tabId, { uid, selector }) {
  await d.poolAttach(tabId);
  const entry = d.sessionPool.get(tabId);
  if (!entry) throw new Error('tab not found: ' + tabId);

  // UID path — look up backendNodeId in the per-tab snapshot map, then
  // ask CDP for the box model. UIDs are stable only within the most
  // recent snapshot for that tab; older UIDs throw.
  if (uid) {
    const snap = tabSnapshots.get(tabId);
    if (!snap) throw new Error('uid ' + uid + ' has no live snapshot — call browser_get_snapshot first');
    const backend = snap.idToBackend.get(String(uid));
    if (backend === undefined) {
      throw new Error('uid ' + uid + ' not in current snapshot — re-snapshot the page (the DOM may have changed)');
    }
    const box = await d.sessionCommand(entry.sessionId, 'DOM.getBoxModel', { backendNodeId: backend });
    if (!box.error) {
      // content quad is 8 numbers: [x1,y1, x2,y2, x3,y3, x4,y4] (TL, TR, BR, BL).
      const c = box.result.model.content;
      const cx = (c[0] + c[4]) / 2;
      const cy = (c[1] + c[5]) / 2;
      return { entry, x: cx, y: cy };
    }
    // getBoxModel fails for elements in CSS top layer (e.g. base-select
    // popover options). Resolve via JS instead.
    const resolved = await d.sessionCommand(entry.sessionId, 'DOM.resolveNode', { backendNodeId: backend });
    if (resolved.error) throw new Error('uid ' + uid + ' has no box and cannot be resolved: ' + resolved.error.message);
    const objId = resolved.result.object.objectId;
    // <option> elements have zero geometry even in base-select pickers.
    // Select via JS and return the parent <select>'s center so the
    // subsequent cdpClickAt closes the picker.
    const optResult = await d.sessionCommand(entry.sessionId, 'Runtime.callFunctionOn', {
      objectId: objId,
      functionDeclaration: `function() {${OPTION_SELECT_JS}}`,
      returnByValue: true,
    });
    if (!optResult.error && optResult.result?.result?.value) {
      const coords = optResult.result.result.value;
      return { entry, x: coords.x, y: coords.y };
    }
    // General fallback: getBoundingClientRect for non-option top-layer elements.
    const rectResult = await d.sessionCommand(entry.sessionId, 'Runtime.callFunctionOn', {
      objectId: objId,
      functionDeclaration: 'function() { const r = this.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height }; }',
      returnByValue: true,
    });
    if (rectResult.error) throw new Error('uid ' + uid + ' has no box (offscreen or zero-size): ' + box.error.message);
    const rect = rectResult.result?.result?.value;
    if (!rect || (rect.w === 0 && rect.h === 0)) {
      throw new Error('uid ' + uid + ' has no box (offscreen or zero-size): ' + box.error.message);
    }
    return { entry, x: rect.x, y: rect.y };
  }

  // Selector path — CSS or XPath.
  if (!selector) throw new Error('uid or selector required');
  const expr = `(() => {
    const path = ${JSON.stringify(selector)};
    const isXpath = path.startsWith('/') || path.startsWith('(/');
    let el;
    try {
      if (isXpath) {
        const r = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        el = r.singleNodeValue;
      } else {
        el = document.querySelector(path);
      }
    } catch (e) { return JSON.stringify({ error: 'invalid selector: ' + e.message }); }
    if (!el) return JSON.stringify({ error: 'no element matches: ' + path });
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      const optCoords = (function() {${OPTION_SELECT_JS}}).call(el);
      if (optCoords) return JSON.stringify(optCoords);
      return JSON.stringify({ error: 'element has zero size — call browser_scroll_into_view first' });
    }
    return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2 });
  })()`;
  const r = await d.sessionCommand(entry.sessionId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.error) throw new Error(r.error.message);
  const parsed = JSON.parse(r.result?.result?.value || '{}');
  if (parsed.error) throw new Error(parsed.error);
  return { entry, x: parsed.x, y: parsed.y };
}

// Spatial targets resolve to viewport coordinates without scrolling or focusing.
const POINT_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'Use {uid}, {selector}, or {x,y}. Elements must already be visible; the center of their visible area must not be covered. Coordinates must be inside the visible page and address whatever is there.',
  properties: {
    uid: { type: 'string', description: 'Element ID from the latest browser_get_snapshot for this tab. If the ID is no longer valid, get a new snapshot.' },
    selector: { type: 'string', description: 'Find the first matching page element with a CSS selector, or an XPath beginning with / or (/. Searches the main document, not embedded frames or component interiors (shadow roots).' },
    x: { type: 'number', description: 'Horizontal CSS-pixel position in the visible web content area (page viewport); x increases rightward. (0,0) is its top-left corner. Browser tabs, address bar and window borders are excluded. Not relative to an element, document or OS window; screenshot pixels may have a different scale.' },
    y: { type: 'number', description: 'Vertical CSS-pixel position in the visible web content area (page viewport); y increases downward. (0,0) is its top-left corner. Browser tabs, address bar and window borders are excluded. Not relative to an element, document or OS window; screenshot pixels may have a different scale.' },
  },
  oneOf: [{ required: ['uid'] }, { required: ['selector'] }, { required: ['x', 'y'] }],
};
async function inputCommand(d, sid, method, params = {}, timeout) {
  const r = await d.sessionCommand(sid, method, params, timeout);
  if (r.error) throw new Error(method + ': ' + r.error.message);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result;
}
async function inputSession(d, tabId) {
  await d.poolAttach(tabId);
  const entry = d.sessionPool.get(tabId);
  if (!entry) throw new Error('tab not found: ' + tabId);
  return entry.sessionId;
}
function validatePoint(target, elementOnly = false) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('Expected {uid}, {selector}, or {x,y}');
  const keys = Object.keys(target).filter(k => target[k] !== undefined);
  if (keys.length === 1 && ['uid', 'selector'].includes(keys[0]) && typeof target[keys[0]] === 'string' && target[keys[0]]) return;
  if (!elementOnly && keys.length === 2 && keys.includes('x') && keys.includes('y') && Number.isFinite(target.x) && Number.isFinite(target.y)) return;
  throw new Error(elementOnly ? 'Provide exactly one uid or selector' : 'Provide exactly one target: {uid}, {selector}, or finite {x,y}');
}
async function withElement(d, tabId, target, fn) {
  validatePoint(target, true);
  const sid = await inputSession(d, tabId);
  let object;
  if (target.uid !== undefined) {
    const backendNodeId = tabSnapshots.get(tabId)?.idToBackend.get(target.uid);
    if (backendNodeId === undefined) throw new Error('Missing/stale uid; call browser_get_snapshot');
    object = (await inputCommand(d, sid, 'DOM.resolveNode', { backendNodeId })).object;
  } else {
    const q = JSON.stringify(target.selector);
    const xpath = target.selector.startsWith('/') || target.selector.startsWith('(/');
    object = (await inputCommand(d, sid, 'Runtime.evaluate', {
      expression: xpath ? `document.evaluate(${q},document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue` : `document.querySelector(${q})`,
    })).result;
  }
  if (!object?.objectId) throw new Error('Target not found');
  try { return await fn(sid, object.objectId); }
  finally { await d.sessionCommand(sid, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}); }
}
async function inspectElement(d, sid, objectId, fn) {
  const r = await inputCommand(d, sid, 'Runtime.callFunctionOn', { objectId, functionDeclaration: fn.toString(), returnByValue: true });
  if (r.result?.value?.error) throw new Error(r.result.value.error);
  return r.result?.value;
}
async function inputPoint(d, tabId, target) {
  validatePoint(target);
  const sid = await inputSession(d, tabId);
  if (target.x !== undefined) {
    const { result } = await inputCommand(d, sid, 'Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight})', returnByValue: true });
    if (target.x < 0 || target.y < 0 || target.x >= result.value.width || target.y >= result.value.height) throw new Error('Coordinates outside viewport');
    return { x: target.x, y: target.y };
  }
  return withElement(d, tabId, target, (session, objectId) => inspectElement(d, session, objectId, function () {
    const r = this.getBoundingClientRect();
    let left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
    let top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    const accepts = (x, y) => {
      const hit = this.getRootNode().elementFromPoint?.(x, y) || document.elementFromPoint(x, y);
      return hit === this || this.contains(hit);
    };
    // Browser hit-testing knows containing blocks: fixed/absolute descendants can
    // escape an overflow ancestor, but not a transformed containing block's clip.
    if (right > left && bottom > top && accepts((left + right) / 2, (top + bottom) / 2))
      return { x: (left + right) / 2, y: (top + bottom) / 2 };
    for (let el = this.parentElement; el; el = el.parentElement) {
      const s = getComputedStyle(el), q = el.getBoundingClientRect();
      if (s.overflowX !== 'visible') { left = Math.max(left, q.left); right = Math.min(right, q.right); }
      if (s.overflowY !== 'visible') { top = Math.max(top, q.top); bottom = Math.min(bottom, q.bottom); }
    }
    if (right <= left || bottom <= top) return { error: 'Target is offscreen or clipped; scroll it into view first' };
    const x = (left + right) / 2, y = (top + bottom) / 2;
    const hit = this.getRootNode().elementFromPoint?.(x, y) || document.elementFromPoint(x, y);
    if (hit !== this && !this.contains(hit)) return { error: 'Target is obscured or has no hit-test geometry' };
    return { x, y };
  }));
}
// Serialize activation to keep the wheel recipient rendering until dispatch completes.
// Restore the viewed tab while leaving its screencast subscription unchanged.
let scrollTail = Promise.resolve();
async function withScrollRendering(d, tabId, fn) {
  const previous = scrollTail;
  let unlock;
  scrollTail = new Promise(resolve => { unlock = resolve; });
  await previous;
  try {
    const sid = await inputSession(d, tabId);
    await inputCommand(d, sid, 'Page.bringToFront');
    return await fn(sid);
  } finally {
    try {
      const viewed = d.viewedTarget?.();
      const entry = viewed && viewed !== tabId && d.sessionPool.get(viewed);
      if (entry) await inputCommand(d, entry.sessionId, 'Page.bringToFront');
    } finally { unlock(); }
  }
}
async function scrollAt(d, tabId, { deltaX, deltaY, at, method }) {
  const sid = await inputSession(d, tabId);
  const pos = at ? await inputPoint(d, tabId, at) : (await inputCommand(d, sid, 'Runtime.evaluate', {
    expression: '({x:innerWidth/2,y:innerHeight/2})', returnByValue: true,
  })).result.value;
  // Keep node identities through dispatch: re-hit-testing after movement would
  // compare unrelated elements and incorrectly claim movement at boundaries.
  const object = (await inputCommand(d, sid, 'Runtime.evaluate', {
    expression: `(() => {
      const nodes=[];
      let hit=document.elementFromPoint(${pos.x},${pos.y});
      // Document hit-testing retargets shadow descendants to the host. Descend
      // through open roots, then retain the composed ancestry across slots/hosts.
      while(hit?.shadowRoot) {
        const inner=hit.shadowRoot.elementFromPoint(${pos.x},${pos.y});
        if(!inner || inner===hit) break;
        hit=inner;
      }
      for(let el=hit;el && !nodes.includes(el);el=el.assignedSlot || el.parentElement || el.getRootNode().host) nodes.push(el);
      if(document.scrollingElement && !nodes.includes(document.scrollingElement)) nodes.push(document.scrollingElement);
      return nodes;
    })()`,
  })).result;
  if (!object?.objectId) throw new Error('Cannot observe scroll target');
  const read = () => inspectElement(d, sid, object.objectId, function () {
    return this.map(el => ({ tag: el.tagName, id: el.id, x: el.scrollLeft, y: el.scrollTop }));
  });
  try {
    const before = await read();
    if (method === 'javascript') {
      await inputCommand(d, sid, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function(dx,dy) {
          const root=document.scrollingElement;
          for(const [axis,delta] of [['X',dx],['Y',dy]]) {
            if(!delta) continue;
            const el=this.find(el => {
              const s=getComputedStyle(el), horizontal=axis==='X';
              const pos=horizontal?el.scrollLeft:el.scrollTop;
              const max=horizontal?el.scrollWidth-el.clientWidth:el.scrollHeight-el.clientHeight;
              return (el===root || /auto|scroll/.test(horizontal?s.overflowX:s.overflowY)) && (delta>0?pos<max:pos>0);
            });
            if(el) el.scrollBy({left:axis==='X'?delta:0,top:axis==='Y'?delta:0,behavior:'instant'});
          }
        }`,
        arguments: [{ value: deltaX }, { value: deltaY }], returnByValue: true,
      });
    } else {
      await inputCommand(d, sid, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...pos, buttons: 0 });
      await inputCommand(d, sid, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...pos, deltaX, deltaY }, 3000);
    }
    let after = before;
    // CDP acknowledges wheel dispatch before asynchronous scrolling completes.
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 30));
      after = await read();
      if (JSON.stringify(before) !== JSON.stringify(after)) break;
    }
    return { method, at: pos, deltaX, deltaY, moved: JSON.stringify(before) !== JSON.stringify(after), before, after };
  } finally { await d.sessionCommand(sid, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}); }
}

// Build a fresh snapshot for a tab and store its uid map. Shared by
// browser_get_snapshot AND the includeSnapshot flag on action tools.
async function buildAndStoreSnapshot(d, tabId) {
  await d.poolAttach(tabId);
  const entry = d.sessionPool.get(tabId);
  if (!entry) throw new Error('tab not found: ' + tabId);
  const r = await d.sessionCommand(entry.sessionId, 'Accessibility.getFullAXTree', {});
  if (r.error) throw new Error(r.error.message);
  const { text, idToBackend } = renderSnapshot(r.result?.nodes || []);
  tabSnapshots.set(tabId, { snapshotId: Date.now().toString(36), idToBackend });
  return text;
}

// --- Internal helpers used by interaction tools ---

// Each click or drag completes its press/move/release sequence within one call.
const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const BUTTON_MASK = { left: 1, right: 2, middle: 4 };
const spatialBusy = new Set();
const spatialFaults = new Set();
async function withSpatialInput(sid, fn) {
  if (spatialFaults.has(sid)) throw new Error('Previous pointer cleanup failed; input state is uncertain. Use a fresh tab.');
  if (spatialBusy.has(sid)) throw new Error('Another spatial gesture is in progress on this tab; retry after it finishes');
  spatialBusy.add(sid);
  try { return await fn(); } finally { spatialBusy.delete(sid); }
}
function pointerModifiers(modifiers = []) {
  if (!Array.isArray(modifiers) || modifiers.some(name => !Object.hasOwn(MODIFIER_BITS, name))) throw new Error('modifiers must contain alt, ctrl, meta or shift');
  return modifiers.reduce((bits, name) => bits | MODIFIER_BITS[name], 0);
}
function pointerOptions({ button = 'left', doubleClick = false, delayMs = 0 }) {
  if (!Object.hasOwn(BUTTON_MASK, button)) throw new Error('mouseButton must be left, middle or right');
  if (typeof doubleClick !== 'boolean') throw new Error('doubleClick must be boolean');
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 1000) throw new Error('delayMs must be 0–1000');
  return { button, doubleClick, delayMs };
}
async function cdpPointer(d, sid, from, to, { button, modifiers = 0, doubleClick = false, delayMs = 0 } = {}) {
  return withSpatialInput(sid, async () => {
    const send = (type, pos, buttons, clickCount = 1) => inputCommand(d, sid, 'Input.dispatchMouseEvent', {
      type, ...pos, button: button || 'none', buttons, modifiers, clickCount,
    });
    if (!button) {
      await send('mouseMoved', to, 0, 0);
      return;
    }
    let held = false, last = from;
    try {
      await send('mouseMoved', from, 0, 0);
      for (let count = 1; count <= (doubleClick ? 2 : 1); count++) {
        held = true; // A failed transport reply does not prove the press was rejected.
        await send('mousePressed', from, BUTTON_MASK[button], count);
        if (from.x !== to.x || from.y !== to.y) {
          last = to;
          await send('mouseMoved', to, BUTTON_MASK[button], 0);
          // A second event at the same destination lets Chromium deliver dragover
          // after dragenter.
          await send('mouseMoved', to, BUTTON_MASK[button], 0);
        }
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        await send('mouseReleased', to, 0, count);
        held = false;
      }
    } catch (error) {
      if (held) {
        let suppressed = false;
        const cleanupErrors = [];
        try {
          // Cancellation must not activate a click/drop on the release target.
          await inputCommand(d, sid, 'Input.setIgnoreInputEvents', { ignore: true });
          suppressed = true;
          try { await inputCommand(d, sid, 'Input.cancelDragging'); } catch (e) { cleanupErrors.push(e.message); }
          try { await send('mouseReleased', last, 0, 0); } catch (e) { cleanupErrors.push(e.message); }
        } catch (e) { cleanupErrors.push(e.message); }
        finally {
          // Re-enable input even when the suppression command fails.
          try { await inputCommand(d, sid, 'Input.setIgnoreInputEvents', { ignore: false }); } catch (e) { cleanupErrors.push(e.message); }
        }
        if (!suppressed || cleanupErrors.length) {
          spatialFaults.add(sid);
          throw new Error(error.message + '; pointer cleanup failed; input state uncertain, use a fresh tab: ' + cleanupErrors.join('; '));
        }
      }
      throw error;
    }
  });
}
async function cdpClickAt(d, sessionId, x, y, modifiers = 0, options = {}) {
  const point = { x, y };
  await cdpPointer(d, sessionId, point, point, { ...pointerOptions(options), modifiers });
}

// Common special-key map for browser_press_key.
const KEY_MAP = {
  Enter:     { code: 'Enter',     key: 'Enter',     vk: 13,  text: '\r' },
  Tab:       { code: 'Tab',       key: 'Tab',       vk: 9 },
  Escape:    { code: 'Escape',    key: 'Escape',    vk: 27 },
  Backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  Delete:    { code: 'Delete',    key: 'Delete',    vk: 46 },
  ArrowUp:   { code: 'ArrowUp',   key: 'ArrowUp',   vk: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  ArrowRight:{ code: 'ArrowRight',key: 'ArrowRight',vk: 39 },
  Home:      { code: 'Home',      key: 'Home',      vk: 36 },
  End:       { code: 'End',       key: 'End',       vk: 35 },
  PageUp:    { code: 'PageUp',    key: 'PageUp',    vk: 33 },
  PageDown:  { code: 'PageDown',  key: 'PageDown',  vk: 34 },
  Space:     { code: 'Space',     key: ' ',         vk: 32, text: ' ' },
};

const TOOLS = [
  {
    name: 'browser_list_tabs',
    description:
      'List all open tabs. Returns: { tabs: [{ id, url, title, mcpOwned, attention }], ' +
      'mcpOwnedCount, mcpOwnedCap, attentionCount, attentionCap }. ' +
      'Call this BEFORE browser_open to find existing tabs you can reuse via browser_navigate.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, d) {
      const targets = await d.getCdpTargets();
      const tabs = targets.filter(t => t.type === 'page').map(t => ({
        id: t.id,
        url: t.url,
        title: t.title,
        mcpOwned: mcpOwnedTabs.has(t.id),
        devMode: devModeTabs.has(t.id),
        attention: attentionRequests.get(t.id) || null,
      }));
      return text(JSON.stringify({
        tabs,
        mcpOwnedCount: mcpOwnedTabs.size,
        mcpOwnedCap: MCP_MAX_OPEN_TABS,
        attentionCount: attentionRequests.size,
        attentionCap: MCP_MAX_ATTENTION,
      }, null, 2));
    },
  },

  {
    name: 'browser_navigate',
    description:
      'Navigate an EXISTING tab (any tab — MCP-owned or user-owned) to the given URL. ' +
      'Does NOT consume an FIFO slot. Use this whenever you can, in preference to opening a new tab.\n\n' +
      'Returns: { tabId, url, title, mcpOwned }.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Existing tab ID (from browser_list_tabs or a prior browser_open).' },
        url: { type: 'string', description: 'Absolute URL or shorthand.' },
        includeSnapshot: { type: 'boolean', description: 'Append a fresh browser_get_snapshot to the response.' },
      },
      required: ['tabId', 'url'],
    },
    async run({ tabId, url, includeSnapshot }, d) {
      await d.dispatchBridgeEvent({ type: 'navigate', targetId: tabId, url });
      await d.poolAttach(tabId);
      const deadline = Date.now() + 8000;
      let lastUrl = '';
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250));
        const targets = await d.getCdpTargets();
        const t = targets.find(x => x.id === tabId);
        if (!t) break;
        if (t.url === lastUrl && t.url !== 'about:blank') break;
        lastUrl = t.url;
      }
      const targets = await d.getCdpTargets();
      const t = targets.find(x => x.id === tabId) || {};
      const result = { tabId, url: t.url, title: t.title, mcpOwned: mcpOwnedTabs.has(tabId) };
      if (includeSnapshot) result.snapshot = await buildAndStoreSnapshot(d, tabId);
      return text(JSON.stringify(result, null, 2));
    },
  },

  {
    name: 'browser_open',
    description:
      'Open a new MCP-owned tab at the given URL. Counted against the FIFO cap (' + MCP_MAX_OPEN_TABS + '). ' +
      'Use browser_navigate (not this) if a tab already exists you can reuse — see browser_list_tabs.\n\n' +
      'When the FIFO is at cap, the OLDEST MCP-owned tab is auto-closed to make room. ' +
      'EXCEPTION: if that tab has a pending attention request, this tool throws an error instead — ' +
      'attention-bearing tabs are protected from FIFO eviction so the human-in-the-loop is never silently destroyed. ' +
      'Dismiss the attention or close a different tab first.\n\n' +
      'Returns: { tabId, url, title, evicted: [tabId], notice?: string }. ' +
      'When `notice` is present, an FIFO eviction occurred — read it.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL or shorthand (example.com → https://example.com).' },
        includeSnapshot: { type: 'boolean', description: 'Append a fresh browser_get_snapshot to the response.' },
      },
      required: ['url'],
    },
    async run({ url, includeSnapshot }, d) {
      const evicted = [];
      let notice = null;

      // FIFO eviction (with attention guard) BEFORE creating, so we never
      // momentarily exceed the cap.
      while (mcpOwnedTabs.size >= MCP_MAX_OPEN_TABS) {
        const oldest = mcpOwnedTabs.keys().next().value;
        if (attentionRequests.has(oldest)) {
          throw new Error(
            `Cannot open new tab: would FIFO-evict tabId ${oldest} which has a pending attention request ` +
            `(message: "${attentionRequests.get(oldest).message.slice(0, 80)}..."). ` +
            `Attention-bearing tabs are protected. Dismiss the attention via browser_dismiss_attention, ` +
            `or close a different MCP-owned tab via browser_close_tab.`
          );
        }
        mcpOwnedTabs.delete(oldest);
        try {
          await d.dispatchBridgeEvent({ type: 'closeTab', targetId: oldest });
          evicted.push(oldest);
        } catch (err) {
          d.log.error('mcp FIFO evict failed for', oldest + ':', err.message);
        }
      }

      const create = await d.dispatchBridgeEvent({ type: 'newTab', url });
      const tabId = create.targetId;
      mcpOwnedTabs.set(tabId, { openedAt: Date.now(), uuid: crypto.randomUUID(), markerInstalled: false });
      notifyStateChanged();
      if (evicted.length) {
        notice =
          `FIFO at cap (${MCP_MAX_OPEN_TABS}) — auto-closed older MCP tab(s): ${evicted.join(', ')}. ` +
          `Before opening more new tabs, call browser_list_tabs to see what already exists; ` +
          `pass an existing tabId to browser_navigate instead of opening another new tab.`;
      }

      // Best-effort load wait — poll the URL until stable or 8s elapses.
      await d.poolAttach(tabId);
      // Stamp the cross-restart marker now that the tab is attached.
      await stampOwnershipMarker(d, tabId);
      const deadline = Date.now() + 8000;
      let lastUrl = '';
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250));
        const targets = await d.getCdpTargets();
        const t = targets.find(x => x.id === tabId);
        if (!t) break;
        if (t.url === lastUrl && t.url !== 'about:blank') break;
        lastUrl = t.url;
      }
      const targets = await d.getCdpTargets();
      const t = targets.find(x => x.id === tabId) || {};
      const result = { tabId, url: t.url, title: t.title, evicted };
      if (notice) result.notice = notice;
      if (includeSnapshot) result.snapshot = await buildAndStoreSnapshot(d, tabId);
      return text(JSON.stringify(result, null, 2));
    },
  },

  {
    name: 'browser_reload',
    description:
      'Reload an existing tab (Page.reload via CDP). Returns: { tabId, url, title }. ' +
      'Set includeSnapshot:true to receive an updated browser_get_snapshot in the response.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        includeSnapshot: { type: 'boolean' },
      },
      required: ['tabId'],
    },
    async run({ tabId, includeSnapshot }, d) {
      await d.dispatchBridgeEvent({ type: 'reload', targetId: tabId });
      await new Promise(r => setTimeout(r, 500));
      const targets = await d.getCdpTargets();
      const t = targets.find(x => x.id === tabId) || {};
      const result = { tabId, url: t.url, title: t.title };
      if (includeSnapshot) result.snapshot = await buildAndStoreSnapshot(d, tabId);
      return text(JSON.stringify(result, null, 2));
    },
  },

  {
    name: 'browser_close_tab',
    description:
      'Close a tab. Frees the MCP FIFO slot if the tab was MCP-owned. ' +
      'Only close USER-owned tabs when explicitly asked.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
    },
    async run({ tabId }, d) {
      await d.dispatchBridgeEvent({ type: 'closeTab', targetId: tabId });
      noteTabClosed(tabId);
      return text('closed: ' + tabId);
    },
  },

  {
    name: 'browser_get_snapshot',
    description:
      'PRIMARY page-read tool. Returns a compact hierarchical text view of the page based ' +
      'on the accessibility tree, with stable UIDs for direct interaction.\n\n' +
      'Each line: `[uid=N] role "name" [state]` indented by depth. The UIDs let you call ' +
      'browser_click({tabId, uid}), browser_type({tabId, uid, text}), browser_scroll_into_view ' +
      '({tabId, uid}) WITHOUT authoring CSS selectors — just reference the role+name you ' +
      'see in the snapshot.\n\n' +
      'Filter follows Puppeteer\'s interestingOnly logic — landmarks, controls, focusables, ' +
      'and named leaves are kept; layout tables, anonymous divs, and per-text-leaf nodes ' +
      'are dropped (their content is already in the parent\'s name). Output is typically ' +
      '5-10× smaller than raw HTML for the same page.\n\n' +
      'UIDs are valid until the next browser_get_snapshot on this tab — re-snapshot if the ' +
      'DOM mutates between actions.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
    },
    async run({ tabId }, d) {
      const out = await buildAndStoreSnapshot(d, tabId);
      return text(out);
    },
  },

  {
    name: 'browser_get_text',
    description:
      'Return the rendered text content of a tab as a flat string (no hierarchy). ' +
      'For raw content extraction (article body, transcript). When you need structure or ' +
      'interactive elements, use browser_get_snapshot instead.\n\n' +
      'With optional `selector` (CSS or XPath), returns innerText of that element subtree.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        selector: { type: 'string', description: 'Optional CSS selector or XPath. Default: document.body.' },
      },
      required: ['tabId'],
    },
    async run({ tabId, selector }, d) {
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);
      const expr = selector
        ? `(() => {
            const path = ${JSON.stringify(selector)};
            const isXpath = path.startsWith('/') || path.startsWith('(/');
            let el;
            try {
              if (isXpath) {
                const r = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                el = r.singleNodeValue;
              } else {
                el = document.querySelector(path);
              }
            } catch (e) { return JSON.stringify({ error: 'invalid selector: ' + e.message }); }
            if (!el) return JSON.stringify({ error: 'no element matches: ' + path });
            return JSON.stringify({ text: el.innerText || '' });
          })()`
        : '(document.body && document.body.innerText) || ""';
      const r = await d.sessionCommand(entry.sessionId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.error) throw new Error(r.error.message);
      const v = r.result?.result?.value;
      if (selector) {
        const parsed = JSON.parse(v || '{}');
        if (parsed.error) throw new Error(parsed.error);
        return text(parsed.text || '');
      }
      return text(v || '');
    },
  },

  {
    name: 'browser_evaluate',
    description:
      'Run JavaScript in the page context of a tab and return the value. ' +
      'For JS-specific reads — window properties, computed values from the DOM, custom events. ' +
      'Do NOT use for clicking, typing, or scrolling — use browser_click / browser_type / ' +
      'browser_press_key / browser_scroll, which dispatch trusted CDP events that bot detection ' +
      'can\'t distinguish from real input.\n\n' +
      'Wrap multi-statement code as `(()=>{ ... })()` or `(async()=>{ ... })()`; await is supported ' +
      '(the tool sets awaitPromise:true). Multi-step automation can be written as a single async IIFE ' +
      'that performs sequential operations and returns a final result.\n\n' +
      'Returns the value as JSON for objects/arrays, otherwise as a string. By default, return values ' +
      'are JSON-stringified (returnByValue:true) — DOM nodes, functions, and circular refs become null. ' +
      'Pass mode:"serialize-deep" for full CDP deep serialization (handles Maps, Sets, RegExp, Date, ' +
      'Error, ArrayBuffer, typed arrays, Proxy, generators, WeakRef). ' +
      'Page exceptions return as text starting with "Exception:" and isError=true.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        expression: { type: 'string' },
        mode: { type: 'string', enum: ['json', 'serialize-deep'], description: 'Return serialization mode. "json" (default): returnByValue. "serialize-deep": CDP deep serialization for complex types.' },
      },
      required: ['tabId', 'expression'],
    },
    async run({ tabId, expression, mode }, d) {
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);

      const useDeep = mode === 'serialize-deep';
      const evalParams = {
        expression,
        awaitPromise: true,
        userGesture: true,
      };
      if (useDeep) {
        evalParams.generatePreview = true;
        evalParams.serializationOptions = { serialization: 'deep', maxDepth: 10 };
      } else {
        evalParams.returnByValue = true;
      }

      const r = await d.sessionCommand(entry.sessionId, 'Runtime.evaluate', evalParams);
      if (r.error) throw new Error(r.error.message);
      const ed = r.result?.exceptionDetails;
      if (ed) {
        return text('Exception: ' + (ed.text || '') + ' ' + (ed.exception?.description || ''), { isError: true });
      }

      if (useDeep) {
        const result = r.result?.result;
        const deep = result?.deepSerializedValue;
        if (deep) return text(JSON.stringify(deep, null, 2));
        if (result?.preview) return text(JSON.stringify(result.preview, null, 2));
        const val = result?.value;
        return text(val !== undefined ? JSON.stringify(val, null, 2) : String(result?.description || result?.type || 'undefined'));
      }

      const val = r.result?.result?.value;
      const out = (val !== null && typeof val === 'object') ? JSON.stringify(val, null, 2) : String(val);
      return text(out);
    },
  },

  {
    name: 'browser_get_html',
    description:
      'Last-resort: HTML of elements matching a selector, truncated to maxDepth nesting levels. ' +
      'Markup-heavy and token-expensive — prefer browser_get_snapshot for exploration and ' +
      'browser_get_text for content. Reach for this ONLY when you need exact attributes, ' +
      'hidden DOM, or markup the snapshot/text views can\'t express, AND scope to a small selector.\n\n' +
      'Selector is CSS by default, XPath if it starts with "/" or "(/". When a subtree exceeds ' +
      'maxDepth, deeper children become `<!--[N children, truncated at depth M]-->`.\n\n' +
      'Returns: { matchCount: N, matches: [htmlString, ...] }.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        path: { type: 'string', description: 'CSS selector or XPath (XPath if it starts with / or (/).' },
        maxDepth: { type: 'integer', description: 'Maximum DOM nesting depth to include in the returned HTML.' },
      },
      required: ['tabId', 'path', 'maxDepth'],
    },
    async run({ tabId, path, maxDepth }, d) {
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);
      // The whole serializer runs in the page context — cheaper and more
      // accurate than fetching the full HTML and post-processing here.
      // Each match is serialized recursively up to maxDepth; deeper subtrees
      // become a single comment placeholder so token usage stays bounded.
      const expr = `(() => {
        const path = ${JSON.stringify(path)};
        const maxDepth = ${JSON.stringify(maxDepth)};
        const isXpath = path.startsWith('/') || path.startsWith('(/');
        let nodes = [];
        try {
          if (isXpath) {
            const r = document.evaluate(path, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < r.snapshotLength; i++) nodes.push(r.snapshotItem(i));
          } else {
            nodes = Array.from(document.querySelectorAll(path));
          }
        } catch (e) {
          return JSON.stringify({ error: 'invalid selector: ' + e.message });
        }
        const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
        function escAttr(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
        function serialize(node, depth) {
          if (node.nodeType === 3 /* TEXT */) return node.textContent;
          if (node.nodeType === 8 /* COMMENT */) return '<!--' + node.textContent + '-->';
          if (node.nodeType !== 1 /* ELEMENT */) return '';
          const tag = node.tagName.toLowerCase();
          let attrs = '';
          for (const a of node.attributes) attrs += ' ' + a.name + '="' + escAttr(a.value) + '"';
          if (VOID.has(tag)) return '<' + tag + attrs + '/>';
          if (depth >= maxDepth && node.childNodes.length > 0) {
            return '<' + tag + attrs + '><!--[' + node.children.length + ' children, truncated at depth ' + maxDepth + ']--></' + tag + '>';
          }
          let inner = '';
          for (const c of node.childNodes) inner += serialize(c, depth + 1);
          return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
        }
        return JSON.stringify({
          matchCount: nodes.length,
          matches: nodes.map(n => serialize(n, 0)),
        });
      })()`;
      const r = await d.sessionCommand(entry.sessionId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.error) throw new Error(r.error.message);
      const ed = r.result?.exceptionDetails;
      if (ed) throw new Error('get_html eval failed: ' + (ed.text || ed.exception?.description));
      const parsed = JSON.parse(r.result?.result?.value || '{}');
      if (parsed.error) throw new Error(parsed.error);
      return text(JSON.stringify(parsed, null, 2));
    },
  },

  {
    name: 'browser_click',
    description:
      'Click. Choose at:{uid}, at:{selector}, or at:{x,y}; alternatively, supply uid or selector without at.\n\n' +
      'x/y are CSS-pixel positions in the visible web content area (page viewport): (0,0) is its top-left corner, x increases rightward and y downward. ' +
      'Browser tabs, address bar and window borders are excluded. These are not element, document or OS-window coordinates; screenshot pixels may be scaled differently.\n\n' +
      'mouseButton defaults to "left". doubleClick:true clicks twice; delayMs holds each press for 0–1000 ms (default 0). ' +
      'Ctrl/Meta-click and middle-click may open tabs; check browser_list_tabs.\n\n' +
      'Returns clickedAt, mouseButton, doubleClick and delayMs. includeSnapshot:true adds a fresh snapshot. ' +
      'If an error reports uncertain mouse input state, use a new tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: "ID of the tab to use, from browser_list_tabs or browser_open." },
        at: { ...POINT_SCHEMA, description: 'Where to click. ' + POINT_SCHEMA.description },
        mouseButton: { type: 'string', enum: ['left', 'middle', 'right'], default: 'left', description: "Mouse button to click: left (default), middle or right." },
        doubleClick: { type: 'boolean', default: false, description: "Set true for a double-click, or false (default) for one click." },
        delayMs: { type: 'integer', minimum: 0, maximum: 1000, default: 0, description: "How long to hold the mouse button before releasing it, in milliseconds (0\u20131000, default 0). Applies to each press, not the gap between clicks." },
        uid: { type: 'string', description: "Element ID from the latest browser_get_snapshot for this tab. Choose uid, selector or at; do not combine them." },
        selector: { type: 'string', description: "Find the first matching page element with a CSS selector, or an XPath beginning with / or (/. Searches the main document, not embedded frames or component interiors (shadow roots). Choose selector, uid or at; do not combine them." },
        modifiers: { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] }, description: "Keys held during the mouse action: alt, ctrl (Control), meta (Command on macOS), or shift. Omit or use [] for none." },
        includeSnapshot: { type: 'boolean', description: "Set true to add a new browser_get_snapshot result after clicking. Omit or set false to return only the click result." },
      },
      required: ['tabId'],
      oneOf: [{ required: ['at'] }, { required: ['uid'] }, { required: ['selector'] }],
    },
    async run({ tabId, uid, selector, at, modifiers, mouseButton = 'left', doubleClick = false, delayMs = 0, includeSnapshot }, d) {
      const options = pointerOptions({ button: mouseButton, doubleClick, delayMs });
      const bits = pointerModifiers(modifiers);
      if (at !== undefined && (uid !== undefined || selector !== undefined)) throw new Error('Use at OR uid/selector, not both');
      const { x, y } = await inputPoint(d, tabId, at ?? { uid, selector });
      const sid = await inputSession(d, tabId);

      // Ctrl/Meta-click and middle-click open links in a new tab. Chrome does not set openerId
      // on the new target, so Target.targetCreated cannot inherit MCP ownership.
      // Snapshot tab IDs before the click to detect new tabs after.
      const mayOpenTab = (mouseButton === 'middle' || (bits & (MODIFIER_BITS.ctrl | MODIFIER_BITS.meta))) && mcpOwnedTabs.has(tabId);
      let tabIdsBefore;
      if (mayOpenTab) {
        tabIdsBefore = new Set((await d.getCdpTargets()).filter(t => t.type === 'page').map(t => t.id));
      }

      await cdpClickAt(d, sid, x, y, bits, options);

      if (tabIdsBefore) {
        await new Promise(r => setTimeout(r, 500));
        const tabsAfter = (await d.getCdpTargets()).filter(t => t.type === 'page');
        for (const t of tabsAfter) {
          if (!tabIdsBefore.has(t.id)) {
            const r = inheritMcpOwnership(t.id, tabId);
            for (const id of r.evicted) {
              d.dispatchBridgeEvent({ type: 'closeTab', targetId: id }).catch(() => {});
            }
          }
        }
      }

      const result = { tabId, uid: uid || null, selector: selector || null, clickedAt: { x, y }, mouseButton, doubleClick, delayMs };
      if (includeSnapshot) result.snapshot = await buildAndStoreSnapshot(d, tabId);
      return text(JSON.stringify(result, null, 2));
    },
  },

  {
    name: 'browser_move_pointer',
    description:
      'Move mouse pointer.\n\n' +
      'x/y are CSS-pixel positions in the visible web content area (page viewport): (0,0) is its top-left corner, x increases rightward and y downward. ' +
      'Browser tabs, address bar and window borders are excluded. These are not element, document or OS-window coordinates; screenshot pixels may be scaled differently.\n\n' +
      'Returns movedTo; dragging also returns movedFrom, mouseButton and released:true. A completed mouse action does not guarantee the page accepted a drop. ' +
      'includeSnapshot:true adds a fresh snapshot. If an error reports uncertain mouse input state, use a new tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: "ID of the tab to use, from browser_list_tabs or browser_open." },
        to: { ...POINT_SCHEMA, description: 'Where to move the mouse pointer or end a drag. ' + POINT_SCHEMA.description },
        from: { ...POINT_SCHEMA, description: 'Drag starting point; requires mouseButton. Omit both to move without pressing. ' + POINT_SCHEMA.description },
        mouseButton: { type: 'string', enum: ['left', 'middle', 'right'], description: "Button to press at from, hold while moving to to, then release: left, middle or right. Required for dragging; no default." },
        modifiers: { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] }, description: "Keys held during the mouse action: alt, ctrl (Control), meta (Command on macOS), or shift. Omit or use [] for none." },
        includeSnapshot: { type: 'boolean', description: "Set true to add a new browser_get_snapshot result after moving or dragging. Omit or set false to return only the mouse action result." },
      },
      required: ['tabId', 'to'],
      dependentRequired: { from: ['mouseButton'], mouseButton: ['from'] },
    },
    async run({ tabId, to, from, mouseButton, modifiers, includeSnapshot }, d) {
      if ((from !== undefined) !== (mouseButton !== undefined)) throw new Error('A held-button move requires both from and mouseButton');
      if (mouseButton !== undefined) pointerOptions({ button: mouseButton });
      const bits = pointerModifiers(modifiers);
      validatePoint(to);
      if (from !== undefined) validatePoint(from);
      const end = await inputPoint(d, tabId, to);
      const start = from === undefined ? end : await inputPoint(d, tabId, from);
      const sid = await inputSession(d, tabId);
      await cdpPointer(d, sid, start, end, { button: mouseButton, modifiers: bits });
      const result = { tabId, movedTo: end, ...(mouseButton ? { movedFrom: start, mouseButton, released: true } : {}) };
      if (includeSnapshot) result.snapshot = await buildAndStoreSnapshot(d, tabId);
      return text(JSON.stringify(result, null, 2));
    },
  },

  {
    name: 'browser_type',
    description:
      'Type text into a focused element via CDP Input.insertText (trusted input). With `uid` ' +
      'or `selector`, the tool first clicks (CDP) to focus the target, then types. Without ' +
      'either, types into whatever is currently focused (use this when continuing typing into ' +
      'an input you just focused).\n\n' +
      'Special keys (Enter, Tab, Escape) go through browser_press_key, not this tool.\n\n' +
      'Set includeSnapshot:true to receive an updated browser_get_snapshot in the response.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        text: { type: 'string', description: 'Text to type. Multi-character; no special key escapes.' },
        uid: { type: 'string', description: 'UID from browser_get_snapshot to focus first.' },
        selector: { type: 'string', description: 'CSS or XPath fallback if no UID.' },
        includeSnapshot: { type: 'boolean', description: 'Append a fresh browser_get_snapshot to the response.' },
      },
      required: ['tabId', 'text'],
    },
    async run({ tabId, text: textToType, uid, selector, includeSnapshot }, d) {
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);
      if (uid || selector) {
        const r = await resolveTarget(d, tabId, { uid, selector });
        await cdpClickAt(d, entry.sessionId, r.x, r.y);
      }
      // Input.insertText is the simplest way to type a string and produces
      // trusted input events. dispatchKeyEvent per char is also valid but
      // more verbose and harder to get right for IME / unicode.
      const r = await d.sessionCommand(entry.sessionId, 'Input.insertText', { text: textToType });
      if (r.error) throw new Error(r.error.message);
      const result = { tabId, typed: textToType.length + ' chars', uid: uid || null, selector: selector || null };
      if (includeSnapshot) result.snapshot = await buildAndStoreSnapshot(d, tabId);
      return text(JSON.stringify(result, null, 2));
    },
  },

  {
    name: 'browser_press_key',
    description:
      'Dispatch a single named key (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, ' +
      'Home, End, PageUp, PageDown, Space) via trusted CDP key events. Acts on the currently ' +
      'focused element. Use this for form submission (Enter), focus traversal (Tab), modal close ' +
      '(Escape), etc.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        key: { type: 'string', description: 'Key name. Allowed: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space.' },
        includeSnapshot: { type: 'boolean', description: 'Append a fresh browser_get_snapshot to the response.' },
      },
      required: ['tabId', 'key'],
    },
    async run({ tabId, key, includeSnapshot }, d) {
      const meta = KEY_MAP[key];
      if (!meta) throw new Error('unknown key: ' + key + '. Allowed: ' + Object.keys(KEY_MAP).join(', '));
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);
      const base = { code: meta.code, key: meta.key, windowsVirtualKeyCode: meta.vk, modifiers: 0 };
      const downEvent = { ...base, type: 'keyDown' };
      if (meta.text) downEvent.text = meta.text;
      const r1 = await d.sessionCommand(entry.sessionId, 'Input.dispatchKeyEvent', downEvent);
      if (r1.error) throw new Error(r1.error.message);
      const r2 = await d.sessionCommand(entry.sessionId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
      if (r2.error) throw new Error(r2.error.message);
      const result = { tabId, key };
      if (includeSnapshot) result.snapshot = await buildAndStoreSnapshot(d, tabId);
      return text(JSON.stringify(result, null, 2));
    },
  },

  {
    name: 'browser_scroll',
    description:
      'Scroll by deltaX horizontally and deltaY vertically, in CSS pixels: positive right/down, negative left/up. ' +
      'at selects where to scroll; it defaults to the visible page center.\n\n' +
      'x/y are CSS-pixel positions in the visible web content area (page viewport): (0,0) is its top-left corner, x increases rightward and y downward. ' +
      'Browser tabs, address bar and window borders are excluded. These are not element, document or OS-window coordinates; screenshot pixels may be scaled differently.\n\n' +
      'method:"wheel" (default) sends mouse wheel input. The page may scroll less than requested or prevent scrolling. ' +
      'method:"javascript" scrolls the element at the chosen point or a containing element without mouse wheel input. ' +
      'Wheel mode temporarily activates the tab, then restores the previously viewed tab.\n\n' +
      'Returns at, the requested deltas, method, moved, and before/after lists. ' +
      'Each list entry contains tag, id, and x/y scroll positions in CSS pixels (scrollLeft/scrollTop), measured before and after the call. ' +
      'moved:true means a recorded scroll position changed; false means none changed. It does not confirm the requested distance was covered. ' +
      'Measurements include containing elements and open shadow roots, but not closed shadow roots or embedded frames.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: "ID of the tab to use, from browser_list_tabs or browser_open." },
        deltaX: { type: 'number', description: "How far to scroll horizontally, in CSS pixels: positive right, negative left, zero for no horizontal scroll." },
        deltaY: { type: 'number', description: "How far to scroll vertically, in CSS pixels: positive down, negative up, zero for no vertical scroll." },
        at: { ...POINT_SCHEMA, description: 'Where to scroll, for example inside a scrollable list; defaults to the visible page center. ' + POINT_SCHEMA.description },
        method: { type: 'string', enum: ['wheel', 'javascript'], default: 'wheel', description: "wheel (default) sends mouse wheel input at the location chosen by at. javascript scrolls the element there or a containing element without mouse wheel input." },
      },
      required: ['tabId', 'deltaX', 'deltaY'],
    },
    async run({ tabId, deltaX, deltaY, at, method = 'wheel' }, d) {
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new Error('deltaX/deltaY must be finite numbers');
      if (!['wheel', 'javascript'].includes(method)) throw new Error('method must be wheel or javascript');
      if (at !== undefined) validatePoint(at);
      const run = () => scrollAt(d, tabId, { deltaX, deltaY, at, method });
      const sid = await inputSession(d, tabId);
      const result = await withSpatialInput(sid, () => method === 'wheel' ? withScrollRendering(d, tabId, run) : run());
      return text(JSON.stringify({ tabId, ...result }, null, 2));
    },
  },

  {
    name: 'browser_scroll_into_view',
    description:
      'Scroll until the element has a visible point that can receive mouse input. The whole element need not fit onscreen. ' +
      'Choose uid or selector.\n\n' +
      'method:"wheel" (default) scrolls containing areas from inner to outer where possible. ' +
      'maxSteps limits wheel inputs to 1–100 (default 30). Failure can leave the page partly scrolled: scrolling may stop making progress, reach the limit, or leave the chosen point hidden or covered. ' +
      'method:"javascript" scrolls without mouse wheel input; maxSteps must still be valid but does not limit this mode. ' +
      'Both methods check that another element does not cover the chosen point. Wheel mode temporarily activates the tab, then restores the previously viewed tab.\n\n' +
      'Returns visible:true, method, steps (wheel inputs; zero in javascript mode), moved, and before/after lists of containing elements. ' +
      'Each entry contains tag, id, and x/y scroll positions in CSS pixels (scrollLeft/scrollTop), measured before and after the call. ' +
      'moved:true means a recorded scroll position changed; false means none changed. Measurements exclude the target itself and stop at a shadow root. ' +
      'includeSnapshot:true adds a fresh snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: "ID of the tab to use, from browser_list_tabs or browser_open." },
        uid: { type: 'string', description: "Element ID from the latest browser_get_snapshot for this tab. Use uid or selector, not both." },
        selector: { type: 'string', description: "Find the first matching page element with a CSS selector, or an XPath beginning with / or (/. Searches the main document, not embedded frames or component interiors (shadow roots). Use selector or uid, not both." },
        method: { type: 'string', enum: ['wheel', 'javascript'], default: 'wheel', description: "wheel (default) uses mouse wheel input to reveal the element. javascript asks the browser to reveal it without mouse wheel input." },
        maxSteps: { type: 'integer', minimum: 1, maximum: 100, default: 30, description: "Maximum number of mouse wheel inputs: 1\u2013100, default 30. Must be valid in either mode, but only limits wheel mode." },
        includeSnapshot: { type: 'boolean', description: "Set true to add a new browser_get_snapshot result after scrolling. Omit or set false to return only the scrolling result." },
      },
      required: ['tabId'],
      oneOf: [{ required: ['uid'] }, { required: ['selector'] }],
    },
    async run({ tabId, uid, selector, method = 'wheel', maxSteps = 30, includeSnapshot }, d) {
      if (!['wheel', 'javascript'].includes(method)) throw new Error('method must be wheel or javascript');
      if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error('maxSteps must be 1–100');
      const target = { uid, selector };
      validatePoint(target, true);
      const run = () => withElement(d, tabId, target, async (sid, objectId) => {
        const positions = () => inspectElement(d, sid, objectId, function () {
          const result = [];
          for (let el = this.parentElement; el; el = el.parentElement) result.push({ tag: el.tagName, id: el.id, x: el.scrollLeft, y: el.scrollTop });
          return result;
        });
        const before = await positions();
        let steps = 0;
        if (method === 'javascript') {
          await inputCommand(d, sid, 'DOM.scrollIntoViewIfNeeded', { objectId });
        } else {
          for (;;) {
            // A hit-testable target needs no scrolling, even if its DOM ancestors
            // are clipped (e.g. fixed positioning outside a non-containing block).
            try { await inputPoint(d, tabId, target); break; } catch {}
            const plan = await inspectElement(d, sid, objectId, function () {
              if (!this.isConnected) return { error: 'Target detached' };
              const r = this.getBoundingClientRect();
              if (!r.width || !r.height) return { error: 'Target has no geometry' };
              const ancestors = [];
              for (let el = this.parentElement; el; el = el.parentElement) ancestors.push(el);
              for (const el of ancestors) {
                const root = el === document.scrollingElement, s = getComputedStyle(el);
                const q = root ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : el.getBoundingClientRect();
                // Aim for the nearest visible portion, including oversized targets.
                const distance = (a, b, min, max) => a < min && b > max ? 0 : a < min ? a - min : b > max ? Math.min(b - max, a - min) : 0;
                let left = Math.max(0, q.left), right = Math.min(innerWidth, q.right);
                let top = Math.max(0, q.top), bottom = Math.min(innerHeight, q.bottom);
                for (let parent = el.parentElement; parent; parent = parent.parentElement) {
                  const p = parent.getBoundingClientRect(), style = getComputedStyle(parent);
                  if (style.overflowX !== 'visible') { left = Math.max(left, p.left); right = Math.min(right, p.right); }
                  if (style.overflowY !== 'visible') { top = Math.max(top, p.top); bottom = Math.min(bottom, p.bottom); }
                }
                if (right <= left || bottom <= top) continue;
                // Seek into the reachable part of this scroller, not its full
                // rectangle: an outer clip can hide an otherwise in-range target.
                const dx = root || /auto|scroll/.test(s.overflowX) ? distance(r.left, r.right, left, right) : 0;
                const dy = root || /auto|scroll/.test(s.overflowY) ? distance(r.top, r.bottom, top, bottom) : 0;
                if (!dx && !dy) continue;
                const x = (left + right) / 2, y = (top + bottom) / 2, hit = document.elementFromPoint(x, y);
                if (!root && hit !== el && !el.contains(hit)) return { error: 'Scroll container is obscured' };
                return { at: { x, y }, deltaX: Math.max(-600, Math.min(600, dx)), deltaY: Math.max(-600, Math.min(600, dy)) };
              }
              return { done: true };
            });
            if (plan.done) break;
            if (steps >= maxSteps) throw new Error('Wheel scroll exceeded maxSteps; target may still be offscreen');
            const result = await scrollAt(d, tabId, { ...plan, method });
            steps++;
            if (!result.moved) throw new Error('Wheel made no progress: scrolling prevented, clipped, or at boundary');
          }
        }
        await inputPoint(d, tabId, target); // Verify actual visible, hit-testable geometry.
        const after = await positions();
        return { tabId, method, visible: true, steps, moved: JSON.stringify(before) !== JSON.stringify(after), before, after };
      });
      const sid = await inputSession(d, tabId);
      const result = await withSpatialInput(sid, () => method === 'wheel' ? withScrollRendering(d, tabId, run) : run());
      if (includeSnapshot) result.snapshot = await buildAndStoreSnapshot(d, tabId);
      return text(JSON.stringify(result, null, 2));
    },
  },

  {
    name: 'browser_screenshot',
    description:
      'Capture a PNG screenshot of a tab and return it inline as base64. ' +
      'Use this only for visual checks (layout, rendering, image content) — prefer ' +
      'browser_get_text or browser_get_html for content analysis (cheaper, more accurate).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        fullPage: { type: 'boolean', description: 'Capture beyond the viewport (entire scrollable page). Default false.' },
      },
      required: ['tabId'],
    },
    async run({ tabId, fullPage = false }, d) {
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);
      const r = await d.sessionCommand(entry.sessionId, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: fullPage,
      }, 30000);
      if (r.error) throw new Error(r.error.message);
      return {
        content: [{ type: 'image', data: r.result.data, mimeType: 'image/png' }],
      };
    },
  },

  {
    name: 'browser_wait_for',
    description:
      'Poll a JavaScript expression in a tab until it returns truthy or until timeoutMs elapses. ' +
      'Returns the truthy value (object/array as JSON, primitives as string). Throws on timeout. ' +
      'Common uses: wait for a captcha to be solved (`!document.querySelector(".g-recaptcha")`), ' +
      'wait for dynamic content to appear, wait for a navigation result.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        expression: { type: 'string', description: 'JS expression — returns truthy when the wait condition is met.' },
        timeoutMs: { type: 'integer', description: 'Maximum time to wait, in milliseconds.' },
        intervalMs: { type: 'integer', description: 'Polling interval (default 250ms).' },
      },
      required: ['tabId', 'expression', 'timeoutMs'],
    },
    async run({ tabId, expression, timeoutMs, intervalMs = 250 }, d) {
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const r = await d.sessionCommand(entry.sessionId, 'Runtime.evaluate', {
          expression, returnByValue: true, awaitPromise: true,
        });
        const v = r.result?.result?.value;
        if (v) {
          const out = (typeof v === 'object') ? JSON.stringify(v, null, 2) : String(v);
          return text(out);
        }
        await new Promise(r => setTimeout(r, intervalMs));
      }
      throw new Error(`wait_for timed out after ${timeoutMs}ms: ${expression}`);
    },
  },

  {
    name: 'browser_set_attention',
    description:
      'Mark a tab as needing the human user to look at it. Use when the page presents a captcha, ' +
      'MFA challenge, sign-in modal, paywall, age gate, or any human-only verification. The bridge ' +
      'viewer pulses the tab\'s blinking dot and shows your message in a floating box on that tab.\n\n' +
      'Cap: ' + MCP_MAX_ATTENTION + ' concurrent attention requests across all agents (throws when exceeded). ' +
      'A tab with pending attention is PROTECTED from FIFO eviction by browser_open. ' +
      'After the human acts, follow up with browser_wait_for to detect progress, then browser_dismiss_attention.\n\n' +
      'The message can be multi-paragraph; render is pre-wrapped.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        message: { type: 'string', description: 'Instruction for the human — what to do, why, what you\'ll do next.' },
      },
      required: ['tabId', 'message'],
    },
    async run({ tabId, message }, d) {
      if (typeof message !== 'string' || !message.trim()) {
        throw new Error('message required and must be non-empty');
      }
      const trimmed = message.trim();
      const targets = await d.getCdpTargets();
      if (!targets.some(t => t.id === tabId && t.type === 'page')) {
        throw new Error('tab not found: ' + tabId);
      }
      // Updating an EXISTING attention request must NOT bump the counter.
      if (!attentionRequests.has(tabId) && attentionRequests.size >= MCP_MAX_ATTENTION) {
        throw new Error(
          `attention cap reached (${MCP_MAX_ATTENTION}); call browser_dismiss_attention on an existing one first. ` +
          `Currently waiting on tabs: ${[...attentionRequests.keys()].join(', ')}`
        );
      }
      attentionRequests.set(tabId, { message: trimmed, since: Date.now() });
      notifyStateChanged();
      return text(JSON.stringify({
        tabId, message: trimmed, attentionCount: attentionRequests.size, attentionCap: MCP_MAX_ATTENTION,
      }, null, 2));
    },
  },

  {
    name: 'browser_dismiss_attention',
    description:
      'Mark a previous attention request as resolved. Idempotent — dismissing a tab without a pending ' +
      'request returns ok with cleared=false.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
    },
    async run({ tabId }, _d) {
      const had = attentionRequests.delete(tabId);
      if (had) notifyStateChanged();
      return text(JSON.stringify({ tabId, cleared: had, attentionCount: attentionRequests.size }, null, 2));
    },
  },

  // --- Dev mode tools ---

  {
    name: 'browser_set_dev_mode',
    description:
      'Toggle dev mode on a tab. When enabled, activates Runtime/Log/Network CDP domains on the ' +
      'tab\'s session, unlocking browser_get_console_logs, browser_get_network_requests, ' +
      'browser_get_network_response, browser_get_popup_log, browser_set_dialog_handler, ' +
      'browser_get_pending_dialog, browser_handle_dialog, browser_list_frames, and browser_navigate_frame.\n\n' +
      'Dev mode breaks stealth — the enabled CDP domains are detectable by pages. Only use on ' +
      'tabs where observability matters more than stealth.\n\n' +
      'Returns: { tabId, devMode: true/false }.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable.' },
      },
      required: ['tabId', 'enabled'],
    },
    async run({ tabId, enabled }, d) {
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);

      if (enabled && !devModeTabs.has(tabId)) {
        await d.sessionCommand(entry.sessionId, 'Runtime.enable');
        await d.sessionCommand(entry.sessionId, 'Log.enable');
        await d.sessionCommand(entry.sessionId, 'Network.enable');
        // Popup tracking: inject binding + window.open wrapper
        await d.sessionCommand(entry.sessionId, 'Runtime.addBinding', { name: '__devPopup' });
        const scriptResp = await d.sessionCommand(entry.sessionId, 'Page.addScriptToEvaluateOnNewDocument', {
          source: `(function(){if(window.__devPopupPatched)return;window.__devPopupPatched=true;const o=window.open;window.open=function(u,t,f){const r=o.call(this,u,t,f);try{__devPopup(JSON.stringify({url:u||'',target:t||'',features:f||'',blocked:!r}))}catch(e){}return r}})()`,
        });
        const popupScriptId = scriptResp?.result?.identifier || null;
        // Also run the patch on the current page immediately
        await d.sessionCommand(entry.sessionId, 'Runtime.evaluate', {
          expression: `(function(){if(window.__devPopupPatched)return;window.__devPopupPatched=true;const o=window.open;window.open=function(u,t,f){const r=o.call(this,u,t,f);try{__devPopup(JSON.stringify({url:u||'',target:t||'',features:f||'',blocked:!r}))}catch(e){}return r}})()`,
        }).catch(() => {});

        devModeTabs.set(tabId, {
          consoleLogs: [],
          networkRequests: new Map(),
          networkBodies: new Map(),
          popupLog: [],
          dialogHandler: 'manual',
          pendingDialog: null,
          popupScriptId,
        });
        notifyStateChanged();
      } else if (!enabled && devModeTabs.has(tabId)) {
        const state = devModeTabs.get(tabId);
        if (state.popupScriptId) {
          await d.sessionCommand(entry.sessionId, 'Page.removeScriptToEvaluateOnNewDocument', {
            identifier: state.popupScriptId,
          }).catch(() => {});
        }
        await d.sessionCommand(entry.sessionId, 'Runtime.disable').catch(() => {});
        await d.sessionCommand(entry.sessionId, 'Log.disable').catch(() => {});
        await d.sessionCommand(entry.sessionId, 'Network.disable').catch(() => {});
        devModeTabs.delete(tabId);
        notifyStateChanged();
      }

      return text(JSON.stringify({ tabId, devMode: !!enabled }, null, 2));
    },
  },

  {
    name: 'browser_get_console_logs',
    description:
      'Retrieve captured console output and page errors for a dev-mode tab. Returns entries since ' +
      '`since` timestamp (ms epoch, optional — omit for all buffered). Ring buffer holds up to ' +
      DEV_LOG_CAP + ' entries.\n\n' +
      'Each entry: { type, level, text, source?, line?, col?, ts }. Requires dev mode.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        since: { type: 'number', description: 'Only return entries after this timestamp (ms epoch). Optional.' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading. Default false.' },
      },
      required: ['tabId'],
    },
    async run({ tabId, since, clear }, _d) {
      const state = requireDevMode(tabId);
      let logs = state.consoleLogs;
      if (since) logs = logs.filter(e => e.ts > since);
      const result = { tabId, entries: logs, total: state.consoleLogs.length, returned: logs.length };
      if (clear) state.consoleLogs = [];
      return text(JSON.stringify(result, null, 2));
    },
  },

  {
    name: 'browser_set_dialog_handler',
    description:
      'Set how a dev-mode tab handles JavaScript dialogs (alert/confirm/prompt). Modes:\n' +
      '- "manual" (default): dialog stays open until you call browser_handle_dialog.\n' +
      '- "auto-accept": automatically accept (confirm→true, prompt→defaultValue).\n' +
      '- "auto-dismiss": automatically dismiss (confirm→false, prompt→cancel).\n\n' +
      'Requires dev mode.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        mode: { type: 'string', enum: ['manual', 'auto-accept', 'auto-dismiss'] },
      },
      required: ['tabId', 'mode'],
    },
    async run({ tabId, mode }, _d) {
      const state = requireDevMode(tabId);
      state.dialogHandler = mode;
      return text(JSON.stringify({ tabId, dialogHandler: mode }, null, 2));
    },
  },

  {
    name: 'browser_get_pending_dialog',
    description:
      'Check if a dev-mode tab has a pending (unhandled) JavaScript dialog. Returns null if no dialog ' +
      'is open, or { type, message, defaultPrompt, url, ts } if one is waiting.\n\n' +
      'Requires dev mode with dialogHandler set to "manual".',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
    },
    async run({ tabId }, _d) {
      const state = requireDevMode(tabId);
      return text(JSON.stringify({ tabId, pendingDialog: state.pendingDialog }, null, 2));
    },
  },

  {
    name: 'browser_handle_dialog',
    description:
      'Accept or dismiss a pending JavaScript dialog on a dev-mode tab. Only works when ' +
      'dialogHandler is "manual" and a dialog is pending.\n\n' +
      'For prompt dialogs, pass promptText to fill the input before accepting.\n\n' +
      'Requires dev mode.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        accept: { type: 'boolean', description: 'true to accept, false to dismiss.' },
        promptText: { type: 'string', description: 'Text for prompt dialogs (ignored for alert/confirm).' },
      },
      required: ['tabId', 'accept'],
    },
    async run({ tabId, accept, promptText }, d) {
      const state = requireDevMode(tabId);
      if (!state.pendingDialog) throw new Error('no pending dialog on tab ' + tabId);
      const handled = state.pendingDialog;
      state.pendingDialog = null;
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);
      const params = { accept };
      if (promptText !== undefined) params.promptText = promptText;
      const r = await d.sessionCommand(entry.sessionId, 'Page.handleJavaScriptDialog', params);
      if (r.error) throw new Error(r.error.message);
      return text(JSON.stringify({ tabId, handled: handled.type, accept }, null, 2));
    },
  },

  {
    name: 'browser_get_popup_log',
    description:
      'Retrieve the log of window.open() attempts on a dev-mode tab. Each entry records the URL, ' +
      'target, features, whether Chrome blocked it, and timestamp.\n\n' +
      'Ring buffer holds up to ' + DEV_POPUP_CAP + ' entries. Requires dev mode.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        clear: { type: 'boolean', description: 'Clear the log after reading. Default false.' },
      },
      required: ['tabId'],
    },
    async run({ tabId, clear }, _d) {
      const state = requireDevMode(tabId);
      const entries = [...state.popupLog];
      if (clear) state.popupLog = [];
      return text(JSON.stringify({ tabId, entries, total: entries.length }, null, 2));
    },
  },

  {
    name: 'browser_get_network_requests',
    description:
      'List captured network requests for a dev-mode tab. Returns the most recent requests ' +
      '(up to ' + DEV_NET_CAP + '). Optional filter narrows by URL substring, method, or status.\n\n' +
      'Each entry: { requestId, url, method, type, status, mimeType, size, done, failed, errorText, ts }.\n\n' +
      'Use requestId with browser_get_network_response to fetch the response body. Requires dev mode.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        filter: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL substring match.' },
            method: { type: 'string', description: 'HTTP method (GET, POST, etc.).' },
            status: { type: 'integer', description: 'Exact status code match.' },
          },
        },
      },
      required: ['tabId'],
    },
    async run({ tabId, filter }, _d) {
      const state = requireDevMode(tabId);
      let entries = [...state.networkRequests.values()];
      if (filter) {
        if (filter.url) entries = entries.filter(e => e.url.includes(filter.url));
        if (filter.method) entries = entries.filter(e => e.method === filter.method);
        if (filter.status !== undefined) entries = entries.filter(e => e.status === filter.status);
      }
      return text(JSON.stringify({ tabId, requests: entries, total: entries.length }, null, 2));
    },
  },

  {
    name: 'browser_get_network_response',
    description:
      'Fetch the response body of a captured network request by requestId. Returns the body as text ' +
      '(up to 1 MB; base64 for binary). The request must be complete (done:true).\n\n' +
      'Requires dev mode.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        requestId: { type: 'string' },
      },
      required: ['tabId', 'requestId'],
    },
    async run({ tabId, requestId }, d) {
      const state = requireDevMode(tabId);
      const req = state.networkRequests.get(requestId);
      if (!req) throw new Error('requestId not found: ' + requestId);
      if (!req.done) throw new Error('request not complete yet — wait for it to finish');
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);
      const r = await d.sessionCommand(entry.sessionId, 'Network.getResponseBody', { requestId });
      if (r.error) throw new Error(r.error.message);
      const body = r.result?.body || '';
      const base64 = r.result?.base64Encoded || false;
      if (!base64 && body.length > 1_000_000) {
        return text(JSON.stringify({ tabId, requestId, truncated: true, size: body.length, body: body.slice(0, 1_000_000) }, null, 2));
      }
      return text(JSON.stringify({ tabId, requestId, base64Encoded: base64, body }, null, 2));
    },
  },

  {
    name: 'browser_list_frames',
    description:
      'List all frames (main + iframes) in a dev-mode tab. Returns the frame tree with ' +
      'frameId, url, name, and parentFrameId for each frame.\n\n' +
      'Use frameId with browser_navigate_frame to navigate a specific iframe. Requires dev mode.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
    },
    async run({ tabId }, d) {
      requireDevMode(tabId);
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);
      const r = await d.sessionCommand(entry.sessionId, 'Page.getFrameTree');
      if (r.error) throw new Error(r.error.message);
      const frames = [];
      function walk(node, parentId) {
        const f = node.frame;
        frames.push({
          frameId: f.id,
          url: f.url,
          name: f.name || '',
          parentFrameId: parentId,
        });
        for (const child of (node.childFrames || [])) walk(child, f.id);
      }
      walk(r.result.frameTree, null);
      return text(JSON.stringify({ tabId, frames }, null, 2));
    },
  },

  {
    name: 'browser_navigate_frame',
    description:
      'Navigate a specific frame (iframe) within a dev-mode tab to a new URL. Identify the frame ' +
      'by frameId from browser_list_frames.\n\n' +
      'Requires dev mode.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        frameId: { type: 'string', description: 'Frame ID from browser_list_frames.' },
        url: { type: 'string' },
      },
      required: ['tabId', 'frameId', 'url'],
    },
    async run({ tabId, frameId, url }, d) {
      requireDevMode(tabId);
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);
      const r = await d.sessionCommand(entry.sessionId, 'Page.navigate', { url, frameId });
      if (r.error) throw new Error(r.error.message);
      return text(JSON.stringify({ tabId, frameId, url, navigated: true }, null, 2));
    },
  },
];

// --- JSON-RPC dispatcher ---

async function dispatch(msg, deps, log) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null;
    }
    if (method === 'tools/list') {
      return reply(id, {
        tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    }
    if (method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === params?.name);
      if (!tool) return errorReply(id, -32602, 'Unknown tool: ' + params?.name);
      try {
        await deps.ensureBrowserConnection();
        // Cold-bridge start: rebuild ownership from disk before the first tool
        // acts, so FIFO counts and mcpOwned flags reflect the surviving tabs.
        await ensureRehydrated(deps);
        const result = await tool.run(params.arguments || {}, deps);
        return reply(id, result);
      } catch (err) {
        log.error('mcp tool', tool.name, 'failed:', err.message);
        return reply(id, text('Error: ' + err.message, { isError: true }));
      }
    }
    if (method === 'ping') {
      return reply(id, {});
    }
    if (isNotification) return null;
    return errorReply(id, -32601, 'Method not found: ' + method);
  } catch (err) {
    log.error('mcp dispatch error:', err.message);
    if (isNotification) return null;
    return errorReply(id, -32603, 'Internal error: ' + err.message);
  }
}

function reply(id, result) { return { jsonrpc: '2.0', id, result }; }
function errorReply(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

// `deps` must provide:
//   dispatchBridgeEvent(msg)        — single shared event API; same one
//                                     the viewer's WS handler uses. MCP
//                                     posts {type: 'newTab'|'navigate'|'closeTab'}.
//   getCdpTargets()                 — read tab list (preserves bridge's
//                                     knownTabs ordering bookkeeping)
//   sessionCommand(sid, method, p)  — per-session CDP for tools the WS
//                                     event protocol doesn't expose
//                                     (Runtime.evaluate, Page.captureScreenshot)
//   sessionSend(sid, method, p)     — fire-and-forget CDP for commands whose
//                                     response never arrives in headless
//                                     (mouseWheel — same as viewer scroll)
//   poolAttach(targetId)            — attach via session pool (idempotent)
//   sessionPool                     — Map<targetId, {sessionId, ...}>
//   ensureBrowserConnection()       — opens the browser-level CDP socket
//   log                             — { error, info, debug }
export function createMcpHandler(deps) {
  const log = deps.log;
  // Stash deps so mutation/persist/rehydrate paths can reach CDP + disk.
  mcpDeps = deps;
  return async function handle(req, res) {
    if (req.method === 'GET' || req.method === 'DELETE') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405); res.end(); return;
    }

    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) body += chunk;

    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }

    if (Array.isArray(msg)) {
      const responses = [];
      for (const m of msg) {
        const r = await dispatch(m, deps, log);
        if (r) responses.push(r);
      }
      if (responses.length === 0) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responses));
      return;
    }

    const response = await dispatch(msg, deps, log);
    if (response === null) {
      res.writeHead(202); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  };
}
