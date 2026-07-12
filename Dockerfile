# ── Stage 1: build the Next.js panel as a static export ──────────────────────
# Dev deps are allowed here; the output is just files (panel/out). None of Next's runtime reaches
# the final image — the router serves the export as plain static files.
FROM node:24-alpine AS panel
WORKDIR /panel
COPY panel/package.json panel/package-lock.json ./
RUN npm ci
COPY panel/ ./
RUN npm run build

# ── Stage 2: the pg-only router ──────────────────────────────────────────────
FROM node:24-alpine
RUN apk add --no-cache curl jq
WORKDIR /app
# Deps first, so a code-only change reuses this layer. `pg` is the router's ONLY runtime dependency:
# the call log lives in the llmrouter Postgres, not in a file on the container's volume.
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev
COPY server.js /app/server.js
COPY translate.js /app/translate.js
# The whole router lives in src/. A directory COPY, not a file list: the old per-file list is why a
# new require'd file crash-looped the container on boot.
COPY src /app/src
COPY docs /srv/docs
# The built Next export → /srv/panel, which server.js serves (PANEL_DIR). ADD A COPY like this for
# any new required path, or the container is missing it at runtime.
COPY --from=panel /panel/out /srv/panel
COPY gen-prices.sh /usr/local/bin/gen-prices.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/gen-prices.sh /usr/local/bin/entrypoint.sh && mkdir -p /srv
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
