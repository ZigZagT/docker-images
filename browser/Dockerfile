ARG BASE_IMAGE=deaddev/ubuntu:nodejs
FROM ${BASE_IMAGE}

ARG BROWSER=chrome

RUN apt-get update \
    && apt-get install -y \
        fonts-liberation fonts-noto-core fontconfig \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

# Install browser variant: chrome (Google Chrome) | chromium (Chrome for Testing via Playwright)
RUN npm install -g playwright-core \
    && if [ "$BROWSER" = "chrome" ]; then \
         playwright-core install --with-deps chrome \
         && ln -sf /opt/google/chrome/chrome /usr/local/bin/chrome-raw; \
       elif [ "$BROWSER" = "chromium" ]; then \
         PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
         playwright-core install --with-deps chromium \
         && find /opt/ms-playwright -name "chrome" -path "*/chrome-linux*/*" -type f \
            -exec ln -sf "{}" /usr/local/bin/chrome-raw ";" ; \
       fi \
    && CHROME_UA=$(/usr/local/bin/chrome-raw --headless --no-sandbox --disable-gpu \
       --dump-dom 'data:text/html,<script>document.write(navigator.userAgent)</script>' 2>/dev/null \
       | grep -o 'Mozilla[^<]*' | sed 's/Headless//') \
    && echo "$CHROME_UA" > /usr/local/etc/chrome-ua

COPY --chmod=755 chrome-launcher /usr/local/bin/chrome-launcher
COPY --chmod=755 chrome /usr/local/bin/chrome

COPY browser-bridge/ /opt/browser-bridge/
RUN cd /opt/browser-bridge && npm install --omit=dev

CMD ["chrome"]
