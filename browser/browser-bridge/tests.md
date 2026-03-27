# Browser Bridge

Automated tests: `tests/*.mjs`, run via `node tests/run-all.mjs` (120s timeout each).

## Status

- **System State**: Revert guard added in poolSessionHandler. Incorrect assumptions corrected in code comments.
- **Last Action**: Chromium source research debunked "creation URL revert" theory. Navigate handler unchanged (simple Page.navigate).
- **Next Step**: Root-cause the actual mechanism behind about:blank revert — it's NOT renderer discard + creation URL.
- **Open leads**: viewer's `visibilitychange` handler interaction with bridge; race between viewer switchTab and test-driven switchTab; NavigationEntry commit timing when `Page.navigate` is called immediately after `Target.createTarget`.

## Code Changes (this session)

### server.mjs
- Fixed incorrect comments: session pool does NOT prevent renderer discard
- Removed speculative "early attachment causes revert" comment
- Added `lastKnownUrls` Map: tracks last non-blank URL per target
- Added revert guard in poolSessionHandler: suppresses about:blank broadcast + re-navigates
- Cleanup in poolDetach, targetDestroyed, WS close

## Chromium Internals Research

Research conducted against Chromium source to debunk incorrect assumptions
that were driving the wrong fix direction. Each finding cites the specific
source file in the Chromium tree.

### CDP Page.navigate is browser-initiated

`Page.navigate` in the content-layer DevTools handler calls
`NavigationController::LoadURLWithParams()` — the same code path as omnibox
(address bar) navigation. It is **not** renderer-initiated.

```cpp
// content/browser/devtools/protocol/page_handler.cc
void PageHandler::Navigate(...) {
  // ...
  NavigationController::LoadURLParams params(gurl);
  // When navigation_initiator_origin_ is NOT set (default for
  // browser-level CDP sessions via Target.attachToTarget):
  // params.is_renderer_initiated stays false (browser-initiated).
  if (navigation_initiator_origin_.has_value()) {
    params.is_renderer_initiated = true;
    params.initiator_origin = *navigation_initiator_origin_;
    params.source_site_instance = SiteInstance::CreateForURL(
        host_->GetBrowserContext(),
        navigation_initiator_origin_->GetURL());
  }
  web_contents->GetController().LoadURLWithParams(params);
}
```

The `navigation_initiator_origin_` constructor parameter is set only when the
CDP session is associated with a specific origin (e.g. extension-initiated).
For browser-level sessions created via `Target.attachToTarget({ flatten: true })`
(our case), it is empty — making `Page.navigate` fully browser-initiated.

Source: [page_handler.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/page_handler.cc),
[page_handler.h](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/page_handler.h)

### Page.navigate creates a committed NavigationEntry

`LoadURLWithParams()` delegates to `NavigateWithoutEntry()` which calls
`CreateNavigationEntry()`, sets it as pending via `SetPendingEntry()`, and
commits it when the navigation finishes. The resulting `NavigationEntry` is
structurally identical to one created by typing a URL in the omnibox.

`Target.createTarget({ url })` also navigates via `LoadURLWithParams()` but
its entry **replaces** the initial empty document entry. A subsequent
`Page.navigate` **appends** a new entry to the session history.

Source: [navigation_concepts.md](https://chromium.googlesource.com/chromium/src/+/main/docs/navigation_concepts.md),
[session_history.md](https://chromium.googlesource.com/chromium/src.git/+/main/docs/session_history.md),
[target_handler.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/target_handler.cc)

### No "creation URL" concept in Chromium

There is no persistent "creation URL" metadata on a tab. When
`Target.createTarget` is called with a URL, that URL becomes the first
committed NavigationEntry. After `Page.navigate` commits a new entry,
the "creation URL" is just another history entry — not privileged.

The `NavigationController` tracks:
- `GetLastCommittedEntry()` — the current document
- `GetPendingEntry()` — in-flight navigation
- `GetVisibleEntry()` — what the address bar shows

Source: [navigation_controller.h](https://github.com/nicedoc/chromium/blob/master/content/public/browser/navigation_controller.h),
[navigation_concepts.md](https://chromium.googlesource.com/chromium/src/+/main/docs/navigation_concepts.md)

### Renderer discard reloads from last committed entry

When a renderer is discarded (tab discard, crash, OOM), the
`NavigationController` and its `entries_` vector survive in the browser
process. On reactivation, `NavigationController::Reload()` loads from
`entries_[last_committed_entry_index_]`:

```cpp
// content/browser/renderer_host/navigation_controller_impl.cc
void NavigationControllerImpl::Reload(ReloadType reload_type, ...) {
  // ...
  NavigationEntryImpl* entry = GetEntryAtIndex(current_index);
  // ... sets pending_entry_ to this existing entry
  NavigateToExistingPendingEntry(reload_type, ...);
}
```

This means after `Page.navigate(browserscan)` commits, a renderer discard
would reload **browserscan** (last committed), NOT about:blank.

Source: [navigation_controller_impl.cc](https://chromium.googlesource.com/chromium/src/+/main/content/browser/renderer_host/navigation_controller_impl.cc),
[tab-discarding-and-reloading](https://www.chromium.org/chromium-os/chromiumos-design-docs/tab-discarding-and-reloading/)

### Screencast has no effect on renderer lifecycle

`Page.stopScreencast` resets the encoder, calls `video_consumer_->StopCapture()`,
and returns `Response::FallThrough()`. No renderer lifecycle, visibility, or
RenderFrameHost manipulation occurs:

```cpp
// content/browser/devtools/protocol/page_handler.cc
Response PageHandler::StopScreencast() {
  screencast_enabled_ = false;
  screencast_encoder_.reset();
  if (video_consumer_)
    video_consumer_->StopCapture();
  return Response::FallThrough();
}
```

Critically, screencast never calls `WebContents::IncrementCapturerCount()`.
Only `Page.captureScreenshot` does:

```cpp
// Same file, in CaptureScreenshot:
web_contents->IncrementCapturerCount(gfx::Size(), stay_hidden, stay_awake);
```

`IncrementCapturerCount` is Chromium's mechanism for keeping hidden tabs alive
and producing frames. Screencast does not use it. Starting screencast does not
protect the renderer; stopping it does not destroy it.

Source: [page_handler.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/page_handler.cc),
[devtools_video_consumer.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/devtools_video_consumer.cc)

### CDP sessions do not prevent renderer discard

CDP sessions (`Target.attachToTarget`) are browser-process objects. They
provide a message channel to the renderer but do not keep the renderer process
alive. Tab discard (`TabLifecycleUnit`) operates independently of CDP session
state. The session pool's value is eliminating attach/detach overhead on tab
switch, not preventing discard.

Source: [Chromium bug 775644](https://bugs.chromium.org/p/chromium/issues/detail?id=775644),
[tab-discarding-and-reloading](https://www.chromium.org/chromium-os/chromiumos-design-docs/tab-discarding-and-reloading/)

### BrowsingInstanceNotSwapped is a secondary bfcache reason

`Page.backForwardCacheNotUsed` CDP event fires on **history navigations only**
(back/forward), NOT on `Target.activateTarget` (tab switch).

A `BrowsingInstance` is Chromium's implementation of the HTML5 "unit of related
browsing contexts" — tabs/frames that can script each other. For bfcache to
work, Chrome must swap the BrowsingInstance during navigation to isolate the
frozen page.

`BrowsingInstanceNotSwapped` means Chrome skipped this swap. It is a
**secondary optimization reason** — Chrome skips the expensive swap when
bfcache is already ineligible for another reason. Per the Chromium bfcache-dev
mailing list: "If you see BrowsingInstanceNotSwapped and nothing else, that's
a bug." There should always be an accompanying root cause.

The `ShouldSwapBrowsingInstance` enum lists all skip reasons:

| Enum value | Meaning |
|---|---|
| `kNo_SourceURLSchemeIsNotHTTPOrHTTPS` (5) | Source URL is `about:`, `chrome:`, `file:`, etc. |
| `kNo_HasRelatedActiveContents` (3) | Other tabs share this BrowsingInstance (window.opener) |
| `kNo_NotNeededForBackForwardCache` (11) | bfcache already ineligible for another reason |
| `kNo_SameSiteNavigation` (7) | Same-site, proactive swap not triggered |

For tabs created from `about:blank`, the `about:` scheme triggers
`kNo_SourceURLSchemeIsNotHTTPOrHTTPS`, disabling the BrowsingInstance swap
and therefore bfcache. The bfcache fallback is a full network navigation to the
URL from the session history entry (last committed — NOT "creation URL").

Source: [should_swap_browsing_instance.h](https://chromium.googlesource.com/chromium/src/+/main/content/browser/renderer_host/should_swap_browsing_instance.h),
[back_forward_cache_metrics.cc](https://chromium.googlesource.com/chromium/src/+/main/content/browser/renderer_host/back_forward_cache_metrics.cc),
[bfcache-dev mailing list](https://groups.google.com/a/chromium.org/g/bfcache-dev/c/HkgtcRIdjso),
[CDP Page.backForwardCacheNotUsed](https://chromedevtools.github.io/devtools-protocol/tot/Page/#event-backForwardCacheNotUsed)

### Chrome flags in use and their actual effects

| Flag | What it actually does | What it does NOT do |
|---|---|---|
| `--disable-renderer-backgrounding` | Prevents lower process priority for non-foreground tabs | Does NOT prevent renderer destruction or discard |
| `--disable-background-timer-throttling` | Prevents timer throttling in background tabs | Does NOT affect renderer lifecycle |
| `--disable-backgrounding-occluded-windows` | Prevents throttling of occluded windows | Does NOT apply in headless (no OS windows) |

Source: [chrome-flags-for-tools.md](https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md)

## Revert Guard

poolSessionHandler tracks last non-blank URL per target (`lastKnownUrls`).
If `Page.frameNavigated` fires with about:blank on the active target and a real
URL is known, the broadcast is suppressed and `Page.navigate` re-fires.

## Unimplemented Tests

### Build fails if Chrome cannot start (manual)
1. Modify Dockerfile: change `--remote-debugging-port=19222` to `19999`
   but keep the retry polling on port `19222`
2. Build must fail with: `ERROR: Failed to extract Chrome UA after 30 attempts`

### Navigate from either viewer broadcasts to both
1. Connect two viewers
2. From viewer 1, send `navigate` to URL A
3. Both viewers receive `navigated` for URL A
4. From viewer 2, send `navigate` to URL B
5. Both viewers receive `navigated` for URL B

### Browser restart reconnects
1. Connect viewer
2. Send `{ type: 'browserRestart' }`

**Pass**: viewer receives `status: 'Reconnecting...'`, then `targetChanged` when reconnected

### Bridge survives Chrome crash
1. Connect viewer, navigate to a page
2. Inside container: `kill $(cat /tmp/chrome.pid)`

**Pass**: bridge broadcasts reconnecting status, then `targetChanged`

### Browser stop and start
1. Send `browserStop` — confirm `browserStopped` received
2. Send `browserStart` — confirm `targetChanged` received

## Key Files

- `server.mjs` — bridge (session pool, switchToTarget, navigate handler, revert guard)
- `index.html` — viewer (`visibilitychange` sends switchTab with `currentTargetId`)
- `tests/13-browser-viewer-navigate.mjs` — reproduces the bug via Chrome-hosted viewer
- `tests/run-all.mjs` — sequential runner, 120s timeout per test
