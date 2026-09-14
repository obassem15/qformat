# qformat-pdf-service — production container image
#
# Bundles Node + a system Chromium (with all its shared-library
# dependencies) so the image runs on any Docker host (Render, Railway,
# Fly.io, Cloud Run, a VPS, ...) with zero local setup on the user's side.
# Puppeteer's own Chromium download is skipped in favor of the apt-get'd
# one below (smaller image, avoids Puppeteer's download flakiness in CI).

FROM node:20-bookworm-slim

# Chromium + the fonts/libs it needs to actually render pages correctly.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

# Run as a non-root user (recommended for Chromium sandboxing/security).
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser /app
USER pptruser

EXPOSE 5174

CMD ["node", "server.js"]
