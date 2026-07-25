# cccc — operate the Claude Max fleet behind llm.hostbun.cc

`cccc` is the control surface over the pool of Claude Max subscriptions behind the
**llm.hostbun.cc router** (this repo). It lives here, in the `cccc/` subdir, because
it drives the router's own `/api/*` admin surface — account list, live 5h/7d limits,
and the server-side account pin — so tool and gateway ship together. (The router
never rotates: one project → one pinned account, by invariant.)

> Moved here from the old `devdashco/claudectl` repo. That repo now holds **only the
> cmux Dock** (its own `cmuxdock` plugin). `claude.hostbun.cc` (the old claudebox
> account wrapper) is retired; everything reads `llm.hostbun.cc/api/*` now.

## What's here

- **`tui/`** — `cccc`, the curses dashboard (`claudectl_tui.py`). Tabs: Accounts ·
  Windows · Plugins · Setup. Subcommands (headless / menu actions): `cccc refresh`,
  `cccc doctor`, `cccc sync`, `cccc panes`. Plus `cccc_gateway.py` (route the local
  `claude` through the gateway) and `cccc_sync.py` (cron pull + re-install).
- **`statusline/cccc-statusline.py`** — the one shared statusline (pure stdlib).
- **`server/`** — the MCP server source (account/limit/proxy tools, httpx →
  llm.hostbun.cc). CANONICAL copy; the plugin ships a byte-identical bundle at
  `plugins/claudectl/mcp/claudectl_server.py` (a full checkout imports `server/`,
  the plugin cache imports the bundle — `deploy.sh` resyncs it, fix here first).
- **`plugins/claudectl/`** — the Claude Code plugin: one local `claudectl` stdio MCP
  (~48 tools) + skills + the `/cccc` command.

## Install

```sh
sh cccc/install.sh      # puts cccc + cccp/cccd/cccr/cccs on ~/.local/bin, wires the
                        # statusline, installs the local claudectl MCP deps
```

The cmux Dock (`cmuxdock`/`cccl`) installs separately from the `devdashco/claudectl`
repo.

## Statusline — the 🔌 MCP badge

A dead MCP server is otherwise **invisible**: `claude` prints "failed to connect"
once at startup, it scrolls away, and after that the tool is just absent — you find
out when a tool call fails. So the statusline keeps it on screen:

```
🔌17✓            dim — all 17 servers of this session answered
🔌⚠1/17 🔑gitlab  BOLD RED, and it moves to the FRONT of line 1 so a narrow
                 pane can truncate anything except the alarm
🔌16✓ ⟳autonoma   yellow — enabled but installed after this session started
```

`🔑` the server answered and said no (401 / revoked token) · `💀` it never answered
(refused / DNS / TLS / timeout) · `✖` failed some other way · `⟳` needs a restart to
load · `?` enabled and configured, yet never showed up at all.

Truth is Claude Code's own per-server logs (`~/.cache/claude-cli-nodejs/<cwd>/
mcp-logs-*/`) filtered to **this session id**, so the badge says exactly what `/mcp`
says — nothing is probed or inferred. A healthy http server is noisy (its SSE stream
idles out and re-dials every few minutes), so only a *decisive* failure moves the
verdict; retries, drops and clean exits do not. "Configured but absent" is reported
only when most of the expected set was found — a partial view is never published as
"these are missing". `cccc-statusline.py --mcp [cwd] [session]` prints the table
behind the badge.

## Accounts / limits (read before touching limit logic)

Max accounts have a **5-hour** burst limit AND a **7-day** weekly limit; the 7-day is
usually the binding one. The router's `/api/limits` reports Anthropic's real
rate-limit headers per account (`u5`/`u7`/`status`, keyed by org-id) — trust that.
`/api/state:claudecodeAccountPool` maps account name ↔ org-id. `cccc` joins the two.

**Pinning is server-side now.** Tokens live in the router; there is no keychain
token to swap. `cccc` "switch" pins this box's consumer (and its `-claude` alias) via
**`POST /api/pins`** — merge-safe and account-validated. (Never `POST /api/config`
with a pin map: it assigns `projectAccounts` wholesale AND the stale-clone merge makes
a single-consumer save a silent no-op for already-pinned consumers.) The box must
route through the gateway (`ANTHROPIC_BASE_URL=https://llm.hostbun.cc`) for the pin
to bill.

**Harvested vs live limits.** `GET /api/limits` is FREE but passive — it learns only
from traffic an account actually serves, so an idle/refunded account keeps a stale
reading (`limits: null` = "no reading", never 0%). The ground truth is
`POST /api/claudecode/limits {all:true}` (or `{account}`): the router pings each
subscription once (1 token) for fresh headers. That's what the TUI's "⚡ LIVE limit
check" / "test account (live)" and the MCP `live_limits` tool call. A 429 = spent
window (wait for reset); a 403 `permission_error` = OAuth-disabled dead login — no
reset fixes it.
