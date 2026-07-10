# Control panel

Password-gated SPA at the site **root**, `https://llm.hostbun.cc/`. There is no `/admin` page any
more; it 308s to `/`. Changes apply instantly, with no redeploy, and persist on the volume.

| Tab | What it does |
|---|---|
| Overview | Provider health, recent calls, activity by provider |
| Calls | Every request with its full prompt and reply, searchable |
| Consumers | The registry: who calls, what it costs, who holds a key |
| Stats | Usage by project, model, provider |
| Accounts | Per-account 5h/7d headroom, project pins, model probes |
| Routing | Per-project pins and allowlists, groups, usage limits, resolve tracer |
| Models & test | Merged catalog, one-shot test call |
| Crazyrouter | Key status, credit limit, usage |
| Secrets | Rotate the crazyrouter key, the local gate, the panel password |

Secrets are masked everywhere. The API never returns a key hash, a Max token, or a password.

## The JSON API

The panel uses the same API you can: `POST /api/login`, then `/api/{state, config, health,
models, resolve, test, calls, stats, series, limits, consumers, routes, pins, accounts}`. `/api/*` is
an alias for the same handler. The `claudectl` plugin drives exactly these.

### Three endpoints merge, on purpose

`POST /api/config` assigns its fields **wholesale**. A save built from a stale render would
delete every sibling. So these exist, and they merge:

| Endpoint | Body | Effect |
|---|---|---|
| `POST /api/pins` | `{project, account}` | One project → one Max account. Rejects an unknown account. |
| `POST /api/routes` | `{project, provider?, model?, allowProviders?, allowModels?, block?, clear?}` | One project's rule. Rejects an unknown provider and an empty rule. |
| `POST /api/consumers` | `{name, kind, owner?}` | One registry entry |
| `POST /api/consumers/keys` | `{name, kind?, owner?}` | Issue a key. Creates the consumer if absent. |

### Reading headroom honestly

`GET /api/limits` reports the 5h/7d utilisation harvested for free from Anthropic's response
headers. **A 429 from Anthropic carries no rate-limit headers**, so an exhausted account keeps
reporting its last good reading. `limits` is a floor, not a verdict, and `limits: null` means "no
reading", not `0%`.

`POST /api/claudecode/probe {account}` pings every advertised model on that account and is the
only honest source. `{all: true}` sweeps the pool. The Accounts tab has a button for it. A **404 means
the model id does not exist**; a **429 means it exists and the subscription is dry**.
