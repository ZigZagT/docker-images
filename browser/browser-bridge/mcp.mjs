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

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'browser-bridge', version: '1.0.0' };

const MCP_MAX_OPEN_TABS = Math.max(1, parseInt(process.env.MCP_MAX_OPEN_TABS || '3', 10));
const MCP_MAX_ATTENTION = Math.max(1, parseInt(process.env.MCP_MAX_ATTENTION || '3', 10));

// Insertion-order Map → FIFO. Key = targetId, value = { openedAt }.
const mcpOwnedTabs = new Map();
// Map<targetId, { message, since }>. Capacity-limited at MCP_MAX_ATTENTION.
const attentionRequests = new Map();
// Per-tab snapshot UID map. After browser_get_snapshot we hand the agent
// stable UIDs ([uid=42]) to use with browser_click/type/etc instead of
// authoring CSS selectors. Each entry: { snapshotId, idToBackend: Map<string, number> }.
// Replaced wholesale on each new snapshot — UIDs from a stale snapshot
// throw a clear error so the agent re-snapshots before retrying.
const tabSnapshots = new Map();

const stateListeners = new Set();
function notifyStateChanged() {
  for (const fn of stateListeners) {
    try { fn(); } catch { /* ignore */ }
  }
}

export function getMcpState() {
  const owned = {};
  for (const [id, meta] of mcpOwnedTabs) owned[id] = { openedAt: meta.openedAt };
  const attention = {};
  for (const [id, meta] of attentionRequests) attention[id] = { message: meta.message, since: meta.since };
  return { owned, attention, limits: { maxTabs: MCP_MAX_OPEN_TABS, maxAttention: MCP_MAX_ATTENTION } };
}

export function noteTabClosed(targetId) {
  let changed = false;
  if (mcpOwnedTabs.delete(targetId)) changed = true;
  if (attentionRequests.delete(targetId)) changed = true;
  tabSnapshots.delete(targetId);
  if (changed) notifyStateChanged();
}

// Drop tracking for any targetId no longer present in the live browser
// (e.g. after a chrome restart, where every targetId is fresh and the
// old in-memory MCP-owned/attention map would otherwise leak entries
// forever, miscounting against the FIFO cap and breaking ownership UX).
export function pruneStaleTabs(liveTargetIds) {
  const live = new Set(liveTargetIds);
  let changed = false;
  for (const id of mcpOwnedTabs.keys()) {
    if (!live.has(id)) { mcpOwnedTabs.delete(id); changed = true; }
  }
  for (const id of attentionRequests.keys()) {
    if (!live.has(id)) { attentionRequests.delete(id); changed = true; }
  }
  for (const id of tabSnapshots.keys()) {
    if (!live.has(id)) tabSnapshots.delete(id);
  }
  if (changed) notifyStateChanged();
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

Available interaction tools:

- browser_click({tabId, uid}) or ({tabId, selector}) — trusted mouse click.
- browser_type({tabId, text, uid?, selector?}) — trusted keystrokes; uid/selector
  to focus first, omit to continue typing into already-focused element.
- browser_press_key({tabId, key}) — single named key (Enter, Tab, Escape,
  ArrowDown, etc.). Acts on currently focused element.
- browser_scroll({tabId, deltaX, deltaY}) — wheel scroll at viewport center.
- browser_scroll_into_view({tabId, uid}) or ({tabId, selector}) — scroll until
  element is in view.

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
    if (box.error) throw new Error('uid ' + uid + ' has no box (offscreen or zero-size): ' + box.error.message);
    // content quad is 8 numbers: [x1,y1, x2,y2, x3,y3, x4,y4] (TL, TR, BR, BL).
    const c = box.result.model.content;
    const cx = (c[0] + c[4]) / 2;
    const cy = (c[1] + c[5]) / 2;
    return { entry, x: cx, y: cy };
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

// CDP dispatched mouse click — produces isTrusted=true events that bot-
// detection scripts can't distinguish from real human input.
async function cdpClickAt(d, sessionId, x, y) {
  const common = { x, y, button: 'left', clickCount: 1, modifiers: 0 };
  await d.sessionCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...common });
  await d.sessionCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
  await d.sessionCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
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
      mcpOwnedTabs.set(tabId, { openedAt: Date.now() });
      notifyStateChanged();
      if (evicted.length) {
        notice =
          `FIFO at cap (${MCP_MAX_OPEN_TABS}) — auto-closed older MCP tab(s): ${evicted.join(', ')}. ` +
          `Before opening more new tabs, call browser_list_tabs to see what already exists; ` +
          `pass an existing tabId to browser_navigate instead of opening another new tab.`;
      }

      // Best-effort load wait — poll the URL until stable or 8s elapses.
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
      'Wrap multi-statement code as `(()=>{ ... })()` or `(async()=>{ ... })()`; await is supported. ' +
      'Returns the value as JSON for objects/arrays, otherwise as a string. ' +
      'Page exceptions return as text starting with "Exception:" and isError=true.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        expression: { type: 'string' },
      },
      required: ['tabId', 'expression'],
    },
    async run({ tabId, expression }, d) {
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);
      const r = await d.sessionCommand(entry.sessionId, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (r.error) throw new Error(r.error.message);
      const ed = r.result?.exceptionDetails;
      if (ed) {
        return text('Exception: ' + (ed.text || '') + ' ' + (ed.exception?.description || ''), { isError: true });
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
      'Click an element via CDP-dispatched mouse events (isTrusted=true — passes captcha ' +
      'and bot detection that synthetic JS clicks fail). Identify the element by EITHER ' +
      '`uid` (preferred, from the most recent browser_get_snapshot) OR `selector` (CSS or ' +
      'XPath, fallback when no snapshot UID applies).\n\n' +
      'Click target is the element\'s bounding-box center. Throws if the element is offscreen ' +
      '(call browser_scroll_into_view first) or if the UID is stale (call browser_get_snapshot again).\n\n' +
      'Set includeSnapshot:true to receive an updated browser_get_snapshot view in the same ' +
      'response — useful when the click triggers DOM changes you need to inspect.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        uid: { type: 'string', description: 'UID from the most recent browser_get_snapshot for this tab.' },
        selector: { type: 'string', description: 'CSS selector or XPath. Use only if you don\'t have a snapshot UID.' },
        includeSnapshot: { type: 'boolean', description: 'Append a fresh browser_get_snapshot to the response.' },
      },
      required: ['tabId'],
    },
    async run({ tabId, uid, selector, includeSnapshot }, d) {
      if (!uid && !selector) throw new Error('browser_click: provide uid (preferred) or selector');
      const { entry, x, y } = await resolveTarget(d, tabId, { uid, selector });
      await cdpClickAt(d, entry.sessionId, x, y);
      const result = { tabId, uid: uid || null, selector: selector || null, clickedAt: { x, y } };
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
      'Scroll the page by (deltaX, deltaY) CSS pixels via CDP wheel event at the viewport center. ' +
      'Positive deltaY scrolls down; positive deltaX scrolls right. Use browser_scroll_into_view ' +
      'instead when you want a specific element on screen.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        deltaX: { type: 'number', description: 'Horizontal scroll delta in CSS px.' },
        deltaY: { type: 'number', description: 'Vertical scroll delta in CSS px.' },
      },
      required: ['tabId', 'deltaX', 'deltaY'],
    },
    async run({ tabId, deltaX, deltaY }, d) {
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);
      // Why this uses window.scrollBy and not CDP Input.dispatchMouseEvent
      // mouseWheel:
      //   - In headless Chromium, wheel events only deliver to the page
      //     when the renderer is actively rendering — i.e. when Page.start
      //     Screencast is running. The viewer's tabs always have screencast
      //     so its scroll works; MCP-opened tabs do not (we don't steal
      //     focus to start screencast on them), so a CDP wheel event fires
      //     but never reaches the page. window.scrollBy works regardless.
      //   - Unlike click and key input, scroll has no trusted-event
      //     security boundary — sites don't check isTrusted on scroll —
      //     so the JS path is safe to use without breaking bot-protected
      //     pages. browser_click and browser_type still go through CDP.
      const r = await d.sessionCommand(entry.sessionId, 'Runtime.evaluate', {
        expression: `(() => { window.scrollBy(${Number(deltaX)}, ${Number(deltaY)}); return JSON.stringify({x: window.scrollX, y: window.scrollY}); })()`,
        returnByValue: true,
      });
      if (r.error) throw new Error(r.error.message);
      const pos = JSON.parse(r.result?.result?.value || '{"x":0,"y":0}');
      return text(JSON.stringify({ tabId, deltaX, deltaY, scrollX: pos.x, scrollY: pos.y }, null, 2));
    },
  },

  {
    name: 'browser_scroll_into_view',
    description:
      'Scroll until an element is visible. Identify it by `uid` (preferred, from snapshot) ' +
      'or `selector` (CSS or XPath fallback). Uses CDP DOM.scrollIntoViewIfNeeded — ' +
      'programmatic, no input events.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        uid: { type: 'string', description: 'UID from browser_get_snapshot.' },
        selector: { type: 'string', description: 'CSS or XPath fallback if no UID.' },
        includeSnapshot: { type: 'boolean', description: 'Append a fresh browser_get_snapshot to the response.' },
      },
      required: ['tabId'],
    },
    async run({ tabId, uid, selector, includeSnapshot }, d) {
      if (!uid && !selector) throw new Error('browser_scroll_into_view: provide uid (preferred) or selector');
      await d.poolAttach(tabId);
      const entry = d.sessionPool.get(tabId);
      if (!entry) throw new Error('tab not found: ' + tabId);

      let backendNodeId;
      if (uid) {
        const snap = tabSnapshots.get(tabId);
        if (!snap) throw new Error('uid ' + uid + ' has no live snapshot — call browser_get_snapshot first');
        backendNodeId = snap.idToBackend.get(String(uid));
        if (backendNodeId === undefined) throw new Error('uid ' + uid + ' not in current snapshot');
      } else {
        // Selector path — resolve to a Runtime objectId, then pass that
        // straight to DOM.scrollIntoViewIfNeeded (it accepts nodeId,
        // backendNodeId, OR objectId per CDP spec). The earlier
        // DOM.requestNode bounce was both unnecessary and unreliable
        // because requestNode requires DOM.getDocument to have populated
        // the inspector tree first.
        const isXpath = selector.startsWith('/') || selector.startsWith('(/');
        const expr = isXpath
          ? `(() => { const r = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); return r.singleNodeValue; })()`
          : `document.querySelector(${JSON.stringify(selector)})`;
        const ev = await d.sessionCommand(entry.sessionId, 'Runtime.evaluate', { expression: expr });
        const objId = ev.result?.result?.objectId;
        if (!objId) throw new Error('no element matches: ' + selector);
        const r = await d.sessionCommand(entry.sessionId, 'DOM.scrollIntoViewIfNeeded', { objectId: objId });
        if (r.error) throw new Error(r.error.message);
        const result = { tabId, selector, scrolled: true };
        if (includeSnapshot) result.snapshot = await buildAndStoreSnapshot(d, tabId);
        return text(JSON.stringify(result, null, 2));
      }
      const r = await d.sessionCommand(entry.sessionId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
      if (r.error) throw new Error(r.error.message);
      const result = { tabId, uid, scrolled: true };
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
