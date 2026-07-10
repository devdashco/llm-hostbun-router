# Quick start

One base URL for everything. The model id picks the provider. The API key placeholder is ignored for
routing: the router injects the real upstream credential.

```bash
# local GPU — free, on-prem
curl https://llm.hostbun.cc/v1/chat/completions \
  -H "Content-Type: application/json" -H "X-Project: my-app" \
  -d '{"model":"local","messages":[{"role":"user","content":"hi"}],"max_tokens":512}'

# real Claude — billed to my-app's pinned Max account
curl https://llm.hostbun.cc/v1/chat/completions \
  -H "Content-Type: application/json" -H "X-Project: my-app" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}'

# crazyrouter — anything else, billed per token
curl https://llm.hostbun.cc/v1/chat/completions \
  -H "Content-Type: application/json" -H "X-Project: my-app" \
  -d '{"model":"gemini-2.5-flash-lite","messages":[{"role":"user","content":"hi"}]}'
```

## With an API key

Ask an admin for one (`POST /api/consumers/keys`). It is shown exactly once. Store it in
keyvault, never in git. The key names the consumer, so `X-Project` may then carry only the job.

```bash
curl https://llm.hostbun.cc/v1/chat/completions \
  -H "Authorization: Bearer sk-llm-1a2b3c4d-…" \
  -H "X-Project: my-app:nightly-summary" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}]}'
```

The Anthropic SDK sends `x-api-key` instead of `Authorization`. Both are accepted.

## Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://llm.hostbun.cc/v1",
    api_key="sk-llm-…",                        # your consumer key, or "x" while auth.mode is optional
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
