# Browser Bridge Test Cases

## UA Extraction (build time)

### UA extracted without Headless
1. Build the image
2. Run: `docker exec <container> cat /usr/local/etc/chrome-ua`
3. Output must be a valid User-Agent string (starts with `Mozilla/5.0`)
4. Output must NOT contain the word `Headless`

### Build fails if Chrome cannot start
1. Modify Dockerfile: change `--remote-debugging-port=19222` to `19999`
   but keep the retry polling on port `19222`
2. Build must fail with: `ERROR: Failed to extract Chrome UA after 30 attempts`

## Navigation Correctness

Chrome headless resets background tab renderers to the tab's creation URL on
reactivation. `Page.navigate` changes the displayed page but not the creation
URL, so navigated tabs revert on switch. The navigate handler works around this
by replacing the tab via `/json/new?<url>` instead of calling `Page.navigate`.

### "+" button → type URL → switch away → switch back
Simulates the exact address bar flow: new blank tab, then navigate.

1. Connect viewer, wait for `targetChanged` (bootstrap)
2. Send `{ type: 'newTab' }` (no URL) — creates about:blank tab
3. Wait for `targetChanged` confirming about:blank
4. Send `{ type: 'navigate', url: 'https://example.com' }`
5. Wait for `targetChanged` (navigate handler replaces the tab)
6. Send `{ type: 'newTab', url: 'https://www.iana.org/' }` — switch to a different tab
7. Wait for `targetChanged`
8. Send `getTabs`, find the example.com tab (inactive), send `switchTab` to it
9. Wait for `targetChanged`, then wait 2 seconds

**Pass**: `targetChanged` URL is example.com, no `navigated` event to `about:blank`
**Fail**: `navigated` event to `about:blank` after switching back

### Navigate on default tab does not revert
The initial tab is chrome://newtab/. Navigating it must not revert on switch.

1. Connect viewer (bootstrap tab is chrome://newtab/)
2. Send `{ type: 'navigate', url: 'https://example.com' }`
3. Wait for `targetChanged`
4. Create second tab, switch back to first
5. Wait 2 seconds

**Pass**: no `navigated` event to `chrome://newtab/`
**Fail**: `navigated` event to `chrome://newtab/`

### Tab created with URL survives switch
Tabs created via `newTab` with a URL use `/json/new?<url>` directly.
These should survive switching without any reload.

1. Send `{ type: 'newTab', url: 'https://example.com' }`
2. Wait for `targetChanged`
3. Switch to another tab, wait, switch back
4. Wait 2 seconds

**Pass**: no `navigated` event after switching back
**Fail**: `navigated` event fires (Chrome reloaded the tab)

### Page.navigate causes revert (regression guard)
This test proves the underlying Chrome behavior exists. It must FAIL to confirm
the navigate handler workaround is necessary. If it starts passing, Chrome may
have fixed the behavior and the workaround can be simplified.

1. Connect viewer, wait for bootstrap
2. Create blank tab via bridge: `{ type: 'newTab' }` (pool will attach a session)
3. Wait for `targetChanged`
4. Attach a NEW session to the tab directly via Chrome's browser-level CDP WebSocket
   (do NOT reuse pool session IDs — they are scoped to the bridge's WS connection)
5. Call `Page.navigate` with `https://example.com` on the new session
6. Wait for navigation to commit (poll `/json/list` until URL is example.com)
7. Switch to another tab via bridge `switchTab`
8. Wait 3 seconds
9. Switch back via bridge `switchTab`
10. Check URL via `/json/list`

**Expected FAIL**: URL is `about:blank` — Chrome reset the renderer to creation URL
**Unexpected PASS**: URL is `example.com` — Chrome behavior changed

## Session Pool

### poolAttach race on newTab
`Target.targetCreated` triggers `poolAttach` concurrently with the `newTab` handler's
`switchToTarget`. The `poolAttaching` Map must allow the second caller to await the
in-flight promise.

1. Send `{ type: 'newTab', url: 'https://example.com' }`
2. Wait up to 5 seconds for `targetChanged`

**Pass**: `targetChanged` arrives with example.com URL
**Fail**: no `targetChanged`, or error message about failed attach

### No duplicate session attach
1. Send `{ type: 'newTab', url: 'https://example.com' }`
2. Check `BRIDGE_LOG=debug` output for `poolAttach` lines

**Pass**: each target ID appears in poolAttach logs exactly once
**Fail**: same target ID appears twice with different session IDs

### Close active tab switches to adjacent tab
1. Create tabs A, B, C (via three `newTab` calls)
2. Switch to tab B
3. Send `{ type: 'closeTab', targetId: <B> }`
4. Wait for `targetChanged`

**Pass**: active tab is C (next in order)
**Fail**: active tab is A, or a new blank tab

### Close last remaining tab creates a blank tab
1. Close all tabs until one remains
2. Close it via `closeTab`

**Pass**: `targetChanged` with about:blank — new tab auto-created
**Fail**: error, or no tab exists

## Multiple Viewers

### Second viewer receives current state on connect
1. Connect viewer 1, navigate to a URL, open multiple tabs
2. Connect viewer 2

**Pass**: viewer 2 immediately receives `targetChanged` matching viewer 1's active tab
**Fail**: viewer 2 gets no `targetChanged`, or gets a different tab

### Tab switch in one viewer affects the other
1. Connect two viewers
2. From viewer 1, send `switchTab` to a different tab
3. Observe viewer 2

**Pass**: viewer 2 receives `targetChanged` for the same target
**Fail**: viewer 2 stays on old tab

### Viewer disconnect does not affect pool or other viewers
1. Connect viewer 1, create multiple tabs
2. Disconnect viewer 1
3. Connect viewer 2

**Pass**: all tabs still exist, same active tab, debug logs show no session re-creation
**Fail**: tabs lost, or sessions re-created

### Navigate from either viewer broadcasts to both
1. Connect two viewers
2. From viewer 1, send `navigate` to URL A
3. Both viewers receive `targetChanged` for URL A
4. From viewer 2, send `navigate` to URL B
5. Both viewers receive `targetChanged` for URL B

## Browser Lifecycle

### Browser restart reconnects
1. Connect viewer
2. Send `{ type: 'browserRestart' }`

**Pass**: viewer receives `status: 'Reconnecting...'`, then `targetChanged` when reconnected
**Fail**: viewer stuck on reconnecting, or no `targetChanged`

### Bridge survives Chrome crash
1. Connect viewer, navigate to a page
2. Inside container: `kill $(cat /tmp/chrome.pid)`

**Pass**: bridge broadcasts reconnecting status, Chrome restarts (via process manager),
bridge reconnects and resumes with a `targetChanged`
**Fail**: bridge hangs or crashes

### Browser stop and start
1. Send `browserStop` — confirm `browserStopped` received
2. Send `browserStart` — confirm `targetChanged` received

## Renderer Preservation

The session pool keeps CDP sessions attached to all known page targets. For tabs
created via `/json/new?<url>`, this prevents Chrome from resetting renderers on
background tab reactivation.

If these tests start failing, Chrome's headless renderer lifecycle behavior changed.
Known mitigation: add `--disable-features=BackForwardCache,TabFreezing,TabDiscarding`
to chrome-launcher (trades memory for stability).

### Background tab not reloaded after immediate switch
1. Send `newTab` with URL, wait for page to load (no more `loading` events)
2. Switch to another tab
3. Switch back immediately

**Pass**: no `navigated` event after `targetChanged`
**Fail**: `navigated` event fires

### Background tab not reloaded after 30 seconds
1. Send `newTab` with URL, wait for page to load
2. Switch to another tab
3. Wait 30 seconds
4. Switch back

**Pass**: no `navigated` event
**Fail**: `navigated` event fires
