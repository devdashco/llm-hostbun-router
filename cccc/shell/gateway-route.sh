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

# Direct-connect telemetry. On the direct paths `claude` talks to api.anthropic.com and the router
# logs NOTHING — same Max subscription, same tokens, zero rows, and the panel reads "no traffic"
# instead of "traffic we cannot see". Claude Code's own OTel stream closes that hole: its
# `claude_code.api_request` log event carries model + duration + all four token counts, and the
# router ingests it at /otel/v1/logs (src/otel.js) as a call-log row tagged `<consumer>:direct`.
#
#   http/json    — the router is zero-dep and cannot decode protobuf. Wrong protocol → 400.
#   logs only    — metrics are a counter over an export window; they cannot say which CALL the
#                  tokens belong to. Rows come from the log events.
#   *_LOGS_ENDPOINT is the FULL URL: per-signal endpoints are used verbatim, no /v1/logs appended.
#   the key is the box's own sk-llm-… (the SAME credential the routed path sends) — identity comes
#   from the key, never from a self-asserted resource attribute.
# Only ever called from the direct branches; the `up` branch UNSETS all of it, because a routed box
# that also shipped OTel would have every call counted twice.
_cctl_otel_direct() {
  local url="$1" key="$2"
  [ -n "$key" ] || { _cctl_otel_off; return 0; }   # no key → nothing to authenticate with
  export CLAUDE_CODE_ENABLE_TELEMETRY=1
  export OTEL_LOGS_EXPORTER=otlp
  export OTEL_METRICS_EXPORTER=none
  export OTEL_TRACES_EXPORTER=none
  export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
  export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="$url/otel/v1/logs"
  export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer $key"
  export OTEL_LOGS_EXPORT_INTERVAL=5000
}
_cctl_otel_off() {
  unset CLAUDE_CODE_ENABLE_TELEMETRY OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER OTEL_TRACES_EXPORTER \
        OTEL_EXPORTER_OTLP_PROTOCOL OTEL_EXPORTER_OTLP_LOGS_ENDPOINT OTEL_EXPORTER_OTLP_HEADERS \
        OTEL_LOGS_EXPORT_INTERVAL 2>/dev/null || true
}

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
    # The key is NOT exported as ANTHROPIC_AUTH_TOKEN (a router credential 401s against
    # api.anthropic.com) — it only authenticates the telemetry push, so the spend still lands in the
    # call log under this box's name while the inference itself bypasses the router.
    [ -r "$acctdir/.cccc-key" ] && key=$(cat "$acctdir/.cccc-key" 2>/dev/null | tr -d '[:space:]')
    _cctl_otel_direct "$url" "$key"
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
    # Routed: proxy() already writes the call-log row. Shipping OTel too would log every call twice.
    _cctl_otel_off
  else
    # gateway unreachable → go direct so claude never breaks. Drop OUR key too: it's a
    # router credential, worthless (401) against api.anthropic.com — unset it so claude
    # uses the keychain OAuth login instead.
    unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_CUSTOM_HEADERS 2>/dev/null || true
    # …but it still authenticates the telemetry push, so this window is accounted for rather than
    # invisible. The router is down right now, so the exporter's own POSTs fail and are dropped —
    # this is set for the moment it comes back, not as a promise that every direct call is captured.
    [ -r "$acctdir/.cccc-key" ] && key=$(cat "$acctdir/.cccc-key" 2>/dev/null | tr -d '[:space:]')
    _cctl_otel_direct "$url" "$key"
  fi
}

_cctl_gateway_route
