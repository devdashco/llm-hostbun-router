# llm-hostbun-router

Node router (zero deps) behind `https://llm.hostbun.cc`. **The only middleman between any of our
code and a model.** One OpenAI-compatible base URL — `/v1` — picks the provider from the model id.
Deployed on hostbun Coolify from `devdashco/llm-hostbun-router`, branch `master`.

Renamed from `llm-hostbun-proxy` (2026-07-09). The Coolify app already points at the new name; old
refs may still linger in sibling repos.

## Layout

- `server.js` — the HTTP layer and nothing else (~340 lines). Path table, boot, process guards.
- `src/` — the router proper. No cycles; each module is a leaf or near-leaf.
  | file | owns |
  |---|---|
  | `config.js` | live `CFG`, env + `/data/config.json`, sanitizers, key index |
  | `identity.js` | consumer/job paths, API keys, `authenticate()` |
  | `routing.js` | pins, allowlists, groups, usage limits, account pinning |
  | `http.js` | `readBody`, `buildHeaders`, `proxy()`, JSON enforcement |
  | `db.js` | Postgres call log + harvested account headroom |
  | `claudecode.js` | Anthropic catalog, per-account probes |
  | `admin.js` | the control-plane API behind the password cookie |
  | `telemetry.js` | call-log row shaping, HyperDX error shipping |
  | `pricing.js` | USD estimates (crazyrouter only) |
- **`CFG` is mutated in place, never reassigned** (`setCFG()`). Every module holds the same reference;
  `CFG = merged` left the router reading a detached copy — the panel saved and changed nothing.
- `translate.js` — OpenAI ↔ Anthropic translation. Pure, unit-tested.
- `admin/` — password-gated SPA (Preact + htm, vendored inline, no CDN). pw `ddash`. Served at the
  site **root** `/`. **There is no `/admin` anything** — the prefix was deleted on 2026-07-10 and
  `/admin*` is a tombstone 404. The JSON control plane is `/api/*`. claudectl, the statusline and the
  `cccc` TUI were repointed first (claudectl `ba3a6bf`). Two carve-outs are load-bearing: `/api/v1/*`
  is real inference (`base_url=…/api`) and `/api/pricing` is public — routing either into the
  cookie-gated handler 401s callers that never had a cookie.

- `docs/` — **docsify** site: `index.html` shell + markdown pages + `_sidebar.md`, docsify vendored in
  `docs/vendor/` (no CDN, `noEmoji: true` because emoji shortcodes fetch images from githubassets).
  Served at `docs.llm.hostbun.cc/*` **and** `llm.hostbun.cc/docs/*` from the same files, so asset
  paths are relative and **`/docs` 301s to `/docs/`** — without that, `vendor/docsify.js` resolves to
  `/vendor/docsify.js` and the page renders `loading…` forever. It is **public and unauthenticated**:
  `test/docs.test.mjs` fails the build if a password, `sk-ant-oat…`, `sk-llm-…` or a `DATABASE_URL`
  ever lands in it.

## Tests — `npm test` (86 checks, ~25s)

Four suites, no network, no database. Run before every push.

- `translate.test.js` — the seven translation traps.
- `test/router.test.mjs` — boots a real server on an OS-assigned port: pins, allowlists, job
  inheritance, the image-model refusal, merge-vs-replace endpoints, the auth gate. Written as an
  old-vs-new parity harness during the `src/` split and kept.
- `test/ui.test.mjs` — loads the real shell + vendor bundle + module graph in jsdom, logs in, and
  mounts **every** nav page. Nothing else type-checks or bundles the panel, so a wrong import name is
  otherwise a blank page in prod. jsdom is a devDependency; the image builds `npm ci --omit=dev`.
  jsdom does not run `<script type="module">`, hence the hand-built environment in that file.
- `test/docs.test.mjs` — the docs actually render (docsify fetches its markdown at runtime, so a bad
  `basePath` is a permanent `loading…`), every sidebar link resolves, and no secret is published.
  Traversal is tested over a raw socket: `fetch()` strips `..` before the request leaves the process,
  so a traversal test written with `fetch` asserts nothing.
- `docs/` — static docs, served at `docs.llm.hostbun.cc`.
- `headroom-svc/` — optional Python compression sidecar. Separate Coolify app, **same repo**
  (base dir `headroom-svc`). OFF unless `HEADROOM_URL` is set. **Never** applied to `claudecode` —
  it rewrites the prompt and would miss the prompt cache, costing more than it saves.

## Providers

Three. That is the whole taxonomy. (`lane` is the old word for the same thing; a few internals
still spell it that way.)

| provider | upstream | speaks | cost |
|---|---|---|---|
| `local` | llama.cpp on the pbox GPU (`bases.local`, currently `pbox.llm.hostbun.cc`, model `qwen3.5-9b`) | OpenAI | free |
| `claudecode` | the **claudecode-account-pool** (our Claude Max logins) → `api.anthropic.com` | Anthropic | flat (subscription) |
| `crazyrouter` | `crazyrouter.com` cloud relay (gemini etc), key injected | OpenAI | **per token** |

Legacy ids still migrate on read: `cloud`→`crazyrouter`; `claude`/`anthropic`/`wrappy`→`claudecode`.
The old subprocess wrapper is **deleted** — the router now calls the real Anthropic API with a pinned
account's `sk-ant-oat…` token. Don't reintroduce the old name; the only place it survives is the
`LEGACY_PROVIDER` key map, which must keep it so pre-rename `config.json` files still load.

The field is `provider` everywhere. `lane` was the old word and is **still read** on input
(`providerOf()` accepts `{lane}` or `{provider}`), because `/data/config.json` on the volume predates
the rename. Old call-log rows carry `provider='anthropic'`; new ones carry `'claudecode'` — queries
and the retention prune must match **both**.

Routing lives in a mutable `CFG` seeded from env, overlaid with `/data/config.json` on a persistent
volume, editable live from the panel at `/`. Changes apply without a redeploy.

### Per-project rules — pin vs allowlist

`projectRoutes[<consumer>]` (and each `projectGroups[]` entry) carries **two independent axes**, and
they are not the same thing:

| field | what it does | on mismatch |
|---|---|---|
| `provider` + `model` | the **pin** — rewrites the request | n/a |
| `allowProviders` / `allowModels` | the **allowlist** — restricts where it may resolve | `400 blocked`, never a substitution |

A rule may carry either, both, or neither (neither = the entry is dropped). An empty or absent list
means *no restriction*, never "nothing allowed" — the opposite makes a mistyped save an outage.
The allowlist **refuses, never rewrites**: silently serving an allowed model instead is exactly the
cross-provider substitution invariant 2 forbids.

**A rule is resolved like `accountFor()`: exact path → consumer → group.** So a rule on `promopilot`
covers `promopilot:generatetext`. Before 2026-07-09 `projectRoutes` matched the literal string only,
so every job path silently ignored its own project's pin and fell through to the group (or to
crazyrouter, per token). Pinned model ids are **not** validated against the catalog — Anthropic ships
ids without asking; that is `claudecodeModels`' job, not this one.

Edit **one** rule with `POST /admin/api/routes {project, …}` — it merges. `POST config` assigns
`projectRoutes` wholesale and a save built from a stale render deletes every other project's rule
(same hazard as `pins`, same door).

**None of this lives in Postgres.** Postgres holds the *call log* and nothing else. Every rule, pin,
consumer, key hash and account token is a key in `/data/config.json` on the app's volume.

## Invariants — do not "improve" these away

These are load-bearing decisions, not oversights. Each one was a bug once.

1. **One project → one account. No rotation, ever.** `accountFor(project)` reads
   `projectAccounts[project] || defaultAccount`. No header can override it. Rotating accounts blows
   the per-org prompt cache (~12× cost) and makes "who spent this?" unanswerable after the fact.
2. **No fallback. Anywhere.** A 429 means the pinned account is out of quota → the caller is told.
   A 5xx means upstream failed → the caller is told. Answering anyway with a different model on a
   different provider (the old wrapper→crazyrouter path) hid both the cost and the truth.
3. **An unpinned project gets `403 no_account_for_project`**, and the error body lists the projects
   that *are* pinned. Never bill a guess.
4. **`claudecode` request headers are synthesized, never inherited.** A Max setup-token is rejected
   without `anthropic-beta: oauth-2025-04-20` + `anthropic-version` + a `claude-cli` UA. Trusting the
   caller to send them is why only real Claude Code ever worked on that path.
5. **Native `/v1/messages` is forwarded byte-for-byte.** Only OpenAI `/v1/chat/completions` on the
   `claudecode` provider is translated. Touching a native body loses tool/thinking fidelity and
   breaks Claude Code's prompt cache.
6. **Model ids are config, never code** (`claudecodeModels`). Anthropic ships new ids without asking.

## Identity — developers, machines, projects

**Three entities, and the rules are enforced by Postgres, not by application code.**

| entity | what it is | has an owner? |
|---|---|---|
| `developer` | a person — `philip`, `william` | — |
| `machine` | a person's box, or a daemon on it — `pmac`, `wmac`, `pbox`, `lprod` | **yes**, a developer |
| `project` | code we deployed — `promopilot`, `redbut` | **no** — an app is not a person |

Machines and projects share ONE table, `consumers`, with one UNIQUE name: both are *callers*, both
appear on the wire as `<name>[:<job>]`, both can hold a key. Two tables would be two namespaces and
`pmac` could exist as both. `kind` distinguishes them; a CHECK constraint enforces "a project has no
owner"; `developer_id` is `ON DELETE RESTRICT`. Verified by inserting directly, bypassing the API.

**`src/registry.js` is the ONLY writer.** The DB is the source of truth; `refresh()` projects it into
`CFG` (what requests read) and mirrors it to `/data/config.json` (so a cold boot with the DB down
still authenticates). `authenticate()` never touches Postgres.

**A registry write with no DB refuses with 503.** It used to write `CFG` — the legacy
`POST /api/consumers/keys` issued a key that authenticated until the next registry write and then
silently vanished (reproduced 2026-07-10, fixed in `c385a5e`). Pure validation still answers without a
DB, so a caller's error is about their request, not our infrastructure.

**Keys live in keyvault** at `llm/<consumer>/API_KEY`, one per consumer, issued 2026-07-10.

## Identity — the wire format

**A consumer is WHO calls.** Exactly two kinds, and they are not the same thing:

| kind | what it is | has an owner? |
|---|---|---|
| `dev` | a person's machine, or a daemon on it (`pmac-claude`, `lprod-autofix`) | **yes** — a human |
| `app` | code we deployed (`promopilot`, `redbut`) | **no** — an app is not a person |

Giving an app an owner is how "what do my developers cost" quietly starts including cron jobs.
`POST` an owner for an app and you get a 400, not a silent drop.

**Identity is a path: `<consumer>[:<job>]`.** `promopilot:generatetext` is consumer `promopilot`,
job `generatetext`. This convention already existed in the data; nothing parsed it, so `promopilot`
read as *4 calls* while its three workloads had ~30k between them. Split on the **first** colon only.

**Only the consumer is registered. Jobs are free.** A new workload needs no config change — that is
the property that keeps this sustainable. `accountFor()` resolves an exact-path pin first, then the
consumer's pin, so pinning `promopilot` covers every job while one greedy job can still be split out.

**Issuing a key IS registering.** One call, `POST /admin/api/consumers/keys {name,kind,owner?}`,
creates the consumer if absent and returns the only copy of the secret. Two steps — register a name,
then separately authenticate — is precisely what let a self-asserted header masquerade as identity.

Wire format `sk-llm-<id>-<secret>`. `id` is public (an 8-char handle, so lookup is a map hit, not a
scan over every hash); `secret` is never stored, only its sha256. The consumer name is deliberately
**not** in the key: it would leak who we are, and a name containing `-` (`pmac-claude`) makes the key
unparseable. Accepted as `Authorization: Bearer` (OpenAI clients) **or** `x-api-key` (Anthropic SDK on
native `/v1/messages`). The caller's inbound `authorization` was always discarded by `buildHeaders()`,
so the field was free.

**A valid key outranks anything the caller says about itself.** The consumer comes from the key; only
the *job* half of `X-Project` (or an `X-Job` header) is still taken on trust — a job is a label inside
an already-authenticated consumer, so it cannot bill someone else. Verified: a request bearing acme's
key and `X-Project: victim` logs as `acme`.

### Two gates, and what each one is for

- **`auth.mode`** (`off` | `optional` | `required`) — the lock.
  `optional` is migration mode: a valid key wins, no key falls back to the header, and a key that is
  *presented and bad* is always a 401 (otherwise a revoked key silently keeps working under its old
  name). `required` is the only mode that closes the hole. **Ships `optional`.**
- **`requireRegisteredConsumer`** — a spelling check, not a lock. Only applies to calls with no key;
  refuses an unknown consumer with `403 unknown_consumer` so a typo can't become a new consumer with
  its own bill. Redundant once auth is `required`. **Ships off**; currently **on** in prod.

Both are flipped through their own logged endpoints (`POST /admin/api/auth`,
`POST /admin/api/consumers/enforce`), never through `POST config`, because turning either one on with
an unseeded registry is an instant outage. The panel refuses to do it blind: it names the consumers
that would start failing (`keyless` in the `consumers` payload).

### Gotchas

- **`POST /admin/api/config` does not touch `consumers`** — deliberately. It assigns its fields
  wholesale, and a panel save built from a payload with no hashes would wipe every key.
- **`adminState` redacts.** The registry entry carries key hashes; `/admin/api/state` and
  `/admin/api/consumers` return `activeKeys` and the public `id`, never `hash`.
- **`reindexKeys()` is called from `persistConfig()`**, so no writer has to remember to, and a stale
  index can never authenticate a revoked key. `KEY_INDEX` is declared near the top of the file, far
  from its own functions, because `loadConfig()` reindexes at module scope — a `let` beside
  `authenticate()` is still in its temporal dead zone when that call runs, and the process dies on boot.
- **`lastUsed` is approximate.** Persisting it inline would mean a disk write per inference, so it is
  flushed on a 5-minute timer. Never treat it as an audit trail.

## Translation

`translate.js` — pure functions, no I/O, so it is unit-testable in isolation. It handles seven traps
that each silently corrupt output if skipped: Anthropic *requires* `max_tokens`; there is no system
turn (hoist it); OpenAI emits one `tool` message per result but Anthropic wants them batched into a
single user turn; `input_json_delta` streams partial JSON (forward verbatim, never parse mid-stream);
`thinking_delta` must not leak into OpenAI `content`; a tool-only turn still needs
`finish_reason: "tool_calls"`; cache tokens have no OpenAI home but cost accounting needs them.

Run `node translate.test.js` before touching it. 14 tests, no deps.

## Deploy

Pushing does **not** reliably auto-build — the app's `watch_paths` lists `server.js`, `Dockerfile`,
`entrypoint.sh`, `gen-prices.sh`, `README.md`, `admin/**`, `docs/**`, and **not `translate.js`**, so a
push that only touches the translator is silently ignored. Trigger the Coolify deploy for app uuid
`d11s05nc130l2kjzr6anpebr` (token in keyvault), then **verify — never stop at `git push`**: wait for
`running:healthy`, read the boot line in the logs (`llm-gateway on :80 | providers: …`), then curl a
real request. The headroom sidecar is app `i7pfies89s3maf390ye3rllk`. Both live in Coolify project
`llm-hostbun-router`, alongside the `llm-proxy-archive` service (uuid `ysjpmznhdq1auwk9f3lqv8hk`).
**That archive service is now orphaned** — `ops/nas-shipper/`, the only thing that fed it, was deleted
(2026-07-09). Stop or delete the service; `GET /admin/api/export` is left in place but has no caller.

`Dockerfile` copies files individually. **If you add a new `require`d file, add a `COPY` line** or
the container crash-loops on boot.

## Storage

Two very different things, and only one of them is a database.

**The call log AND the identity registry live in Postgres** — database `llmrouter`, a Coolify
standalone-postgres (`postgres:17-alpine`, uuid `b8ubtmws8mnt8viw9mg0syz2`) **inside the
`llm-hostbun-router` project on hostbun**, reached over the internal `coolify` docker network.
Moved off pbox on 2026-07-10 (it was `80.217.106.60:5435`, `sslmode=disable`, cleartext over the
public internet). DSN in keyvault at `db/llmrouter/DATABASE_URL`. Tables `calls` and `acct_limits`, created by
migration `0001_calls_and_acct_limits`, plus `acct_probes` (last probe per account, created by an
idempotent `CREATE TABLE IF NOT EXISTS` in `initDb`). It used to be a SQLite file on the app's volume; that file is
gone. `pg` is the router's only runtime dependency, so the Dockerfile now runs `npm ci` — if you add a
dependency, the lockfile must be committed or the build fails.

**The config still lives on the volume** — `/data/config.json`. That is where the account tokens are.

## Gotchas that will cost you a day

- **The account tokens exist in exactly one place**: `anthropicPool` / `claudecodeAccountPool` inside
  `/data/config.json` on the app's volume. Not in env, not in git, no backup. Lose the volume, lose
  the subscriptions. Back it up before touching the app, the server, or the volume.
- **The Postgres link no longer crosses the internet.** It used to: the DB was on pbox, the router on
  hostbun, `sslmode=disable`, so every prompt, every reply and the DB password went out in cleartext.
  Since 2026-07-10 the DB is a Coolify resource in the same project, on the same box, reachable only on
  the internal `coolify` network. **Do not point `DATABASE_URL` back at a remote host without TLS.**
- **`pg` returns BIGINT as a string.** Every `ts`, `id` and `SUM()` in this schema is a bigint. Left
  unparsed they break timestamp arithmetic and the shapes the admin UI expects. `server.js` installs
  type parsers for oid 20 (int8) and 1700 (numeric) at boot; don't remove them.
- **Postgres is stricter than SQLite was.** `GROUP_CONCAT` → `string_agg`; a bare column may not ride
  along outside `GROUP BY` (hence `MAX(provider)` in `byModel`); `json_extract` does not exist, and
  casting `user_id::jsonb` throws on the rows where it isn't JSON — the conversations view extracts
  `session_id` with a regex for exactly that reason.
- **Writes are fire-and-forget.** `recordCall` never awaits, and a failed INSERT logs a warning and is
  dropped. That is deliberate: the DB is a network hop away, and losing a log line must never fail an
  inference request. It does mean the log can silently under-count if the DB is down — watch for
  `[log] write failed`.
- **Importing rows with explicit `id` does NOT advance a `BIGSERIAL` sequence.** After the SQLite
  import the sequence still read `13`, so the first new rows got ids `1..13` — invisible in the admin
  list (it orders by `id DESC`) and on a collision course with the imported range. Any future bulk
  import must end with `SELECT setval('calls_id_seq', (SELECT MAX(id) FROM calls))`.
- **The old SQLite file still exists**, frozen, at
  `/var/lib/docker/volumes/d11s05nc130l2kjzr6anpebr-config-data/_data/calls.db` on hostbun (64,208
  rows). It is the only backup of the pre-cutover log. Read it with
  `docker exec <container> node -e '…require("node:sqlite")…'` — the host has no `sqlite3`.
- **Auth is staged, and until `auth.mode = "required"` the inference endpoints are still open.**
  Anyone who can reach `llm.hostbun.cc` and names a registered consumer can spend the Max
  subscriptions. `X-Project` is **attribution, not authentication** — a self-asserted string, and
  `extractProject()` also accepts the OpenAI `user` field. An API key is what makes the name mean
  something. See "Identity" below.
- **`local` is a reasoning model.** `qwen3.5-9b` returns its thinking in `reasoning_content` and
  leaves `content` empty until it finishes. With a normal token budget it never finishes → callers get
  `''` and `finish_reason: length`, having paid for every token. The router now defaults it off
  (`applyLocalThinkingDefault()`). The knob is **`chat_template_kwargs: {enable_thinking: false}`** —
  a **top-level `enable_thinking` is accepted by llama.cpp and silently ignored**, which is why the
  obvious fix appears to do nothing. The router hoists the top-level form into `chat_template_kwargs`
  so a caller that asks for thinking still gets it.
- **`defaultAccount` quietly voids the "never bill a guess" invariant.** `accountFor()` is
  `pins[project] || defaultAccount`, so an unpinned *or misspelled* project bills the default instead
  of 403'ing. The 403 works today only because `defaultAccount` is empty in prod. Leave it empty.
- **Anthropic serves ids it does not list.** `/v1/models` shows dated ids for the 4.5 family and
  undated ids for 4.6+. The undated 4.5 forms (`claude-haiku-4-5`, `claude-sonnet-4-5`,
  `claude-opus-4-5`) are served but unlisted — and `claude-haiku-4-5` is what every caller sends.
  They live in `CLAUDECODE_MODEL_ALIASES`. **Do not derive them by stripping the date**:
  `claude-opus-4-1` 404s while `claude-opus-4-1-20250805` serves, and `claude-opus-4-8-20260528`
  404s while undated `claude-opus-4-8` serves. Verify each with `claudecode/probe` — a **404 means
  the id does not exist**; a **429 means it exists and the subscription is dry**.
- **Everything before 4.5 is 404 on a Max OAuth token** (`claude-3-*`, `claude-3-5-*`, `opus-4`,
  `sonnet-4`). Not missing from our catalog — not ours to call. Don't go looking for them.
- **`claudecodeModels` is no longer hand-typed.** `CLAUDECODE_MODEL_SEED` in `server.js` is a floor;
  `refreshClaudecodeModels()` reconciles it against `api.anthropic.com/v1/models` at boot and every 6h,
  and the config load *unions* rather than overwrites. **The catalog is per-account** — `philip` lists
  `claude-opus-4-1`, `cmejl3` 404s it — so an advertised id can still be absent on the pinned account.
- **A 429 from Anthropic carries no `anthropic-ratelimit-*` headers.** The headroom harvest therefore
  learns nothing from an exhausted account and keeps reporting its last good reading — usually `0% ·
  allowed`, harvested off a cheap model that still answers. `/admin/api/limits` is a floor, not a
  verdict. `POST /admin/api/claudecode/probe {account}` pings every advertised model and is the only
  honest source; `{all:true}` sweeps the pool and the panel's Accounts tab has a button for it.
  As of 2026-07-09 the pool is nearly dry: **`william`, `kontaktemhpx` and `cmejl3` serve only
  `claude-haiku-4-5`; `philip`, `emphyx`, `claudemejlto` and `claude2mejlto` serve nothing at all.**
  Probe results now persist in `acct_probes` and are primed at boot (2026-07-10) — they lived in a
  `Map`, so every deploy reset the pool to "not probed" and blanked the only honest column. A probe
  also learns the org-id off the response headers, which fills in "org unknown" for an account that
  has never served a call. `GET /admin/api/accounts` returns a server-computed `health` per account
  (`dry` > `hot` > `unknown` > `ok`) plus a `summary`; Overview and Accounts both render that one
  verdict, so they cannot disagree. **`unknown` is not `ok`** — an unprobed account's bars are a floor.
  `summary.strandedProjects` lists projects pinned to a dry account: an outage they have not hit yet.
- **`acct_limits` is keyed by Anthropic org-id, which says nothing about which login it is.** The
  `account` column (added 2026-07-09 by an idempotent `ALTER` in `initDb`) fixes that, but it is only
  stamped by live traffic. A cold-started router learns org→account from the
  `anthropic-organization-id` header on the `fetchAccountModels()` catalog sweep — the one request it
  makes for an account with no traffic. Break that and every account reports `limits: null` until it
  happens to serve a call. **`limits: null` is "no reading", not `0%`** — never render them alike.
- **Per-account spend must join on the name after the colon in `key_label`.** Pre-rename rows say
  `anthropic:philip` / `wrappy:philip`, current ones say `claudecode:philip`. `GET /admin/api/accounts`
  uses `split_part(key_label,':',2)` for exactly this reason.
- **`POST /admin/api/config` REPLACES `projectAccounts`.** Sending one pin deletes the rest. Use
  `POST /admin/api/pins {project,account}` — it merges, and rejects an unknown account name. Same for
  `projectRoutes` → `POST /admin/api/routes {project,…}`.
- **Renaming a field renames it in SQL too.** The `lane`→`provider` rename needed an
  `ALTER TABLE calls ADD COLUMN provider` + backfill from `lane`; without it `CREATE TABLE IF NOT
  EXISTS` no-ops on the existing prod table, the provider index throws, `initDb()` catches, and
  **call logging silently turns itself off while boot still looks clean**.

## Open work

~~2. Accounts + project-pin admin API and UI panel.~~ **Done 2026-07-09** — `POST /admin/api/pins`
   plus a pin editor in the panel. `promopilot` is pinned and serving.

~~1. Per-project API keys.~~ **Built 2026-07-09** — `sk-llm-<id>-<secret>`, sha256 at rest, issued by
   `POST /admin/api/consumers/keys`. **Not yet closed**: `auth.mode` is `optional` until every caller
   holds a key. Migration = issue a key per consumer → store in keyvault → update the caller → flip
   `auth.mode` to `required`. The panel lists who still has no key.

2. **Accounts + project-pin admin API and UI panel.** Unblocks pinning `promopilot`, and unblocks
   `claudectl`'s account tools (below).
3. ~~**`local` thinking default.**~~ **Done 2026-07-09** — `applyLocalThinkingDefault()`.
4. **Consumption views** — per project / group / account / model, from the existing `calls` table.

## Connection to `devdashco/claudectl`

`claudectl` (local clone: `~/Documents/GitHub/claudectl`) is the **control plane** for this router.
It ships a Claude Code plugin (MCP tools + skills), the `cccc` terminal dashboard, and is deployed as
the `mcp-claudectl` Coolify app at `claudectl.hostbun.cc`.

Its `proxy_*` MCP tools drive this repo over the admin API — they log in at `POST /admin/api/login`
(password `ADMIN_PASSWORD`) and then hit `/admin/api/<sub>`:

| Tool | What it reads/writes here |
|------|---------------------------|
| `proxy_state`, `proxy_config`, `proxy_reset_config` | the live `CFG` (providers, overrides, forceModel) |
| `proxy_health`, `proxy_models`, `proxy_resolve`, `proxy_test` | provider health, merged catalog, route a model id |
| `proxy_stats`, `proxy_calls`, `proxy_clear_calls` | the Postgres call log + per-project usage |
| `proxy_limits` | live 5h/7d headroom per account, harvested free from response headers |

Consequences worth remembering:

- **Config changes via `proxy_config` are the same writes as the `/admin` UI.** They land in
  `/data/config.json` and survive restarts. Don't hand-edit the volume.
- **The account pool is shared.** The `accounts_*` tools and this router's `claudecodeAccountPool`
  describe the same Claude Max logins. Exhausting a 5h window in one shows up in the other.
- **`claudectl` is currently broken against this router.** Its `accounts_*` / `live_limits` /
  `window_status` tools call `/v1/accounts/*` — an API the **old wrapper had and this router does
  not**. Its `server/_e2e_probe.py` also still probes `claude.hostbun.cc`, which is dead, so
  **every `claudectl` deploy fails** until it is repointed. Fixing that needs open-work item 2.
- If you change an admin API route, a provider id, or the `CFG` shape, **check
  `claudectl/server/claudectl_server.py`** — it hardcodes these paths and will break silently.
