# Accounts, usage limits, and pinning

Every `claudecode` call is served by one **Claude Max subscription** from the pool. Which one is
decided **server-side, from your project's pin** — never by a request header. This page is how you
see a subscription's headroom, and how you make your code (local or deployed) run on the account you
want.

## The rule: one project → one account, forever

`accountFor(project)` = `projectAccounts[project]`. There is **no rotation and no fallback**:

- A pinned project always spends the same subscription (rotating would blow the per-org prompt cache
  ~12× and make "who spent this?" unanswerable).
- An **unpinned** project gets `403 no_account_for_project` — the router never guesses whose plan to
  bill. The error lists the projects that *are* pinned.
- **No header overrides it.** Not `Authorization`, not `X-Account`, nothing. Your inbound
  `Authorization` is discarded and replaced with the pinned account's token.

So "run a specific account" always means **"be a consumer that is pinned to that account"** — either
pin yours, or use one already pinned there.

## Seeing usage limits

The Accounts tab (and `GET /api/limits`) shows each subscription's **5h and 7d usage windows** with
their **reset times**. These are harvested for free off real traffic, so an **idle** account — or one
Anthropic just **refunded/reset** — keeps its last reading until it serves a call again.

Hit **"↻ Refresh limits (live)"** (or `POST /api/claudecode/limits {all:true}`) to pull the real
window **right now** — it pings each subscription once and reads the live headers.

```bash
curl -s -b cookie.txt -X POST https://llm.hostbun.cc/api/claudecode/limits \
  -H 'content-type: application/json' -d '{"all":true}'
# → per account: reading {u5,u7,reset5,reset7,...}, or a reason it could not read
```

Two failure modes, and they are **not** the same:

| what you see | meaning | fix |
|---|---|---|
| **429** / window near 100% | the usage window is **spent** | wait for `reset5`/`reset7` — it refills on its own |
| **✕ OAuth disabled** (403 `permission_error`) | the **login is disabled** (subscription cancelled/refunded) | the account is dead — re-pin your project to a live account |

There is no "this account only serves haiku" state. These are subscriptions; every account serves
every model **when its window has headroom**.

## Run a specific account — locally (a developer)

Your machine and its daemons are **consumers** (`pmac`, `pmac-claude`). Point your tooling at the
router and authenticate with your consumer key; the account is whatever your consumer is pinned to.

**1. Route local Claude Code through the router** (native `/v1/messages`, forwarded byte-for-byte):

```bash
export ANTHROPIC_BASE_URL=https://llm.hostbun.cc
export ANTHROPIC_API_KEY=sk-llm-<id>-<secret>     # your consumer key (keyvault: llm/<consumer>/API_KEY)
# optional: label the workload — only the job half is taken on trust
export ANTHROPIC_CUSTOM_HEADERS='X-Project: pmac-claude:refactor'
claude   # now every model call is served by pmac-claude's pinned account
```

Scripts and OpenAI clients are the same idea, against `/v1`:

```python
from openai import OpenAI
client = OpenAI(base_url="https://llm.hostbun.cc/v1", api_key="sk-llm-…",
                default_headers={"X-Project": "pmac"})
client.chat.completions.create(model="claude-sonnet-4-6",
                               messages=[{"role":"user","content":"hi"}])
```

**2. Choose which account it runs on** — pin your consumer to it (merges; never deletes other pins):

```bash
# see who is pinned where, and each account's live headroom, first
curl -s -b cookie.txt https://llm.hostbun.cc/api/accounts

# point pmac-claude at the 'philip' subscription
curl -s -b cookie.txt -X POST https://llm.hostbun.cc/api/pins \
  -H 'content-type: application/json' -d '{"project":"pmac-claude","account":"philip"}'
```

Want two accounts side by side? Register two consumers (`pmac-a`, `pmac-b`), pin each to a different
subscription, and pick the account by choosing which key you run with. That is the *only* way to
target a specific account — by identity, not by a per-request flag.

Confirm before you spend a token: `POST /api/resolve {model, project}` shows the provider, the model
that would be sent, and whether it is blocked, without calling upstream.

## Use it from a live project (a deployed app)

**1. Get a key** (one per consumer; the secret is shown exactly once):

```bash
curl -s -b cookie.txt -X POST https://llm.hostbun.cc/api/consumers/keys \
  -H 'content-type: application/json' -d '{"name":"promopilot","kind":"app"}'
# → store the returned sk-llm-… in keyvault at llm/promopilot/API_KEY, never in git
```

An **app has no owner** (`kind:"app"`); a person's machine/daemon is `kind:"dev"` with an `owner`.

**2. Pin it to a subscription** with headroom (check the live limits first):

```bash
curl -s -b cookie.txt -X POST https://llm.hostbun.cc/api/pins \
  -H 'content-type: application/json' -d '{"project":"promopilot","account":"cmejl3"}'
```

**3. Call the router** — base URL `https://llm.hostbun.cc/v1`, your key, a model id:

```bash
curl https://llm.hostbun.cc/v1/chat/completions \
  -H "Authorization: Bearer sk-llm-…" \
  -H "X-Project: promopilot:generatetext" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}]}'
```

- **Jobs are free.** `X-Project: promopilot:generatetext` splits one consumer's spend by workload with
  **no config change** — register the consumer once, label jobs forever. Only the consumer is
  registered; the job half is taken on trust.
- **Pick the model by id.** `claude-*` → this pool; `local` → the free on-prem GPU; anything else →
  crazyrouter (per token). See [Routing](routing.md).
- **No fallback, on purpose.** If the pinned subscription is out of window you get the 429; if its
  login is disabled you get the 403. The caller is told the truth rather than billed a silent guess on
  a different account.

## When an account dies

If a subscription is cancelled or refunded, its live read returns **403 OAuth disabled**. Every
project pinned to it then 403s. Re-pin those projects to a live account:

```bash
curl -s -b cookie.txt https://llm.hostbun.cc/api/accounts        # find a live one with headroom
curl -s -b cookie.txt -X POST https://llm.hostbun.cc/api/pins \
  -H 'content-type: application/json' -d '{"project":"pmac","account":"philip"}'
```
