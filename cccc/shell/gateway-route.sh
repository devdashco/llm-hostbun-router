# gateway-route.sh — route local Claude Code through the llm.hostbun.cc gateway,
# FAIL-OPEN. Source this from your shell rc (install.sh wires it into ~/.zshenv,
# which EVERY zsh — including cmux Dock / non-interactive panes — sources) INSTEAD
# of hard-coding ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json.
#
# WHY it can't live in settings.json: settings.json `env` OVERRIDES the shell env
# (verified), and it's static JSON — so a hard-coded base URL there can never fall
# back when the router is down; every local `claude` on this box just breaks. This
# function decides the base URL per shell instead:
#   router up   → export gateway identity (base URL + this box's sk-llm key + headers)
#   router down → UNSET all three → `claude` talks to api.anthropic.com directly on
#                 the keychain OAuth login (same Max subscription, we just lose
#                 per-consumer tracking for that window). Never breaks.
#
# For the fallback to be usable, ~/.claude/settings.json env must NOT pin
# ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN (install.sh migrates them out). Account
# selection stays the router's SERVER-side pin (/api/pins) — headers can't override
# it; this only decides base URL + whether to send our key at all.
#
# Identity (per box, written by install.sh):
#   ~/.claude-accounts/.cccc-key      the box's sk-llm-… consumer key (0600). Optional:
#                                     absent → route through the gateway keyless (auth
#                                     `optional` mode) or not at all.
#   ~/.claude-accounts/.cccc-machine  the consumer id (→ X-Consumer / X-Project:<id>-claude)
#
# State marker for the statusline — ~/.claude/.cctl-route, "ts<TAB>state":
#   the statusline reads it (plus whether .cccc-key exists) to tell a DELIBERATE
#   direct box from one that FELL BACK because the router is down, and flags the
#   latter loudly instead of a silent `·direct`.

_cctl_gateway_route() {
  local url="${CCCC_GATEWAY_BASE:-https://llm.hostbun.cc}" acctdir="$HOME/.claude-accounts" \
        marker="$HOME/.claude/.cctl-route" ttl=45 now state="" ts st key consumer
  now=$(date +%s 2>/dev/null) || return 0

  # DELIBERATE force-direct override (TUI: Setup → direct-connect toggle, or
  # `touch ~/.claude-accounts/.cccc-force-direct`). Router up but slow → the user
  # would rather hit api.anthropic.com straight. Checked BEFORE the health probe and
  # independent of the TTL cache, so it wins even when the router is reachable. Writes
  # marker state `direct` (NOT `down`) so the statusline shows a plain `·direct`, not
  # the loud red router-down fallback tag. `rm` the file (or toggle off) to route again.
  if [ -f "$acctdir/.cccc-force-direct" ]; then
    unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_CUSTOM_HEADERS 2>/dev/null || true
    mkdir -p "$HOME/.claude" 2>/dev/null
    printf '%s\t%s\n' "$now" "direct" > "$marker" 2>/dev/null || true
    return 0
  fi

  # cached verdict (marker doubles as the TTL cache) — don't curl on every new shell.
  if [ -r "$marker" ]; then
    IFS='	' read -r ts st < "$marker" 2>/dev/null
    [ -n "$ts" ] && [ "$((now - ts))" -lt "$ttl" ] && state="$st"
  fi
  if [ -z "$state" ]; then
    if command -v curl >/dev/null 2>&1 && curl -sf -m 2 -o /dev/null "$url/v1/models" 2>/dev/null; then
      state=up
    else
      state=down
    fi
    mkdir -p "$HOME/.claude" 2>/dev/null
    printf '%s\t%s\n' "$now" "$state" > "$marker" 2>/dev/null || true
  fi

  if [ "$state" = up ]; then
    export ANTHROPIC_BASE_URL="$url"
    [ -r "$acctdir/.cccc-key" ] && key=$(cat "$acctdir/.cccc-key" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$key" ]; then
      export ANTHROPIC_AUTH_TOKEN="$key"
    else
      unset ANTHROPIC_AUTH_TOKEN 2>/dev/null || true
    fi
    consumer=$(cat "$acctdir/.cccc-machine" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$consumer" ]; then
      export ANTHROPIC_CUSTOM_HEADERS="X-Consumer: $consumer
X-Project: $consumer-claude"
    fi
  else
    # gateway unreachable → go direct so claude never breaks. Drop OUR key too: it's a
    # router credential, worthless (401) against api.anthropic.com — unset it so claude
    # uses the keychain OAuth login instead.
    unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_CUSTOM_HEADERS 2>/dev/null || true
  fi
}

_cctl_gateway_route
