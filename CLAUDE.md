# llm-hostbun-router

Node router (zero deps) behind `https://llm.hostbun.cc`. **The only middleman between any of our
code and a model.** One OpenAI-compatible base URL — `/v1` — picks the provider from the model id.
Deployed on hostbun Coolify from `devdashco/llm-hostbun-router`, branch `master`.

Renamed from `llm-hostbun-proxy` (2026-07-09). The Coolify app already points at the new name; old
refs may still linger in sibling repos.

## Layout

- `server.js` — the whole router: routing, live `CFG`, admin API, SQLite call log.
- `translate.js` — OpenAI ↔ Anthropic translation. `translate.test.js` (`node translate.test.js`).
- `admin/` — password-gated SPA (Preact + htm, vendored inline, no CDN). pw `ddash`.
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
volume, editable live from `/admin`. Changes apply without a redeploy.

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

## Gotchas that will cost you a day

- **The account tokens exist in exactly one place**: `anthropicPool` / `claudecodeAccountPool` inside
  `/data/config.json` on the app's volume. Not in env, not in git, no backup. Lose the volume, lose
  the subscriptions. Back it up before touching the app, the server, or the volume.
- **There is no auth on the inference endpoints.** Anyone who can reach `llm.hostbun.cc` can spend the
  Max subscriptions. Only `/admin` is gated. This is the largest open risk. Note that `X-Project` is
  **attribution, not authentication** — it is a self-asserted string, and `extractProject()` also
  accepts the OpenAI `user` field, so any caller can name any project.
- **`local` is a reasoning model.** `qwen3.5-9b` returns its thinking in `reasoning_content` and
  leaves `content` empty until it finishes. With a normal token budget it never finishes → callers get
  `''` and `finish_reason: length`, having paid for every token. `enable_thinking: false` fixes it.
- **`defaultAccount` quietly voids the "never bill a guess" invariant.** `accountFor()` is
  `pins[project] || defaultAccount`, so an unpinned *or misspelled* project bills the default instead
  of 403'ing. The 403 works today only because `defaultAccount` is empty in prod. Leave it empty.
- **The admin UI has no accounts or project-pin panel.** You cannot pin a project from `/admin` today,
  which is why `promopilot` is stuck at 403.
- **Renaming a field renames it in SQL too.** The `lane`→`provider` rename needed an
  `ALTER TABLE calls ADD COLUMN provider` + backfill from `lane`; without it `CREATE TABLE IF NOT
  EXISTS` no-ops on the existing prod table, the provider index throws, `initDb()` catches, and
  **call logging silently turns itself off while boot still looks clean**.

## Open work

1. **Per-project API keys.** `Authorization: Bearer sk-llm-<project>-…` becomes the identity *and*
   the lock, in the one field every OpenAI client already sends. Closes the auth hole and removes the
   `X-Project` header entirely. Store a sha256 hash; plaintext lives in keyvault.
2. **Accounts + project-pin admin API and UI panel.** Unblocks pinning `promopilot`, and unblocks
   `claudectl`'s account tools (below).
3. **`local` thinking default** — send `enable_thinking:false` for the `local` provider unless the
   caller asks otherwise.
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
| `proxy_stats`, `proxy_calls`, `proxy_clear_calls` | the SQLite call log + per-project usage |
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
