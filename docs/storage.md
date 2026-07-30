# What gets stored

Every request is written to a `calls` table in the `llmrouter` Postgres database. Per call:

- Your IP and User-Agent, method, path, timestamp, latency.
- Requested model, resolved provider, the model actually sent upstream, which account served it, the
  HTTP status.
- Full token accounting: prompt, completion, thinking, cache read, cache write, stop reason, tool
  counts.
- **The full prompt you sent, and the full reply you got back, as plaintext. Uncapped by default.**

Retention is unlimited by default. Rows are never pruned unless a retention count is configured, and
even then `claudecode` rows are exempt and kept forever. There is no redaction, no scrubbing, no TTL.

> Anyone with the control-panel password can read every prompt and every reply any project has ever
> sent, search across them, and export the lot.

So: **do not send secrets, credentials, tokens, or personal data through this router.** If you must
process sensitive text, use `model: "local"` — it is still logged here, but it never leaves our
hardware.

Writes are fire-and-forget. A failed insert logs a warning and is dropped, because losing a log line
must never fail an inference request. The log can therefore under-count if the database is down.

## Pricing — `/prices.json`

Actual prices for the `crazyrouter` provider, per-model discount applied. `local` is $0. `claudecode`
is flat: it draws on a Claude Max subscription, not a per-token balance, so it does not appear here.

```bash
curl https://llm.hostbun.cc/prices.json
# { "generated_at":"…","count":165,
#   "models":[{"model":"gemini-2.5-flash-lite","type":"token",
#              "input_per_1m":0.08,"output_per_1m":0.30,"discount":0.55}, …] }
```

Token models are USD per 1M tokens (in/out). Image, video and audio models are USD per call. The feed
self-refreshes every 6h.

Crazyrouter's own balance is not on this router. `/dashboard/billing/*` belongs to crazyrouter and
is called server-side by the admin health check; this page used to show those two URLs against
`llm.hostbun.cc`, where they have never existed — a GET there falls through to the model router and
answers `400 model_not_routable`. The reading is behind the panel's cookie:

```bash
curl https://llm.hostbun.cc/api/crazyrouter -H "cookie: hb_admin=…"   # {"hardLimitUsd":…,"totalUsageUsd":…}
```
