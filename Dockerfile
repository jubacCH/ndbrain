# Two stages: build the web bundle and compile the server, then ship only what
# runs. The runtime image carries no compilers, no dev dependencies and no
# TypeScript — a smaller attack surface for something meant to be exposed.
#
# There is no native module anywhere in this image on purpose: SQLite comes from
# Node itself, so this builds on any architecture Node supports without a
# toolchain.

FROM node:24-bookworm-slim AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY web/ ./
RUN npx vite build

FROM node:24-bookworm-slim AS server
WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY server/ ./
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

# tini reaps zombies and forwards signals, so SIGTERM from `docker stop` actually
# reaches the process and the shutdown handler runs instead of being killed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NDBRAIN_DATA_DIR=/data \
    NDBRAIN_WEB_ROOT=/app/web \
    NDBRAIN_HOST=0.0.0.0 \
    NDBRAIN_PORT=3000 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app
COPY --from=server /build/server/dist ./dist
COPY --from=server /build/server/node_modules ./node_modules
COPY --from=server /build/server/package.json ./package.json
COPY --from=web /build/web/dist ./web

# The vault holds the user's notes; it must outlive the container.
RUN mkdir -p /data/vaults /data/index && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NDBRAIN_PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/main.js"]
