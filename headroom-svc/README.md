# headroom-compress

Tiny HTTP sidecar that runs [headroom](https://github.com/chopratejas/headroom)
context compression on a list of chat messages. Deployed as its **own** Coolify
app next to `llm-hostbun-proxy`; the proxy calls it before forwarding upstream.

It is **not** an LLM proxy — it never talks to a model. It takes messages in,
runs `headroom.compress()`, returns the (shorter) messages + stats.

## API

`POST /compress`
```json
{ "messages": [ {"role":"user","content":"..."} ], "model": "claude-sonnet-4-6" }
```
→
```json
{ "messages": [ ... compressed ... ],
  "stats": { "tokens_before": 5606, "tokens_after": 1724, "tokens_saved": 3882,
             "compression_ratio": 0.69, "transforms_applied": ["..."] } }
```
On any internal error the original messages are returned unchanged (`stats.error` set).

`GET /health` → `{ "ok": true }`

## Env

| var | default | meaning |
|-----|---------|---------|
| `PORT` | `8000` | listen port |
| `HR_MODEL` | `claude-sonnet-4-5-20250929` | model id used for **token counting** when the request omits one |
| `HR_COMPRESS_USER` | `0` | compress user messages too (headroom protects them by default) |
| `HR_PROTECT_RECENT` | `4` | leave the N most recent messages untouched |
| `HR_MIN_TOKENS` | `250` | don't compress a message below this token count |

## Run locally

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv -r requirements.txt
.venv/bin/uvicorn app:app --port 8000
```

## Deploy (Coolify)

New application, same repo (`devdashco/llm-hostbun-proxy`), **Base Directory**
`/headroom-svc`, Dockerfile build pack. No public domain needed — the proxy
reaches it over the internal Docker network. Point the proxy at it with
`HEADROOM_URL=http://<service-host>:8000`.
