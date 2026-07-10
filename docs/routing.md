# Routing and providers

The model id picks the provider, unless your project has a rule.

| model id | provider |
|---|---|
| `local`, `qwen`, `qwen3.5-9b` | `local` |
| anything starting `claude` | `claudecode` |
| `imagegen`, `sd-turbo` | image service, and **only** on `/v1/images/*` |
| everything else | `crazyrouter` |

Posting an image model to a text endpoint is refused, not forwarded. It used to fall through the whole
resolver into crazyrouter, the one provider that bills per token, and come back as their 404 on our
bill.

## `local` — on-prem GPU, free

Qwen3.5-9B, Q4_K_M GGUF, 16K context, resident on the GPU, no cold start. Private: the data stays
on-prem. No key.

> **It is a reasoning model, and that will bite you.** It emits its chain of thought into
> `reasoning_content` and leaves `content` empty until it finishes. With a small `max_tokens` it never
> finishes: you get `content: ""` and `finish_reason: "length"`, having paid for every token.

The router now defaults thinking **off** for this provider. To turn it back on, send
`chat_template_kwargs: {"enable_thinking": true}`. A top-level `enable_thinking` also works, because
the router hoists it — llama.cpp accepts the top-level form and silently ignores it, which is why the
obvious fix appears to do nothing when you talk to it directly.

```bash
curl https://llm.hostbun.cc/v1/chat/completions \
  -H "Content-Type: application/json" -H "X-Project: my-app" \
  -d '{"model":"local","messages":[{"role":"user","content":"describe Stockholm"}],"max_tokens":512}'
```

## `claudecode` — real Claude, flat cost

Any id starting `claude` goes to `api.anthropic.com`, called with the Max account pinned to your
project. Cost is flat (a subscription), not per token.

Check `GET /v1/models` for current ids. Anthropic ships new ones without asking, and the catalog is
**per account**: an advertised id can still be absent on the account you are pinned to. Everything
before the 4.5 family is 404 on a Max token; those models are not ours to call.

Both shapes work:

- OpenAI `/v1/chat/completions` — translated on the way out and back.
- Anthropic-native `/v1/messages` — forwarded **byte-for-byte**.

Use the native shape if you care about tool fidelity, extended thinking, or the prompt cache.

```bash
curl https://llm.hostbun.cc/v1/messages \
  -H "Content-Type: application/json" -H "X-Project: my-app" \
  -d '{"model":"claude-opus-4-8","max_tokens":1024,
       "messages":[{"role":"user","content":"hi"}]}'
```

The account is chosen server-side, from your project. No request header can change it, not
`Authorization`, not `X-Account`, not anything. Your `Authorization` is discarded and replaced.

## `crazyrouter` — cloud relay, per token

Every id that is not a local alias and does not start with `claude` lands here, key injected. Chat,
streaming, tools, structured output, vision, embeddings, rerank, audio.

This is the only provider that costs real money per request. An admin can set the policy to `open`
(forward anything), `allowlist` (only listed ids), or `off`. A `400 model_not_routable` on a model
that clearly exists is usually this.

## Per-project rules

A project rule carries two **independent** things. Conflating them is how "pin promopilot to haiku"
becomes "promopilot may only ever use haiku" by accident.

| | what it does | on mismatch |
|---|---|---|
| **pin** (`provider` + `model`) | rewrites the request | n/a |
| **allowlist** (`allowProviders`, `allowModels`) | restricts where it may resolve | `400`, refused |

The allowlist **refuses, never substitutes**. Serving an allowed model instead of the one you asked
for would be exactly the silent failover this router exists to prevent. An empty or absent list means
*no restriction*, never "nothing allowed".

Rules resolve exact path → consumer → group, so a rule on `promopilot` also governs
`promopilot:generatetext`. The pin is applied first; the allowlist then judges the model that will
actually be **sent**.

Ask an admin, or `POST /api/routes {project, provider?, model?, allowProviders?, allowModels?}`.

## Where did my request go?

`POST /api/resolve {model, project}` answers exactly that: the provider, the model that would be
sent upstream, the reason, and whether it would be blocked. No tokens are spent.
