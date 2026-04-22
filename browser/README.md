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
