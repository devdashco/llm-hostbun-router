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
COPY admin /srv/admin
COPY gen-prices.sh /usr/local/bin/gen-prices.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/gen-prices.sh /usr/local/bin/entrypoint.sh && mkdir -p /srv
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
