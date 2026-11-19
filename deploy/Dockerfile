# Lamplighter.
#
# Debian slim, not Alpine: better-sqlite3 ships glibc prebuilds for amd64 and arm64, so the image
# needs no node-gyp toolchain. `git` is not optional — Lamplighter keeps a bare clone of every
# repo it monitors and does every fetch, commit and push itself (the model never touches a remote).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY server/ server/
COPY web/ web/
RUN npm run build --workspace web && npm run build --workspace server
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    LAMPLIGHTER_DATA_DIR=/DATA \
    LAMPLIGHTER_PORT=8080 \
    LAMPLIGHTER_HOST=0.0.0.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules        ./node_modules
COPY --from=build /app/package.json        ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist         ./server/dist
COPY --from=build /app/server/public       ./server/public
# The nine checks and the default policy, copied onto the volume on first boot and never
# overwritten: the volume copy is the live one.
COPY seed/ ./seed/
# Fixture seeding for the local end-to-end test (deploy/dev). Harmless in production.
COPY deploy/dev/seed-fixtures.sh /usr/local/bin/seed-fixtures
RUN mkdir -p /DATA && chown -R node:node /DATA /app
USER node
VOLUME ["/DATA"]
EXPOSE 8080
# Liveness only: an unreachable inference backend or forge is a legitimate, reported state.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LAMPLIGHTER_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
