# browser

> **Source**: [Dockerfile](https://github.com/ZigZagT/docker-images/tree/master/browser)

Browser image providing `/usr/local/bin/chrome` — a ready-to-use browser with a proxy bridge allowing manual access.

```bash
docker pull deaddev/browser
# or
docker pull ghcr.io/zigzagt/browser
```

**linux/amd64, linux/arm64** — Playwright 1.57+ installs [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) headless shell on amd64, Chromium headless shell on arm64.

### Supported Tags

| Tag | Content |
| --- | --- |
| `latest` | Headless shell + browser-bridge CDP proxy |
| `chrome` | Alias for `latest` |
| `chromium` | Alias for `latest` |

## Launch as Base Image

Use `chrome` as the `executablePath` in puppeteer/playwright. It wraps Chrome with sane defaults, with remote debugging open on `CDP_PORT`.

```dockerfile
FROM deaddev/browser

RUN npm install -g your-app

CMD ["your-app"]
```

```js
const browser = await puppeteer.launch({ executablePath: 'chrome' });
```

## Launch as Standalone Browser

Running the image directly starts Chrome and the browser bridge:

```bash
docker run -d --init --name browser --shm-size=1g \
  -p 6080:6080 \
  deaddev/browser
```

## How to access the browser

Open `http://<host>:6080` to access the browser.

### Process management

`chrome` in this image accepts subcommands:

| Command | Description |
| --- | --- |
| `chrome [...args]` | Start Chrome + bridge in foreground (default entrypoint) |
| `chrome start-detached [...args]` | Start Chrome + bridge in background |
| `chrome restart` | Restart both (uses saved args) |
| `chrome stop` | Stop both |

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

Environment variables for `chrome` and the bridge:

| Variable | Default | Description |
| --- | --- | --- |
| `BRIDGE_LOG` | `info` | Bridge log level: `error`, `info`, `debug` |
| `BRIDGE_PORT` | `6080` | HTTP/WebSocket port for the bridge viewer |
| `CDP_HOST` | `127.0.0.1` | Chrome CDP host (bridge connects here) |
| `CDP_PORT` | `18800` | Chrome remote debugging port |
| `SCREENCAST_QUALITY` | `80` | JPEG quality for screencast frames (1-100) |
| `VIEWPORT_WIDTH` | `1920` | Viewport width |
| `VIEWPORT_HEIGHT` | `1080` | Viewport height |

## Contents

- `/usr/local/bin/chrome` — Chrome entry point and process manager
- `/usr/local/bin/chrome-launcher` — lower-level wrapper that applies rendering/anti-detection flags; called internally by `chrome`
- `/usr/local/bin/chrome-raw` — browser binary (symlink to underlying Chrome/Chromium install)
- `/usr/local/etc/chrome-ua` — build-time detected User-Agent with "Headless" stripped
- `/opt/browser-bridge/` — CDP screencast proxy (server.mjs, index.html)
- Fonts: Liberation and Noto Core families
