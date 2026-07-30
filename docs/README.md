# llm.hostbun.cc

One OpenAI-compatible endpoint at `https://llm.hostbun.cc/v1`. It is the only middleman between any
of our code and a model.

Three providers, picked automatically from the model id:

| provider | what it is | cost |
|---|---|---|
| `local` | on-prem GPU (llama.cpp on the pbox 4090) | free |
| `claudecode` | real Claude, served by your project's pinned Claude Max account | flat (subscription) |
| `crazyrouter` | cloud relay (Gemini and friends) | **per token** |

Plus on-prem image generation (`model: "imagegen"`). You never send a model key: the router injects it.

## Read this before you integrate

> **Every prompt and every reply is stored, in plaintext, indefinitely.**
> See [What gets stored](storage.md). Do not send secrets, credentials, or personal data you would
> not put in a shared database.

**An API key is required.** `auth.mode = required`: every inference call must present a
per-consumer key (`sk-llm-…`) as `Authorization: Bearer` (any OpenAI client) or `x-api-key` (the
Anthropic SDK), and a request without one gets `401`. The key IS the identity — the consumer comes
from it, not from a header you send. Yours is in keyvault at `llm/<consumer>/API_KEY`; see
[Authenticating](identity.md#authenticating).

**The URL is still not a place to be careless.** The image routes under `/v1/images/*` are
deliberately anonymous (our own GPU, no per-token cost), so anyone who can reach the host can spend
GPU seconds there. And every prompt is stored — see above.

**`X-Project` is attribution, not authentication** — unless you send a key. With a key, the consumer
is asserted by us, not by you, and only the *job* half of the header is taken on trust.

**There is no IP allowlist.** Your IP is recorded on every call. It gates nothing.

## How one request flows

Any step can end it.

1. **Identity.** A valid API key names the consumer. Without one, the router reads `X-Project` (or a
   body field). No identity on an inference call → `400 project_required`.
2. **Routing.** The model id picks the provider, unless the consumer has a pin. A per-project
   allowlist can refuse the result outright. Unroutable → `400 model_not_routable`.
3. **Usage quota.** Rolling-window limits are summed live from the call log: warn → slow → block.
4. **Gate** (`local` only). Gated model ids need `Authorization: Bearer <token>`.
5. **Account pinning** (`claudecode` only). Your project must be pinned to a Max account, or
   `403 no_account_for_project`. The pinned account's token is injected; the required Anthropic
   headers are synthesized, and your own `Authorization` is discarded.
6. **Upstream call.** One round trip.
7. **JSON enforcement.** If you asked for `response_format`, the reply is parsed, repaired, or
   re-prompted before you see it.
8. **Logging.** The call, prompt and reply included, is written to Postgres.

## No fallback, anywhere

If the pinned account is out of quota you get its real `429`. If upstream 500s you get its real
`5xx`. The router will never silently answer from a different account or a different provider, and a
per-project allowlist **refuses** rather than substituting an allowed model.

That is a deliberate, load-bearing decision. Silent failover once hid both the cost and the truth.

## Error codes

| Status | `code` | Why, and what to do |
|---|---|---|
| 400 | `project_required` | No identity on an inference call. Send a key, or `X-Project`. |
| 400 | `model_not_routable` | The id matched no provider, or crazyrouter is off / in allowlist mode. Fix the id, or ask an admin. |
| 400 | *(blocked)* | Your project's rule refuses this provider or model, or you posted an image model to a text endpoint. The body says which. |
| 401 | `unauthorized` | A bad API key was presented, or a gated `local` model was requested without its bearer token. |
| 403 | `no_account_for_project` | Your project is not pinned to a Max account. Not retryable. The body lists the projects that are. |
| 403 | `unknown_consumer` | You named a consumer that is not registered. Register it, or send a key. |
| 422 | `json_validation_failed` | You asked for JSON and the model would not produce it, even after re-prompting. |
| 429 | `usage_limit_exceeded` | Your project hit its rolling-window quota. Honour `retry-after`. |
| 429 | *(upstream)* | The pinned account is out of Max quota, or crazyrouter rate-limited us. Real 429, passed through. Waiting is the fix. |
| 5xx | *(upstream)* | Upstream failed. Passed through verbatim. Retry with backoff. |
