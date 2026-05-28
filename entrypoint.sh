#!/bin/sh
mkdir -p /srv
sh /usr/local/bin/gen-prices.sh || true
( while true; do sleep 21600; sh /usr/local/bin/gen-prices.sh || true; done ) &
exec node /app/server.js
