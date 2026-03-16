ARG BASE_IMAGE=deaddev/ubuntu:nodejs
FROM ${BASE_IMAGE}

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# amd64 only — Playwright installs Chromium to chrome-linux64/
RUN apt-get update \
    && apt-get install -y \
        fonts-liberation fonts-noto-core fontconfig \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g playwright-core \
    && playwright-core install --with-deps chromium \
    && find /opt/ms-playwright -name "chrome" -path "*/chrome-linux64/*" \
       -exec ln -sf "{}" /usr/local/bin/chromium-raw ";" \
    && CHROME_UA=$(/usr/local/bin/chromium-raw --headless --no-sandbox --disable-gpu \
       --dump-dom 'data:text/html,<script>document.write(navigator.userAgent)</script>' 2>/dev/null \
       | grep -o 'Mozilla[^<]*' | sed 's/Headless//') \
    && echo "$CHROME_UA" > /usr/local/etc/chrome-ua

COPY --chmod=755 chromium-launcher /usr/local/bin/chromium-launcher
COPY --chmod=755 chromium /usr/local/bin/chromium

COPY browser-bridge/ /opt/browser-bridge/
RUN cd /opt/browser-bridge && npm install --omit=dev

CMD ["chromium"]
