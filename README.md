# llm-hostbun-proxy

Single-URL OpenAI-compatible LLM router behind `llm.hostbun.cc` (Node, zero deps beyond
built-ins; deployed on hostbun Coolify). One base URL — `https://llm.hostbun.cc/v1` — picks
the provider by **model name**.

## Three providers (lanes)

| Lane | Select with `model` | Upstream |
|------|---------------------|----------|
| **local** | `local` / `gemma` / `obliterated` | LM Studio @ `llm.bofrid.dev` (no key; `obliterated` optionally Bearer-gated) |
| **crazyrouter** | any other id (e.g. `gemini-2.5-pro`) | `crazyrouter.com` cloud relay (`CRAZYROUTER_KEY` injected server-side) |
| **wrappy** | `claude*` (e.g. `claude-sonnet-4-6`) | claudebox / claude-code shim @ `claude.hostbun.cc` (`wrappyToken` injected) |

`GET /v1/models` returns the merged catalog (local + wrappy + crazyrouter).

## Live config

Routing is driven by a mutable `CFG` seeded from env and overlaid with `/data/config.json`
(persistent volume). Edit everything live from the password-gated **`/admin`** UI — force a
model globally, override any incoming model to any lane, set a crazyrouter policy
(open / allowlist / off), default route, JSON enforcement, swap keys, view the SQLite call
log + usage stats. Changes apply instantly (no redeploy) and survive restarts.

Lane ids are `local`, `crazyrouter`, `wrappy`. Legacy ids `cloud` (=crazyrouter) and
`claude` (=wrappy) are still accepted and migrated, so old `config.json` files keep working.

## Env

- `CRAZYROUTER_KEY` — crazyrouter cloud key (required; never committed)
- `WRAPPY_TOKEN` (or legacy `CLAUDE_TOKEN`) — wrappy/claudebox bearer (default `ddash`)
- `WRAPPY_BASE` (or `CLAUDE_BASE`) — default `https://claude.hostbun.cc`
- `CRAZYROUTER_BASE` (or `CRAZY_BASE`) — default `https://crazyrouter.com`
- `LOCAL_BASE` — default `https://llm.bofrid.dev`
- `OBLIT_TOKEN` — gate for the abliterated local model (empty = open)
- `ADMIN_PASSWORD` — admin UI password (default `ddash`, rotate via UI)

Full API docs: `https://docs.llm.hostbun.cc`.
