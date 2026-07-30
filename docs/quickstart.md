# Quick start

One base URL for everything. The model id picks the provider, and the router injects the real
upstream credential — but it needs YOUR key first: `auth.mode = required`, so an inference call
without one gets `401`. Yours is in keyvault at `llm/<consumer>/API_KEY`; an admin mints one with
`POST /api/consumers/keys` and it is shown exactly once. Store it in keyvault, never in git.

The key names the consumer, so `X-Project` carries only the job half, if anything.

```bash
# local GPU — free, on-prem
curl https://llm.hostbun.cc/v1/chat/completions \
  -H "Authorization: Bearer sk-llm-1a2b3c4d-…" \
  -H "Content-Type: application/json" -H "X-Project: my-app" \
  -d '{"model":"local","messages":[{"role":"user","content":"hi"}],"max_tokens":512}'

# real Claude — billed to my-app's pinned Max account
curl https://llm.hostbun.cc/v1/chat/completions \
  -H "Authorization: Bearer sk-llm-1a2b3c4d-…" \
  -H "Content-Type: application/json" -H "X-Project: my-app" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}'

# crazyrouter — anything else, billed per token
curl https://llm.hostbun.cc/v1/chat/completions \
  -H "Authorization: Bearer sk-llm-1a2b3c4d-…" \
  -H "Content-Type: application/json" -H "X-Project: my-app" \
  -d '{"model":"gemini-2.5-flash-lite","messages":[{"role":"user","content":"hi"}]}'
```

The Anthropic SDK sends `x-api-key` instead of `Authorization`. Both are accepted.

These examples used to omit the key entirely, with a separate "with an API key" section below them
— written while `auth.mode` was `optional`. Copied today they answer `401`, which is a confusing
first impression of a router whose front page also claimed no key was needed.

## Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://llm.hostbun.cc/v1",
    api_key="sk-llm-…",                        # your consumer key — required; a placeholder 401s
    default_headers={"X-Project": "my-app"},   # required on every inference call
)

client.chat.completions.create(model="local", messages=[{"role": "user", "content": "hi"}])
client.chat.completions.create(model="claude-sonnet-4-6", messages=[{"role": "user", "content": "hi"}])
```

## Node

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://llm.hostbun.cc/v1",
  apiKey: "sk-llm-…",
  defaultHeaders: { "X-Project": "my-app" },
});
```

If your SDK will not let you set headers, set the OpenAI `user` field to your project slug. The
router falls back to it.

## Streaming

```bash
curl -N https://llm.hostbun.cc/v1/chat/completions \
  -H "Content-Type: application/json" -H "X-Project: my-app" \
  -d '{"model":"gemini-2.5-flash-lite","stream":true,
       "messages":[{"role":"user","content":"count to 5"}]}'
```
