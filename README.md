# llm-hostbun-router

Single-URL OpenAI-compatible LLM router behind `llm.hostbun.cc` (Node, zero deps beyond
built-ins; deployed on hostbun Coolify). One base URL — `https://llm.hostbun.cc/v1` — picks
the provider by **model name**. It is the only middleman between our code and a model.

## Three providers

| Provider | Select with `model` | Upstream | Cost |
|---|---|---|---|
| **local** | `local` / `qwen3.5-9b` | llama.cpp on the pbox GPU (`LOCAL_BASE`) | free |
| **claudecode** | `claude*` (e.g. `claude-sonnet-4-6`) | our Claude Max account pool → `api.anthropic.com` | flat (subscription) |
| **crazyrouter** | any other id (e.g. `gemini-2.5-pro`) | `crazyrouter.com` cloud relay (`CRAZYROUTER_KEY` injected server-side) | **per token** |

`GET /v1/models` returns the merged catalog (local + claudecode + crazyrouter).

Both request shapes are served: native Anthropic `POST /v1/messages` is forwarded byte-for-byte
(so Claude Code keeps full fidelity and its prompt cache), while OpenAI `POST /v1/chat/completions`
is translated to Anthropic and back — streaming and tool calls included.

**Accounts are pinned, never rotated.** Each project is bound to one Max account
(`projectAccounts`); an unpinned project is refused with `403 no_account_for_project` rather than
billed to a guess. There is no fallback: a 429 or a 5xx reaches the caller unchanged.

## Live config

Routing is driven by a mutable `CFG` seeded from env and overlaid with `/data/config.json`
(persistent volume). Edit everything live from the password-gated panel at the site **root `/`** (the old `/admin`
path 308s there) — force a
model globally, override any incoming model to any provider, set a crazyrouter policy
(open / allowlist / off), default route, JSON enforcement, swap keys, view the SQLite call
log + usage stats. Changes apply instantly (no redeploy) and survive restarts.

Provider ids are `local`, `crazyrouter`, `claudecode`. Legacy ids `cloud` (=crazyrouter) and
`claude` / `anthropic` / the retired wrapper's id (all = `claudecode`) are still accepted and
migrated, so old `config.json` files keep working.

## Env

- `CRAZYROUTER_KEY` — crazyrouter cloud key (required; never committed)
- `ANTHROPIC_BASE` — claudecode upstream, default `https://api.anthropic.com`
- `ANTHROPIC_POOL` — JSON seed for the account pool `[{name,org,token}]` (normally set in the panel)
- `CLAUDECODE_MODELS` — comma-separated ids to advertise for `claudecode`. Rarely needed: the router
  seeds a known-good list and self-heals from `api.anthropic.com/v1/models` at boot + every 6h.
- `DEFAULT_ACCOUNT` — account for projects with no pin. Empty (default) = refuse with 403
- `CRAZYROUTER_BASE` (or `CRAZY_BASE`) — default `https://crazyrouter.com`
- `LOCAL_BASE` — the pbox llama.cpp server
- `OBLIT_TOKEN` — gate for the abliterated local model (empty = open)
- `ADMIN_PASSWORD` — admin UI password (default `ddash`, rotate via UI)
- `JSON_ENFORCE` — validate/repair JSON when `response_format` is set (default `1`)
- `JSON_MAX_RETRIES` — re-prompt count when JSON is invalid (default `2`)
- `REQUIRE_PROJECT` — require an `X-Project` header on inference calls, else `400 project_required` (default `0`)

Apps should send an `X-Project: <slug>` header (or body `project` / `metadata.project` / `user`) so
usage is attributed per project — recorded on every call, filterable in the admin log/stats.

Full API docs: `https://docs.llm.hostbun.cc`.
