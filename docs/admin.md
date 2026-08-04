# Control panel

Password-gated SPA at the site **root**, `https://llm.hostbun.cc/`. There is no `/admin` page any
more; it 308s to `/`. Changes apply instantly, with no redeploy, and persist on the volume.

Five pages, named for the direction of the wire — callers come **in**, a rule picks **where**, an
upstream is billed **out**. Old slugs (`/identity`, `/settings`, `/stats`, `/accounts`, `/models`,
`/crazyrouter`, `/secrets`) still work; they redirect to the right page + tab.

| Page | Tabs | What it does |
|---|---|---|
| Overview | Health · Usage | Provider health, recent calls, activity; usage by project, model, provider |
| Call log | — | Every request with its full prompt and reply, searchable |
| Routing | Rules · Models | Per-project pins and allowlists, usage limits, resolve tracer; merged catalog + one-shot test call |
| Callers | Callers · Secrets | **Inbound.** The registry (who calls, what it costs, who holds a key, and which clients present it); the auth gate, the local model gate, the panel password |
| Upstreams | Accounts · Crazyrouter · Image templates | **Outbound.** Per-account 5h/7d usage windows, project pins, live limit refresh; crazyrouter key status/credit and rotation; the reference-picture templates rendered on crazyrouter |

Renamed 2026-07-26. "Identity" used to hold the outbound Claude Max account pool and "Settings"
opened on a provider's API key, so neither name told you what was on the page. Renamed again
2026-07-27 to **Callers** and **Upstreams**: in a list, "Consumers" and "Providers" are nine-letter
latinate twins ending in -ers and neither says which way the wire points. The URLs did not change —
`/consumers/` and `/providers/` are still the slugs, and the page bodies still say consumer and
provider, because those are the registry entity and the call-log column.

Secrets are masked everywhere. The API never returns a key hash, a Max token, or a password.

## The JSON API

The panel uses the same API you can: `POST /api/login`, then `/api/{state, config, health,
models, resolve, test, calls, stats, series, limits, consumers, routes, pins, accounts,
claudecode/limits}`. `/api/*` is an alias for the same handler. The `claudectl` plugin drives exactly
these.

### Three endpoints merge, on purpose

`POST /api/config` assigns its fields **wholesale**. A save built from a stale render would
delete every sibling. So these exist, and they merge:

| Endpoint | Body | Effect |
|---|---|---|
| `POST /api/pins` | `{project, account}` | One project → one Max account. Rejects an unknown account. |
| `POST /api/routes` | `{project, provider?, model?, allowProviders?, allowModels?, block?, clear?}` | One project's rule. Rejects an unknown provider and an empty rule. |
| `POST /api/consumers` | `{name, kind, owner?}` | One registry entry |
| `POST /api/consumers/keys` | `{name, kind?, owner?}` | Issue a key. Creates the consumer if absent. |
| `POST /api/apps` | `{name, tier?, note?, models?, pin?, account?, allowUa?}` | A whole application in one call: key **and** routing rule. |

### One call for a new app

`POST /api/apps` exists because the rule is the half that gets forgotten — a consumer with no rule
is *unrestricted*, which includes the premium (opus/fable) models on the shared Max pool. Its
allowlist is a **tier resolved against the live model catalogs**, so a new app never needs a
hand-copied model list that goes stale:

| `tier` | Allowed |
|---|---|
| `standard` (default) | every advertised id **except** the premium claudecode ones |
| `frontier` | the above **plus** opus/fable — warns the operator |
| `local` | the free on-prem GPU only |
| `any` | no allowlist at all — also warns |

`models: [...]` overrides the tier. The reply carries the key **once**, the rule it wrote, and
`premium: true` when the app can reach opus.

### Reading usage limits honestly

Every account is a **Claude Max subscription**. Its 5h and 7d **usage windows** come from Anthropic's
`anthropic-ratelimit-unified-*` response headers.

`GET /api/limits` reports the utilisation **harvested for free** from real traffic. That harvest only
learns from calls the account actually serves, so an **idle** account (or one Anthropic just
**refunded** or reset) keeps reporting its last reading until it serves again. Treat it as a floor:
`limits: null` means "no reading", not `0%`.

`POST /api/claudecode/limits {account}` (or `{all: true}`) is the **on-demand live read**: it pings
each subscription **once** (one `claude-haiku-4-5` call, `max_tokens:1`) purely to pull the current
window headers, then updates the row. The Accounts tab's **"↻ Refresh limits (live)"** button and the
per-row **↻** run exactly this. It returns, per account:

- `reading` — `{u5, u7, reset5, reset7, s5, s7, unified}`. `u5`/`u7` are 0–1 utilisation; `reset5`/`reset7`
  are unix seconds (the panel shows the **reset clock/date**). `null` when the account sent no headers.
- `status` / `errType` / `errMsg` — why there is no reading. The two cases are **not** the same:
  - **429** — the window is spent. It **resets** at `reset5`/`reset7`; nothing is wrong with the login.
  - **403 `permission_error`** (`"OAuth authentication is currently not allowed for this organization"`)
    — the **login itself is disabled** (e.g. the subscription was cancelled or refunded). No reset fixes
    it; the account is dead until re-enabled. The panel shows this as **✕ OAuth disabled**, in red.

> This is **not** a per-model probe. An earlier "Serves X/13" probe pinged every model id and read a
> 429 as "this account can't serve this model" — but these are subscriptions, so a 429 is a usage
> window, not a capability. Every account can serve every model when its window has headroom. That
> probe (and its `dry`/`hot`/`thin` verdict) was removed on 2026-07-11; the honest signal is the usage
> window + reset time above.

`GET /api/accounts` returns one row per account: `limits` (the harvested window, live-refreshable),
`projects` (who is pinned to it), `usage` (all-time + 24h call/token counts), and `org`. `orphanPins`
lists any pin naming an account no longer in the pool.
