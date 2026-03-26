ARG BASE_IMAGE=deaddev/ubuntu:nodejs
FROM ${BASE_IMAGE}

# Full browser (not --only-shell) required for Page.startScreencast (bridge rendering).
# --no-shell: skip headless shell (~254MB) since we use the full browser.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-liberation fonts-noto-core fontconfig \
    && fc-cache -fv \
    && npm install -g playwright-core \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
       playwright-core install --with-deps --no-shell chromium \
    && find /opt/ms-playwright -name "chrome" -path "*/chrome-linux*/*" -type f \
       -exec ln -sf "{}" /usr/local/bin/chrome-raw ";" \
    && rm -rf /opt/ms-playwright/ffmpeg-* \
    && find /opt/ms-playwright -path "*/locales/*.pak" ! -name "en-US.pak" -delete \
    && apt-get purge -y xvfb && apt-get autoremove -y --purge \
    && npm rm -g playwright-core \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* /tmp/* /root/.cache

# Extract real (non-headless) UA via CDP — --dump-dom is unreliable on headless shell.
# Polls CDP endpoint with retries instead of a fixed sleep, and fails the build if
# UA extraction doesn't succeed within 30 attempts.
RUN chrome-raw --headless --no-sandbox --disable-gpu --remote-debugging-port=19222 & \
    CHROME_PID=$!; \
    UA=""; \
    for i in $(seq 1 30); do \
        UA=$(node -e " \
          const http = require('http'); \
          http.get('http://127.0.0.1:19222/json/version', res => { \
            let d=''; res.on('data',c=>d+=c); \
            res.on('end', () => { \
              process.stdout.write(JSON.parse(d)['User-Agent'].replace('Headless','')); \
            }); \
          }).on('error', () => process.exit(1)); \
        " 2>/dev/null) && [ -n "$UA" ] && break; \
        sleep 1; \
    done; \
    kill $CHROME_PID 2>/dev/null; \
    [ -n "$UA" ] || { echo "ERROR: Failed to extract Chrome UA after 30 attempts" >&2; exit 1; }; \
    echo "$UA" > /usr/local/etc/chrome-ua

COPY --chmod=755 chrome-launcher /usr/local/bin/chrome-launcher
COPY --chmod=755 chrome /usr/local/bin/chrome

COPY browser-bridge/package.json browser-bridge/package-lock.json /opt/browser-bridge/
RUN cd /opt/browser-bridge && npm install --omit=dev && npm cache clean --force
COPY browser-bridge/server.mjs browser-bridge/index.html /opt/browser-bridge/

CMD ["chrome"]
