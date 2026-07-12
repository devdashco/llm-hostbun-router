#!/usr/bin/env bash
# Run the panel + docs LOCALLY on :8787 but backed by PROD data:
#   - pulls prod /data/config.json  → .local/config.json  (accounts, pins, routes, limits)
#   - opens an ssh tunnel to the prod Postgres container    (the call log: stats/calls/usage)
#   - launches server.js pointed at both
#
# No secrets live in this repo. The DSN and config are fetched at run time over ssh
# (host alias `hostbun` = root@57.129.79.254, key auth). .local/ is gitignored.
#
#   ./scripts/dev-prod.sh          # foreground
# Stop: Ctrl-C (leaves the tunnel up; re-run reuses it). Kill tunnel: pkill -f '5455:.*:5432'.
set -euo pipefail
cd "$(dirname "$0")/.."

SSH_HOST="${SSH_HOST:-hostbun}"
APP_UUID="${APP_UUID:-d11s05nc130l2kjzr6anpebr}"   # Coolify app; container name is <uuid>-<n>
PORT="${PORT:-8787}"
LPORT="${LPORT:-5455}"                              # local end of the DB tunnel

say(){ printf '\033[35m[dev-prod]\033[0m %s\n' "$*" >&2; }

mkdir -p .local

say "resolving prod container on ${SSH_HOST}…"
C=$(ssh "$SSH_HOST" "docker ps --format '{{.Names}}' | grep -m1 '$APP_UUID'")
[ -n "$C" ] || { echo "no running container matching $APP_UUID" >&2; exit 1; }

say "pulling prod config → .local/config.json"
ssh "$SSH_HOST" "docker exec $C cat /data/config.json" > .local/config.json
node -e 'const c=require("./.local/config.json");console.error("[dev-prod] accts "+(c.claudecodeAccountPool||c.anthropicPool||[]).length+" pins "+Object.keys(c.projectAccounts||{}).length+" routes "+Object.keys(c.projectRoutes||{}).length)'

say "reading prod DATABASE_URL"
DSN=$(ssh "$SSH_HOST" "docker exec $C printenv DATABASE_URL")
# postgres://user:pass@<dockerhost>:5432/db  →  swap host:port for the tunnel's local end
DBHOST=$(printf '%s' "$DSN" | sed -E 's#.*@([^:/]+):.*#\1#')
LOCAL_DSN=$(printf '%s' "$DSN" | sed -E "s#@[^:/]+:[0-9]+/#@localhost:$LPORT/#")

if lsof -tiTCP:"$LPORT" -sTCP:LISTEN >/dev/null 2>&1; then
  say "tunnel already up on :$LPORT"
else
  say "resolving DB container IP ($DBHOST) + opening tunnel :$LPORT → \$IP:5432"
  IP=$(ssh "$SSH_HOST" "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' $DBHOST" | awk '{print $1}')
  [ -n "$IP" ] || { echo "could not resolve $DBHOST IP" >&2; exit 1; }
  ssh -fN -L "$LPORT:$IP:5432" "$SSH_HOST"
  sleep 1
fi

# free the port if a stale dev server holds it
if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  say "freeing :$PORT (stale server)"
  lsof -tiTCP:"$PORT" -sTCP:LISTEN | xargs -r kill; sleep 1
fi

say "launching → http://localhost:$PORT/  (panel)   /docs/ (docs)   pw ddash"
exec env \
  DATABASE_URL="$LOCAL_DSN" \
  CONFIG_FILE=./.local/config.json \
  PORT="$PORT" \
  ADMIN_FILE=./admin/index.html \
  DOCS_FILE=./docs/index.html \
  SESSION_INSECURE=1 \
  node server.js
