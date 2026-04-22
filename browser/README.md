# browser

> **Source**: [Dockerfile](https://github.com/ZigZagT/docker-images/tree/master/browser)

Headless Browser (Chrome/Chromium) with a builtin web tool to interactive with the browser.

```bash
docker pull deaddev/browser
# or
docker pull ghcr.io/zigzagt/browser
```

**linux/amd64, linux/arm64** — Playwright installs [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) on amd64, Chromium on arm64.

### Supported Tags

| Tag | Content |
| --- | --- |
| `latest` | Full browser + browser-bridge CDP proxy |
| `chrome` | Alias for `latest` |
| `chromium` | Alias for `latest` |

## Components

The image has a layered wrapper chain and a CDP proxy server:

| Path | Role |
| --- | --- |
| `/usr/local/bin/chrome` | Entry point. It starts both Chrome and the bridge. You should call this to start chrome |
| `/usr/local/bin/chrome-launcher` | Lower-level wrapper that generate launch arguments and launches the browser |
| `/usr/local/bin/chrome-raw` | Symlink to the actual Chrome/Chromium binary |
| `/usr/local/etc/chrome-ua` | User-Agent string to be used |
| `/opt/browser-bridge/` | Web based tool that allows access the chrome instance in the container. Default launches at port 6080 |

## Usage

### Run as standalone browser

```bash
docker run -d --init --name browser --shm-size=1g \
  -p 6080:6080 \
  deaddev/browser
```

Open `http://<host>:6080` to access the browser.

### docker compose

```yaml
services:
  browser:
    init: true
    image: deaddev/browser
    shm_size: 1g
    ports:
      - "6080:6080"
    devices:
      - /dev/dri:/dev/dri  # GPU acceleration on Linux hosts (Intel/AMD)
```

Drop the `devices` line if your host has no `/dev/dri` (macOS, Windows). The container falls back to bundled SwiftShader (CPU rendering) automatically.

### GPU acceleration

The image ships with software rendering (SwiftShader) by default. To enable hardware acceleration on Linux hosts:

| Host | Steps |
| --- | --- |
| **Linux + Intel iGPU** | Mount `/dev/dri`. Mesa drivers and Intel VA-API drivers are pre-installed in the `amd64` image. Verify with `chrome://gpu` in the viewer — `WebGL Renderer` should report your iGPU instead of `SwiftShader`. |
| **Linux + AMD GPU** | Mount `/dev/dri`. Mesa Vulkan/GL drivers handle AMD. |
| **Linux + NVIDIA GPU** | Mount `/dev/dri` is not enough. Install [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/) on the host and add `--gpus all` to `docker run`. |
| **macOS / Windows / arm64 hosts** | Falls back to SwiftShader (CPU). No way to pass GPU into Linux containers via Docker Desktop. The arm64 image omits Mesa packages to stay small. |

### Use as base image

Set `executablePath` to `chrome` in puppeteer/playwright.

```dockerfile
FROM deaddev/browser

RUN npm install -g your-app

CMD ["your-app"]
```

```js
const browser = await puppeteer.launch({ executablePath: 'chrome' });
```

When called with `--*` flags (as puppeteer/playwright do), `chrome` starts the bridge in the background then execs into the browser directly.

### Start and stop

| Command | What it does |
| --- | --- |
| `chrome [...args]` | Start Chrome + bridge in foreground (default CMD) |
| `chrome start-detached [...args]` | Start Chrome + bridge in background |
| `chrome restart` | Restart both, reuses saved args |
| `chrome stop` | Stop both |

### Custom Chrome flags

Append extra flags to any start command. Such as `chrome [... your args]`.

```bash
docker run -d --init --shm-size=1g -p 6080:6080 \
  deaddev/browser chrome --proxy-server=socks5://host:1080
```

### Drive from agents (MCP)

The bridge exposes a Model Context Protocol (MCP) endpoint at `/mcp` so any MCP-capable agent can drive this browser as a tool. Streamable-HTTP transport, stateless.

Add to your agent's MCP config (Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "browser": {
      "type": "http",
      "url": "https://<your-bridge-host>/mcp"
    }
  }
}
```

The MCP server also sends an `instructions` field at the `initialize` handshake with a full workflow guide; agents typically read it automatically. The table below is a summary.

**Discovery and tab management:**

| Tool | Purpose |
| --- | --- |
| `browser_list_tabs()` | All tabs with id/url/title/mcpOwned/attention + cap counters. Call this first. |
| `browser_navigate(tabId, url)` | Navigate an EXISTING tab. Does not consume an FIFO slot. Prefer this to opening new tabs. |
| `browser_open(url)` | Create a new MCP-owned tab. Counts against the FIFO cap. |
| `browser_reload(tabId)` | Reload a tab (CDP Page.reload). |
| `browser_close_tab(tabId)` | Close any tab. Frees the MCP FIFO slot if it was MCP-owned. |

**Reading pages (pick the right tool):**

| Tool | Purpose |
| --- | --- |
| `browser_get_snapshot(tabId)` | **Primary.** Compact accessibility-tree text with stable `[uid=N]` markers. Filter follows Puppeteer's `interestingOnly` — 5-10× denser than HTML. |
| `browser_get_text(tabId, selector?)` | `document.body.innerText` (full, or scoped to a selector). Raw content, no structure. |
| `browser_get_html(tabId, path, maxDepth)` | Last-resort single-element inspection. HTML is markup-heavy — prefer snapshot. |
| `browser_evaluate(tabId, expression)` | Run JS in the page for reading only. NOT for clicks/typing/scrolling. |
| `browser_screenshot(tabId, fullPage?)` | Visual confirmation only (base64 PNG). |

**Interacting (trusted CDP input — passes bot detection):**

| Tool | Purpose |
| --- | --- |
| `browser_click(tabId, uid\|selector, includeSnapshot?)` | Trusted mouse click. Prefer `uid` (from snapshot). |
| `browser_type(tabId, text, uid?, selector?, includeSnapshot?)` | Trusted text input via `Input.insertText`. Clicks-to-focus first if uid/selector given. |
| `browser_press_key(tabId, key, includeSnapshot?)` | Named key (Enter, Tab, Escape, ArrowDown, …) via trusted keydown/keyup. |
| `browser_scroll(tabId, deltaX, deltaY)` | Scroll the page by delta pixels. |
| `browser_scroll_into_view(tabId, uid\|selector)` | Scroll until element is visible. |
| `browser_wait_for(tabId, expression, timeoutMs, intervalMs?)` | Poll a JS expression until truthy or timeout. |

**Human-in-the-loop:**

| Tool | Purpose |
| --- | --- |
| `browser_set_attention(tabId, message)` | Ask the human to act (captcha/MFA/login). Multi-paragraph message shown in a floating box on that tab. |
| `browser_dismiss_attention(tabId)` | Clear a prior attention request. Idempotent. |

#### Recommended workflow

1. `browser_list_tabs` — see what's there.
2. Reuse: `browser_navigate(tabId, url)` if an existing tab fits. Otherwise `browser_open(url)`.
3. `browser_get_snapshot(tabId)` — agent-readable view with `[uid=N]` markers.
4. `browser_click({tabId, uid})` / `browser_type({tabId, uid, text})` / `browser_press_key({tabId, key})` — drive the page.
5. Pass `includeSnapshot: true` on an action to receive a fresh snapshot in the same response.

Agents don't manage cleanup — FIFO auto-closes the oldest MCP-owned tab when you exceed `MCP_MAX_OPEN_TABS` (default 3).

#### MCP-owned tabs vs user-opened tabs

- **MCP-owned**: opened via `browser_open`. Counted against the FIFO cap.
- **User-owned**: opened by the human in the viewer, or by another channel. Never counted against FIFO, never auto-closed.
- `browser_navigate(tabId, url)` works on either without affecting ownership.
- An attention-bearing tab — MCP-owned or user-owned — is **protected from FIFO eviction**. `browser_open` errors with a clear message naming the protected tab if it would be evicted.

#### Captcha / human-in-the-loop workflow

When a page presents a captcha, MFA, paywall, or any human-only verification:

1. `browser_set_attention(tabId, "Please solve the captcha so I can continue.")` — multi-paragraph messages are supported.
2. `browser_wait_for(tabId, "<expr that goes truthy post-resolution>", timeoutMs)` — e.g. wait for a post-captcha element.
3. `browser_dismiss_attention(tabId)`.

The viewer pulses the tab's blinking dot and renders the message in a floating box on that tab. Concurrent attention requests are capped at `MCP_MAX_ATTENTION` (default 3).

Notes:
- All tabs are shared across agents — `browser_list_tabs` first, reuse where possible.
- Tools intentionally avoid enabling Runtime/Console/Debugger CDP domains, so the browser stays clean for bot-detection sites.

### Reverse proxy

Reverse proxy is supported out of the box, with or without a URL prefix. No configuration needed on the bridge side.

For example:

```nginx
location /my-browser/ {
    proxy_pass http://browser:6080/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Access at `https://my-nginx.com/my-browser`

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `BRIDGE_LOG` | `info` | Log level: `error`, `info`, `debug` |
| `BRIDGE_PORT` | `6080` | Change this to change the port of the web tool. |
| `CDP_HOST` | `127.0.0.1` | Chrome CDP host |
| `CDP_PORT` | `18800` | Chrome remote debugging port |
| `SCREENCAST_QUALITY` | `80` | JPEG quality (1-100) |
| `VIEWPORT_WIDTH` | `1920` | Viewport width |
| `VIEWPORT_HEIGHT` | `1080` | Viewport height |
| `MCP_MAX_OPEN_TABS` | `3` | Max simultaneous MCP-owned tabs (FIFO cap). |
| `MCP_MAX_ATTENTION` | `3` | Max simultaneous attention requests. |
