# Identity: developers, machines, projects, keys

> **An API key is required.** `auth.mode = required`. A request with no valid key gets `401`.
> Your key is in keyvault at `llm/<consumer>/API_KEY`. Jump to [Authenticating](#authenticating).

## A consumer is WHO calls

Three entities, and the rules are enforced by the database, not by application code.

| entity | what it is | has an owner? |
|---|---|---|
| `developer` | a person — `philip`, `william` | — |
| `machine` | a person's box, or a daemon on it — `pmac`, `wmac`, `pbox`, `lprod` | **yes**, a developer |
| `project` | code we deployed — `promopilot`, `redbut` | **no** — an app is not a person |

Giving a project an owner is how "what do my developers cost" quietly starts including cron jobs.
Posting an owner for a project returns a 400, not a silent drop.

A machine and a project are both *callers*: either can appear on the wire and either can hold a key.

## Registering — every caller, before its first request

Nothing calls this router unregistered. `auth.mode = required`, so an unregistered name does not get
a warning, it gets a `401`. Registration is one call, and **issuing the key IS the registration** —
there is no separate "create, then authenticate" step to forget.

All of it is API-driven, but **minting a key is admin-gated** — every `POST /api/consumers/keys`
needs the control-panel password cookie. There is **no self-serve key issuance**: a developer or a
new app does not mint its own key, it asks whoever holds the panel password (or runs the calls below).
That is the point — a key is what makes a name mean something, so handing out the ability to create
keys would defeat it.

Log in once for the cookie, then every call reuses it:

```bash
curl -c /tmp/c -X POST https://llm.hostbun.cc/api/login \
  -H 'content-type: application/json' -d '{"password":"…"}'      # the panel password
API() { curl -s -b /tmp/c -H 'content-type: application/json' "$@"; }
```

**A project** (deployed code — no owner, because an app is not a person):

```bash
API -X POST https://llm.hostbun.cc/api/consumers/keys -d '{"name":"myapp","kind":"app"}'
# -> {"consumer":"myapp","keyId":"…","key":"sk-llm-…","warning":"only time the key is shown"}
```

**A developer, then their machine** (a machine belongs to a person; a person is registered first):

```bash
API -X POST https://llm.hostbun.cc/api/developers -d '{"name":"philip"}'
API -X POST https://llm.hostbun.cc/api/consumers/keys -d '{"name":"newbox","kind":"dev","owner":"philip"}'
```

Store the key immediately — only its sha256 is kept:

```bash
kv set llm/myapp/API_KEY 'sk-llm-…'
```

**Listing and removing:**

| call | what it does |
|---|---|
| `GET /api/projects` | every project, its live key count, whether it `canCall` |
| `GET /api/machines` | every machine, its developer, same |
| `GET /api/developers` | every person and the machines they own |
| `POST /api/consumers {"name":"x","remove":true}` | delete a consumer (its keys cascade) |
| `POST /api/consumers/keys/revoke {"name":"x","id":"…"}` | kill one key, keep the consumer |
| `POST /api/consumers/purge {"name":"junk"}` | delete the call-log rows of a name that was **never** registered |

The rules are enforced by Postgres, not by the API: a project with an owner, a machine without one, a
duplicate name, and deleting a developer who still owns a box are all refused by the database.

A **job** (`myapp:nightly`) needs no registration — only the consumer does. That is what keeps this
sustainable: a new workload never touches config.

## Authenticating

Every inference request needs a key. Get yours from keyvault:

```bash
kv get llm/<consumer>/API_KEY          # e.g. llm/promopilot/API_KEY
```

Send it the way your client already sends one — **no `X-Project` header needed, the key says who you are**:

```bash
# OpenAI clients (openai-python, openai-node, curl, LangChain, …)
curl https://llm.hostbun.cc/v1/chat/completions \
  -H "Authorization: Bearer sk-llm-…" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}]}'

# Anthropic SDK, native /v1/messages
curl https://llm.hostbun.cc/v1/messages \
  -H "x-api-key: sk-llm-…" -H "anthropic-version: 2023-06-01" …
```

```python
from openai import OpenAI
client = OpenAI(base_url="https://llm.hostbun.cc/v1", api_key=os.environ["LLM_API_KEY"])
```

To label a workload inside your consumer, add `X-Job: generatetext` (or send `X-Project:
promopilot:generatetext` — only the part after the colon is read). A job needs no registration.

**Lost your key?** They are hashed at rest; nobody can read yours back out of the router. Issue a new
one and revoke the old: `POST /api/consumers/keys {"name":"<consumer>"}`.

## Identity is a path: `<consumer>[:<job>]`

`promopilot:generatetext` is consumer `promopilot`, job `generatetext`. The split is on the **first**
colon only, so a job may contain colons and a consumer never can.

**Only the consumer is registered. Jobs are free.** A new workload needs no config change. Pins,
rules **and usage caps** resolve exact-path first, then the consumer, so pinning `promopilot` covers
every job under it while one greedy job can still be split out.

A cap resolved at consumer scope is also **metered** at consumer scope: a 10M-token cap on
`promopilot` counts `promopilot:generatetext` + `promopilot:l2_metadata` + everything else together,
so it is 10M in total rather than 10M each. An exact-path entry still wins outright — including an
all-zero one, which is how you exempt a single job from its consumer's cap. (Caps behaved as
literal-string-only until 2026-07-26, which meant a cap set on a consumer never applied to any of
its jobs — and the jobs are where the traffic is.)

## Where the router looks for your identity

In order:

1. A valid API key (`Authorization: Bearer sk-llm-…` or `x-api-key`). **This outranks anything you say
   about yourself.** Only the *job* half of `X-Project` (or an `X-Job` header) is still taken on trust.
2. `X-Project` header. Also accepts `X-Consumer`, `X-Project-Id`.
3. A top-level `"project"` field in the JSON body.
4. `"metadata": {"project": "…"}`.
5. The OpenAI `"user"` field.

An inference call with no identity is rejected:

```json
HTTP 400
{"error":{"message":"missing project attribution: send an 'X-Project' header (or a 'project' body field) identifying the calling app.",
          "type":"invalid_request_error","code":"project_required"}}
```

This applies to any POST whose body carries a `model` — which is every path that can reach a
provider, not a fixed list of URLs. `/v1/embeddings`, `/v1/rerank` and `/v1/audio/*` used to be
exempt and are not any more: the gate was a regex over the URL suffix while routing resolves on the
model id alone, so a request to any other path with a real model id passed the key check, the
allowlist and the usage limits and was proxied anyway (fixed 2026-07-30).

Still exempt: any GET, and `/v1/images/generations`, which is dispatched before this gate — see
[the image routes](endpoints.md#images), which are anonymous on purpose except for templated
generation.

## API keys

Wire format `sk-llm-<id>-<secret>`. The `id` is public (an 8-char handle, so lookup is a map hit
rather than a scan over every hash); the `secret` is never stored, only its sha256.

The consumer name is deliberately **not** in the key: it would leak who we are, and a name containing
a dash would make the key unparseable.

**Issuing a key IS registering.** One call creates the consumer if absent and returns the only copy of
the secret:

```bash
POST /api/consumers/keys   {"name":"my-app","kind":"app"}
→ {"consumer":"my-app","keyId":"1a2b3c4d","key":"sk-llm-1a2b3c4d-…",
   "warning":"this is the only time the key is shown — store it in keyvault now"}
```

Revoke with `POST /api/consumers/keys/revoke {name, id}`. The consumer, its pins and its history
survive; only that credential dies.

> `lastUsed` on a key is flushed on a five-minute timer, not per request. It is approximate. Never
> treat it as an audit trail.

## One key per consumer

A key is a bearer credential: whoever holds it **is** that consumer. Nothing on the wire stops a
developer from pasting their own key into an application, and when that happens nothing looks broken
— the call authenticates, the row is logged, and the spend lands under a person instead of an app.
Measured here on 2026-07-29: `pmac`'s key, a laptop, was serving **11,485 calls and 22.9M tokens a
week from a production box**, while that app sat in the registry holding a key of its own.

**Read before you lock.** `GET /api/consumers/clients?days=7` lists every distinct user-agent and
source IP that has presented each consumer's key, with call and token counts, and — where a policy
already exists — whether that client *would* be refused by it:

```bash
GET /api/consumers/clients?days=7
→ {"clients":[{"consumer":"pmac","ua":"node","ip":"85.194.137.213",
               "calls":11485,"tokens":22910524,"allowUa":[],"wouldBlock":null}, …]}
```

`wouldBlock: null` means *no policy*, which is not the same answer as *allowed by the policy*.

**Then lock.** `allowUa` is a list of user-agent **prefixes** a consumer's key may be presented with:

```bash
POST /api/consumers/policy   {"name":"pmac","allowUa":["claude-cli/"]}
POST /api/consumers/policy   {"name":"pmac","allowUa":[]}      # clears it
```

A key presented by any other client gets **403 `client_not_allowed_for_key`**, naming the consumer
the key belongs to and how to mint its own. Three things about it are deliberate:

- **Empty or absent means unrestricted**, never "nothing allowed" — the opposite makes a mistyped
  save an outage, exactly as with the routing allowlist.
- **It refuses; it never re-attributes.** Silently billing the call to whichever consumer it "should"
  have been is a guess, and a guess is what the no-fallback invariant forbids.
- **It is opt-in per consumer.** A blanket "developer keys are for the CLI only" would refuse the
  daemons that are legitimately developer-kind (`lprod-autofix`, `pmac-claude`) the day it shipped.

A user-agent is self-asserted, so this stops **sharing**, not an attacker. The deterministic version
is an IP allowlist, which suits a consumer that lives at a fixed address; a laptop does not have one.

## Two gates

- **`auth.mode`** — `off` | `optional` | `required`. The lock. `optional` is migration mode: a valid
  key wins, no key falls back to the header, and a key that is *presented and bad* is always a 401.
  Only `required` closes the hole. **Currently `required`** — the migration is done.
- **`requireRegisteredConsumer`** — a spelling check, not a lock. Applies only to calls with no key,
  and refuses an unknown consumer with `403 unknown_consumer` so a typo cannot become a new consumer
  with its own bill. **Currently on.**

## Get pinned (only for `claude*` models)

`local` and `crazyrouter` work the moment you send an identity. `claudecode` does not: your project
must first be pinned to a Claude Max account, or every call is refused.

```json
HTTP 403
{"error":{"type":"no_account_for_project",
          "message":"project \"my-app\" is not pinned to a Claude Code account",
          "pinned_projects":[ … ]}}
```

One project maps to exactly one account, forever. Rotating accounts would blow the per-org prompt
cache (roughly 12× the cost) and make "who spent this?" unanswerable after the fact. The router never
guesses whose subscription to bill.

## Quota

A project can carry a rolling-window limit (tokens or calls). Usage is summed live from the call log.
Every response tells you where you stand:

| Header | Meaning |
|---|---|
| `x-usage-percent` | How far through the window's cap you are, 0–100+ |
| `x-usage-window`, `x-usage-limit` | The window (`24h`) and the cap |
| `x-usage-warning` | Past the warn threshold (default 80%). Nothing is slowed yet. |
| `x-usage-throttled-ms` | Past the slow threshold (default 95%). Your request was deliberately delayed by this many ms. |

Past the hard cap: `429 usage_limit_exceeded` with `retry-after: 60`. Limits ship off (cap `0` =
unlimited).
