# browser

> **Source**: [Dockerfile](https://github.com/ZigZagT/docker-images/tree/master/browser)

Chromium browser image providing `/usr/local/bin/chromium` — a ready-to-use Chrome with a proxy bridge allowing manual access to the browser.

```bash
docker pull deaddev/browser:chrome
# or
docker pull ghcr.io/zigzagt/browser:chrome
```

**linux/amd64 only** — Playwright's Chromium build targets x86_64.

### Supported Tags

| Tag | Content |
| --- | --- |
| `chrome` | Chromium + browser-bridge CDP proxy |

## Launch as Base Image

Use `chromium` as the `executablePath` in puppeteer/playwright. It wraps Chrome with sane defaults, with remote debugging open on `CDP_PORT`.

```dockerfile
FROM deaddev/browser:chrome

RUN npm install -g your-app

CMD ["your-app"]
```

```js
const browser = await puppeteer.launch({ executablePath: 'chromium' });
```

## Launch as Standalone Browser

Running the image directly starts Chrome and the browser bridge:

```bash
docker run -d --name browser --shm-size=1g --platform linux/amd64 \
  -p 6080:6080 \
  deaddev/browser:chrome
```

## How to access the browser

Open `http://<host>:6080` to access the browser.

### Process management

`chromium` in this image accepts subcommands for granular control:

| Command | Description |
| --- | --- |
| `chromium` | Start Chrome + proxy bridge (default entrypoint) |
| `chromium stop` | Stop both (also signals foreground entrypoint to exit) |
| `chromium restart` | Restart both (Chrome restarts with saved args) |
| `chromium status` | Show status of both |
| `chromium chrome start [args]\|stop\|restart\|status` | Manage Chrome only |
| `chromium bridge start\|stop\|restart\|status` | Manage bridge only |

All output goes to stdout/stderr — use `docker logs` to view.

### Reverse proxy

The bridge works behind a reverse proxy optionally with a URL prefix — no configuration needed. The server extracts the last path segment for routing, and the client derives its base path from `location.pathname`:

```nginx
location /my-browser/ {
    proxy_pass http://browser:6080/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## Configuration

Environment variables for `chromium` and the bridge:

| Variable | Default | Description |
| --- | --- | --- |
| `BRIDGE_PORT` | `6080` | HTTP/WebSocket port for the bridge viewer |
| `CDP_HOST` | `127.0.0.1` | Chrome CDP host (bridge connects here) |
| `CDP_PORT` | `18800` | Chrome remote debugging port |
| `SCREENCAST_QUALITY` | `80` | JPEG quality for screencast frames (1-100) |
| `VIEWPORT_WIDTH` | `1920` | Viewport width |
| `VIEWPORT_HEIGHT` | `1080` | Viewport height |

## Contents

- `/usr/local/bin/chromium` — Chrome entry point and process manager
- `/usr/local/bin/chromium-launcher` — lower-level wrapper that applies rendering/anti-detection flags; called internally by `chromium`
- `/usr/local/bin/chromium-raw` — Chromium binary (symlink into playwright install)
- `/usr/local/etc/chrome-ua` — build-time detected User-Agent with "Headless" stripped
- `/opt/browser-bridge/` — CDP screencast proxy (server.mjs, index.html)
- Fonts: Liberation and Noto Core families
