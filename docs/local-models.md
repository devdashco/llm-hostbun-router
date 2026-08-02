# Local models — llama.cpp pass-through

The `local` provider is a llama.cpp server on the pbox GPU. Free, on-prem, no key, no per-token bill.

**The router forwards your JSON body verbatim.** It is not an allowlist of OpenAI fields: whatever
llama.cpp accepts, you can send. Two fields are the exception and both are documented below.

## What is actually loaded

Ask the server, do not trust this page — the checkpoint behind `local` is ours to swap.

```bash
curl https://pbox.llm.hostbun.cc/props | jq '{model_path, modalities, n_ctx, total_slots, build_info}'
```

As of 2026-08-02 that answers `Qwen3.5-9B-UD-Q4_K_XL.gguf`, build `b10223`, `n_ctx: 65536` over
`total_slots: 6`, vision in, audio out of scope.

Five model ids all resolve here — `local`, `gemma`, `gemma-4-26b`, `qwen`, `qwen3.5-9b`. **The
`gemma*` pair are now the legacy aliases** — they served gemma-4-26B-QAT until 2026-08-02 and serve
Qwen today. That is the reverse of what this page said for the three weeks before, so trust `/props`
over any id.

The swap was measured, not assumed, and it is a trade rather than a win on every axis: aggregate
throughput at 6 concurrent went 262 -> **395 tok/s** and VRAM 18.0 -> 15.5 GB, but a *single*
request got slower, 147 -> **121 tok/s**. It is the right trade only because this lane is
throughput-bound — peak 32 overlapping requests, p95 43s on a busy day. A draft model does not buy
the single-stream back: llama.cpp disables speculative decoding when `-np > 1`, so the 0.8B draft
measured 124.0 against 124.7 without it.

## Structured output — three ways, all grammar-enforced

llama.cpp compiles each of these into a GBNF grammar and the sampler cannot leave it. This is a hard
constraint, not a request the model may decline.

| you send | what happens |
|---|---|
| `response_format: {"type": "json_object"}` | output is constrained to any valid JSON |
| `response_format: {"type": "json_schema", "json_schema": {"name": …, "schema": {…}}}` | output is constrained to your schema |
| `grammar: "root ::= …"` | raw GBNF, for anything JSON cannot express |

```bash
# GBNF: the reply can only ever be one of two tokens
curl https://llm.hostbun.cc/v1/chat/completions \
  -H "Authorization: Bearer sk-llm-…" -H "Content-Type: application/json" \
  -d '{"model":"local","max_tokens":40,"grammar":"root ::= \"YES\" | \"NO\"",
       "messages":[{"role":"user","content":"Is the sky blue? Answer at length."}]}'
# -> "YES"
```

### `strict` does nothing here

llama.cpp ignores `json_schema.strict`. Measured 2026-07-31: `strict: false` and `strict: true`
returned byte-identical bodies at identical token counts, and an enum schema refused an out-of-enum
value at `strict: false`. The grammar is always on. Send it if your other providers need it; do not
expect it to change anything on this lane.

### The one that will bite you: `required`

A property **not** in `required` is one the grammar lets the model *skip*. A small model takes the
shortest legal path, so it answers your required fields and stops — no error, no warning, just a
thin object.

Measured on a 24-property schema with 3 required: gemma answered exactly those 3 (164 completion
tokens) on a prompt that stated rent, size, municipality, furnishing and pet policy. With every
property in `required` it answered all 24 (313 tokens), correctly.

If a field is optional in meaning, make it **nullable and required** — `{"type": ["string", "null"]}`
in `required` — so the model must answer `null` rather than silently omit it. A frontier model reads
your prompt and volunteers the fields anyway, which is why a schema can look fine on a paid lane and
be hollow here.

## Sampling and decoding parameters

Every parameter llama.cpp's `/props` reports under `default_generation_settings.params` is accepted
verbatim:

`temperature` · `top_k` · `top_p` · `min_p` · `typical_p` · `top_n_sigma` · `dynatemp_range` ·
`dynatemp_exponent` · `xtc_probability` · `xtc_threshold` · `mirostat` · `mirostat_tau` ·
`mirostat_eta` · `repeat_penalty` · `repeat_last_n` · `presence_penalty` · `frequency_penalty` ·
`dry_multiplier` · `dry_base` · `dry_allowed_length` · `dry_penalty_last_n` · `samplers` ·
`seed` · `max_tokens` · `n_predict` · `n_keep` · `n_discard` · `n_probs` · `min_keep` ·
`ignore_eos` · `post_sampling_probs` · `timings_per_token` · `lora`

Read the current list off the server rather than this page:

```bash
curl https://pbox.llm.hostbun.cc/props | jq '.default_generation_settings.params | keys'
```

`seed` + `top_k: 1` gives you a reproducible decode. `n_probs` returns per-token logprobs.

## Thinking is OFF by default, and that is deliberate

This is a reasoning model: it writes its chain of thought into `reasoning_content` and leaves
`content` **empty** until it finishes. With an ordinary `max_tokens` it never finishes, so you get
`content: ""` and `finish_reason: "length"` having paid for every token. Measured: 1,200 tokens
spent, 3,435 characters of reasoning, zero content.

So the router sends `chat_template_kwargs: {"enable_thinking": false}` on this provider unless you
said otherwise. To turn thinking back on:

```json
{"chat_template_kwargs": {"enable_thinking": true}}
```

A top-level `enable_thinking` works too — the router hoists it. Sent directly to llama.cpp the
top-level form is accepted and silently ignored, which is why the obvious fix appears to do nothing
when you bypass the router.

## The only two things the router changes on this lane

1. **`chat_template_kwargs.enable_thinking`** defaults to `false`, as above. Set it yourself and the
   router leaves it alone.
2. **A `response_format` request is validated, and retried if the reply will not parse** (`2` attempts
   after the first, `JSON_MAX_RETRIES`). The grammar makes that rare; it is there for the case where
   the reply is fenced in ```` ```json ```` or the upstream ignores the field. When the retries are
   spent you get a `422 json_validation_failed` carrying the last raw content — never prose
   pretending to be JSON.

   Note this path buffers: `stream: true` plus a `response_format` is answered as a single
   synthesized SSE chunk, not token by token.

Everything else — every sampler, `stream`, `tools`, `stop`, vision parts, `logit_bias` — reaches the
server exactly as you sent it.

## What does not apply here

- **No cost.** Nothing on this lane bills. `list_usd` is a real `0`, not "unknown".
- **No prompt cache accounting.** The Anthropic cache-breakpoint machinery is `claudecode` only.
- **No account pinning.** One GPU, no pool. `total_slots: 2`, so heavy concurrency queues — in the
  router, ahead of llama.cpp, two at a time (see "One at a time on the GPU lanes" in the overview).
  Queueing there rather than at the model is what keeps a burst from timing out: the router's
  120s upstream budget then starts when your request reaches the GPU, not when it joins the line.
