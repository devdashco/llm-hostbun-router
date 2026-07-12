---
name: claudectl
description: >-
  Control everything behind llm.hostbun.cc via the `claudectl` MCP + the `cccc` TUI:
  manage the router's Claude Max account pool (list, REAL 5h/7d limits, pin/switch,
  add/delete, refresh ccc panes) AND the model router itself (providers, routing,
  health, stats). Load whenever the user is "hitting the limit", asks to "switch
  Claude account", mentions "llm.hostbun.cc", "5h window", "7d limit", "which
  account", "cccc", "which provider / model routing", "crazyrouter", "local model",
  provider health, or an account shows an auth/limit error. CRITICAL: the binding
  limit is often the 7-DAY window, and a harvested `limits: null` means "no
  reading" (never 0%) — use `live_limits` for on-demand truth.
---

# claudectl — Claude Max accounts + LLM router (llm.hostbun.cc)

Everything is driven by the one local `claudectl` MCP (stdio, ships with this
plugin) and the `cccc` curses TUI. Router admin password: `ddash`.

- **`llm.hostbun.cc`** = the **llm-hostbun-router** — the ONLY middleman between our
  code and a model. One OpenAI/Anthropic-compatible base URL (`/v1`) that picks the
  provider from the model id. It ALSO owns the **Claude Max account pool**
  (`claudecodeAccountPool`): every account tool below drives the router's
  cookie-gated `/api/*` control plane (the MCP handles the login).
- **`claude.hostbun.cc` is RETIRED** (DNS-dead). The old claudebox wrapper and its
  `/v1/accounts/*` / `/ui/*` APIs are gone forever — there is no load balancer, no
  "active account", no token reveal. Account selection is a server-side
  **project → account pin**, one account per project, no rotation.

---

## PART 1 — Accounts & limits

### ⚠️ The one thing that matters most: 7-day vs 5-hour

Claude Max accounts have **two** rolling limits, and either can block you:

| window | behaviour |
|---|---|
| **5-hour** | short-term burst cap; a fixed block that starts on your first message and resets 5h later. Resets often. |
| **7-day** | sustained weekly cap. When it maxes, the account is **dead for ~a day+** regardless of the 5h window. |

**The 7-DAY window is often the real binding limit.** An account can show a fresh
5h (0%) yet be **rejected** because its 7d is at 100%.

The router harvests limits **for free** off the `anthropic-ratelimit-unified-*`
headers of real traffic (`accounts_list` / `window_status` / `proxy_limits`). But
the harvest only learns from calls an account actually serves, so an **idle**
account — or one Anthropic refunded/reset — keeps its last reading, and
**`limits: null` means "no reading", NEVER 0%**.

➡️ When you need current truth (idle account, suspected refund, "which account can
serve right now"), use **`live_limits`** — the router pings each subscription ONCE
(`claude-haiku-4-5`, `max_tokens: 1`, i.e. 1 token per account) purely to pull
fresh headers. Interpreting a failed reading:

- **429** = the usage window is **spent** — wait for `reset5`/`reset7`; the login
  is fine.
- **403 `permission_error`** ("OAuth authentication is currently not allowed for
  this organization") = a **dead login** — the subscription itself is disabled;
  no reset fixes it. Re-pin its projects to another account.

There is no priming/staggering and no keeper anymore — a 5h window starts when a
pinned project's traffic starts it. More accounts = more weekly budget; otherwise
use less.

### Account tools

Read:
- `accounts_list` — the pool with everything joined: per-account harvested 5h/7d
  limits, pinned projects, per-account spend (lifetime + 24h calls/tokens,
  rate-limited/error counts), `orphanPins`. Tokens are never included.
- `live_limits(account?)` — **on-demand ground truth**: 1-token probe per account,
  fresh 5h/7d utilization + reset times; omit `account` to sweep the pool.
- `window_status` — compact per-account 5h/7d % + reset clocks from the harvested
  readings (free; `null` = no reading).
- `usage_today(window?)` — what ran through the claudecode provider over the
  window: provider totals + by_model / by_project (from the router's Postgres
  call log; old rows carry provider='anthropic', new ones 'claudecode' — both
  counted). Per-ACCOUNT spend lives on `accounts_list`.
- `fleet_presence` — who's on what account across every machine.
- `models_list` — every model id the router serves (public `/v1/models`).

Write:
- `account_switch(account, consumer?)` — re-pin THIS box (both `<consumer>` and
  `<consumer>-claude`) to `account` via two merge-safe `/api/pins` calls.
  `consumer` defaults to the box name (CCCC_MACHINE → ~/.claude-accounts/.cccc-machine
  → hostname). Other projects' pins are untouched.
- `account_add(name, token)` — import/rotate a pool account's token (a
  `claude setup-token`, `sk-ant-oat…`). **Import only — the router NEVER reveals
  tokens back out**; the pool in /data/config.json is the only copy anywhere.
- `account_delete(name, force?)` — remove from the pool. **Irreversible** (no
  backup, no reveal). 409s if projects still pin it unless `force`.
- `proxy_pin(project, account)` — pin any project to an account (empty clears).

### Switching only affects NEW requests' billing, not running sessions

`account_switch` changes the server-side pin, so the very next request bills the
new account. But a locally-running Claude Code session keeps its own keychain
token until restarted — `cccc refresh --go` restarts running cmux `ccc` panes,
resuming each conversation.

Interactive local Claude Code goes through the router's native `/v1/messages`
passthrough (the `claudep` alias / `pmac-claude` consumer) — which is exactly why
`account_switch` pins `<consumer>-claude` too.

---

## PART 2 — LLM router (llm.hostbun.cc)

One OpenAI/Anthropic-compatible endpoint (`https://llm.hostbun.cc/v1`) that picks a
provider **by model name**:

| provider | select with `model` | upstream |
|---|---|---|
| **local** | `local` / `qwen3.5-9b` | llama.cpp on the pbox GPU (free) |
| **claudecode** | `claude*` (e.g. `claude-sonnet-4-6`) | the Claude Max account pool → api.anthropic.com (flat) |
| **crazyrouter** | anything else (`gemini-*`, `gpt-*`, …) | crazyrouter.com cloud relay (**per token**) |

(Legacy names `wrappy`/`anthropic`/`claude`/`cloud` are migrated on read; old
call-log rows may still say `provider='anthropic'`.)

Its admin surface is **`/api/*`**, cookie-gated by `ADMIN_PASSWORD` (default
`ddash`) — the `claudectl` MCP handles the login for you.

### `proxy_*` tools

- `proxy_state` — full live routing config: providers, bases, `forceModel` (global
  override), `modelRoutes` (per-model pins), `projectRoutes`, `projectAccounts`
  (account pins), `cloudPolicy` (open/allowlist/off) + allowlist, `defaultRoute`,
  auth mode, masked secrets.
- `proxy_health` — probe each provider: up? ms? model count. (claudecode health =
  "do we hold accounts"; there is no free probe.)
- `proxy_models` — merged model catalog per provider. `proxy_limits` — harvested
  per-account rate-limit snapshot, keyed by Anthropic org id (free, off real
  traffic headers; missing/stale row = no reading, never 0%).
- `proxy_resolve(model, project?)` — **dry-run** which provider a model routes to (no call).
- `proxy_test(model, prompt?)` — route AND call a model end-to-end (a claudecode
  test spends real subscription window).
- `proxy_stats(window?)` — usage over 15m|1h|6h|24h|7d|30d|all: calls/tokens/errors/
  cost, byProvider / byModel / byProject.
- `proxy_calls(...)` — recent call log from Postgres (filter by
  provider/model/project/status/search).
- `proxy_pin(project, account)` — pin ONE project to ONE account
  (**merges** — safe; empty account clears; unknown account rejected).
- `proxy_route(project, provider?, model?, allow_providers?, allow_models?, block?, clear?)`
  — set ONE project's routing rule (**merges** — safe). Pin rewrites; allowlist
  **refuses, never substitutes** (empty list = no restriction).
- `proxy_config(patch)` — **live-edit routing** (applies instantly, persists):
  `{forceModel:{enabled,provider,model}}`, `{modelRoutes:{"<model>":{provider,rewriteModel?}}}`,
  `{cloudPolicy:"open|allowlist|off", cloudAllowlist:[...]}`, `{defaultRoute:"…"}`,
  `{bases:{…}}`, secrets (`crazyrouterKey`/`adminPassword`).
  ⚠️ **REPLACES `projectRoutes`/`projectAccounts` wholesale** — one entry through
  it deletes every other project's rule/pin; use `proxy_pin`/`proxy_route` for
  single keys. It never touches `consumers` (API keys).
- `proxy_reset_config` — reset routing to env defaults (drops the account pool
  overlay — extreme care). `proxy_clear_calls` — wipe the Postgres call log.

### Common tasks

- "Which provider does model X use?" → `proxy_resolve(model=X)`.
- "Is the local model up?" → `proxy_health`.
- "Pin `gemini-2.5-pro` to crazyrouter" → `proxy_config({modelRoutes:{"gemini-2.5-pro":{provider:"crazyrouter"}}})`.
- "Route project Y to claudecode sonnet" → `proxy_route(project="y", provider="claudecode", model="claude-sonnet-4-6")`.
- "Bill project Y on account Z" → `proxy_pin(project="y", account="z")`.
- "Usage/cost this week" → `proxy_stats(window="7d")`.

**Not over HTTP:** local model load/unload and the router container restart are
host-level ops — SSH for those. This router can only *list* local models and
route to whatever is loaded.

---

## The `cccc` TUI

`cccc` (`tui/claudectl_tui.py`) — live curses dashboard: colour-coded per-account
5h/7d usage + reset countdown (the router's harvested readings), `★` = the
account this box is pinned to.

Tabs: Accounts · Windows · Plugins · Setup (`←→` switch). Keys: `↑↓` move ·
`enter` dispatch (on an account: pin THIS box to it on the router — live, no
restart; "⚡ LIVE limit check" = 1-token probe per account) · `q` quit.

Install: `git clone git@github.com:devdashco/llm-hostbun-router ~/.llm-hostbun-router && sh ~/.llm-hostbun-router/cccc/install.sh` (private repo → SSH clone).

Beyond accounts + router, the same `claudectl` MCP also steers terminals across boxes
(`terminals_*`) and manages plugins/marketplaces/MCP on this box
(`plugins_available`, `plugin_install`, `marketplace_*`, `mcp_*`, `reload_apply`).
