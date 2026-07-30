#!/bin/sh
# deploy.sh — push cccc to GitHub AND propagate to the whole fleet, in one step.
# Run from the cccc/ subdir of the llm-hostbun-router checkout.
#
# Run this INSTEAD of a bare `git push` when you want the fleet current. Explicit and
# deterministic (you run it, the fleet updates now), no background jobs. Each box pulls
# on ITS OWN git credential — pbox as philip, wmac as Williamdevdash — so there's no
# scp and no borrowed tokens. Deploy clones mirror origin (`git reset --hard`) and
# re-run cccc/install.sh (which sets .cccc-machine etc), so their statusline/TUI reflect
# the push immediately (they run the repo files in place).
#
# Add a box: append "<sshhost>:<repo-path>" to FLEET (repo-path = the llm-hostbun-router
# checkout root). An unreachable box is reported, never silently skipped.
set -eu

FLEET="pbox:/home/philip/.llm-hostbun-router wmac:/Users/williamwiklund/.llm-hostbun-router"

cd "$(dirname "$0")"   # the cccc/ dir

# Keep the plugin's BUNDLED copies in sync with the canonical ones. The plugin
# ships as a git-subdir of only cccc/plugins/claudectl/, so cccc/server/ isn't in
# the plugin cache — claudectl_local.py imports bundled copies. Refresh them here
# so they can never drift from server/.
#   claudectl_server.py — the account/proxy tools
#   _auth.py            — BearerMiddleware, now needed LOCALLY too: the plugin
#                         serves loopback HTTP instead of forking a stdio server
#                         per session, and that listener is still bearer-gated.
for f in claudectl_server.py _auth.py; do
  if ! cmp -s "server/$f" "plugins/claudectl/mcp/$f"; then
    cp "server/$f" "plugins/claudectl/mcp/$f"
    git add "plugins/claudectl/mcp/$f"
    git commit -q -m "chore(plugin): resync bundled $f" || true
    echo "→ resynced bundled $f"
  fi
done

echo "→ push origin master"
git push origin master

for spec in $FLEET; do
  host="${spec%%:*}"; dir="${spec#*:}"
  printf '→ %s ' "$host"
  if ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" \
       "cd '$dir' && git fetch -q origin master && git reset --hard -q origin/master && sh cccc/install.sh >/dev/null 2>&1 && printf 'ok %s (%s)\n' \"\$(git rev-parse --short HEAD)\" \"\$(cat ~/.claude-accounts/.cccc-machine 2>/dev/null)\"" 2>/dev/null; then
    :
  else
    echo "UNREACHABLE / failed — pull it manually later"
  fi
done
echo "done — fleet on $(git rev-parse --short HEAD)"
