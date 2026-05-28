FROM node:22-alpine
RUN apk add --no-cache curl jq
WORKDIR /app
COPY server.js /app/server.js
COPY docs /srv/docs
COPY gen-prices.sh /usr/local/bin/gen-prices.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/gen-prices.sh /usr/local/bin/entrypoint.sh && mkdir -p /srv
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
