# Endpoints

| Method | Path | Provider | Purpose |
|---|---|---|---|
| POST | `/v1/chat/completions` | all three | Chat, routed by model. Streaming, tools, structured output, vision. Needs identity. |
| POST | `/v1/messages` | `claudecode` | Anthropic-native shape, forwarded byte-for-byte. Needs identity. |
| POST | `/v1/images/generations` | image | Text-to-image on ww's RTX 3070. No identity required. |
| GET | `/v1/templates`, `/v1/loras` | image | SD-Turbo prompt templates and named-LoRA catalog |
| POST | `/v1/images/generations` + `template` | `crazyrouter` | Reference-picture templates. Paid, **needs a key**. |
| GET | `/v1/image-templates` | meta | The reference-picture templates and their pictures |
| POST | `/v1/completions`, `/v1/embeddings`, `/v1/audio/*`, `/v1/rerank` | `crazyrouter` | Rest of the OpenAI-compatible surface, key injected |
| GET | `/v1/models` | merged | What each provider currently advertises. Not the priced list; see `/prices.json`. |
| POST | `/local/v1/chat/completions` | `local` | Legacy explicit local path |
| GET | `/prices.json`, `/prices` | meta | Computed crazyrouter prices, refreshed every 6h |
| GET | `/docs` | meta | These docs |
| GET | `/` | meta | Control panel, password-gated |

`/admin` 308s to `/`: the site root **is** the panel.

## Structured / JSON output, enforced

Send `response_format: {"type":"json_object"}` (or `{"type":"json_schema", …}`) and the router verifies
the model actually returned valid JSON before handing it back. It does not trust the model to honour
the flag.

- Reply parses → returned unchanged.
- Reply is wrapped in a ```` ```json ```` fence → fence stripped, no extra round trip.
- Still invalid → the router re-prompts the same model with the parse error (default 2 retries).
- Never complies → `422 json_validation_failed`, with the last raw content, instead of a malformed
  body that explodes your `JSON.parse`.

Anthropic has no `response_format` field at all. For `claudecode` the router strips it and instructs
the model in-prompt instead (including your JSON Schema), then validates the same way.

Because the whole reply must be buffered to validate it, `stream: true` plus a JSON `response_format`
returns the content in a single reconstructed SSE chunk rather than token by token. Validation is
structural JSON, not full JSON-Schema.

## Everything else passes through

The router rewrites only `model` (and `response_format`, for JSON enforcement). Every other field is
forwarded untouched: `reasoning_effort`, `thinking`, `temperature`, `top_p`, `tools`, `tool_choice`,
`stop`, `seed`, `max_tokens`. No default effort is set; omit the field and the upstream's own default
applies.

## Image generation — `model: "imagegen"`

Text-to-image on ww's GPU (NVIDIA SANA-Sprint 0.6B, 2 steps), token injected server-side. OpenAI-compatible
`/v1/images/generations`, always base64 (`{"data":[{"b64_json": …}]}`); we host no URLs.

| Field | Meaning |
|---|---|
| `prompt` | Text prompt. Optional if `template` is given. |
| `template` | Named prompt template (`GET /v1/templates`) |
| `vars` | Pin specific template slots, e.g. `{"hair":"jet black"}`; the rest stay random |
| `lora` | A registered LoRA name (`GET /v1/loras`), an HF repo id, or a local path |
| `lora_scale` | Override LoRA strength |
| `n`, `size`, `seed`, `steps` | Count (1–8), WxH (default `1024x1024`), seed, steps (default 8) |

Sizes are floored to a multiple of 8: the SDXL VAE downsamples ×8, and a non-multiple crashes upstream
with a bare 500.

```bash
curl https://llm.hostbun.cc/v1/images/generations -H "Content-Type: application/json" \
  -d '{"model":"imagegen","lora":"watercolor","prompt":"a cozy reading nook by a window"}'
```

Asking for `imagegen` on a chat endpoint is refused with a 400 that tells you to POST it here instead.

## Image templates — a reference picture + a style instruction

The same path serves a **second** kind of image. A template registered on this router carries a
reference picture and a standing style instruction, and renders through an image-capable cloud model
(`nano-banana` and friends) that can actually *see* the reference. That is what keeps a recurring
character or house style consistent across articles — SDXL above cannot do it, because it never sees
a picture.

```bash
curl https://llm.hostbun.cc/v1/images/generations \
  -H "Authorization: Bearer sk-llm-…" -H "Content-Type: application/json" \
  -d '{"model":"nano-banana","template":"bobbo","prompt":"handing over the keys to a new tenant"}'
# → {"created":…,"data":[{"url":"https://media.crazyrouter.com/…png"}]}
```

| Field | Meaning |
|---|---|
| `template` | A slug from `GET /v1/image-templates`. **This field is what picks the upstream.** |
| `prompt` | The scene. Required — a template is a style, not a subject. |
| `model` | Optional; defaults to the template's own. Must be an image model this router knows. |

It is paid by its own upstream token (`IMAGE_TEMPLATE_KEY`), separate from the router's main
crazyrouter key: access to the image models is granted **per token**, and the main key — valid, and
billing fine for text — answers `This token does not have access to model gemini-2.5-flash-image`.
Unset, it falls back to the main key.

**This is the one image route that needs a key.** Everything else under `/v1/images/*` runs on our own
GPU and is free, so it is deliberately anonymous; this one spends real money per picture, and an
unauthenticated paid route is a bill nobody can attribute.

A `template` value this router does not know **falls through untouched** to the SD-Turbo prompt
templates above — the two vocabularies share the field, and ours wins a name collision.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/image-templates` | Every template: instruction, aspect ratio, sites, reference URL |
| GET | `/v1/image-templates?site=bofrid.se` | The template that dresses one site (404 if none does) |
| GET | `/v1/image-templates/<slug>/reference` | The reference picture itself |
| GET/POST | `/api/image-templates` | List / create / edit (panel cookie) |
| POST | `/api/image-templates/remove` | Delete, picture and all (panel cookie) |

Create one with the picture inline — a URL, a `data:` URI, or bare base64. It is fetched **once** and
stored on the router's volume, so a template never depends on someone else's bucket staying up:

```bash
curl https://llm.hostbun.cc/api/image-templates -b hb_admin=… -H "Content-Type: application/json" \
  -d '{"slug":"bobbo","name":"Bobbo","aspectRatio":"1:1","sites":["bofrid.se"],
       "systemInstruction":"Follow the reference character and style. NO TEXT IN THE IMAGE.",
       "referenceImage":"https://example.com/bobbo.jpg"}'
```

Editing merges: omit `referenceImage` and the stored picture stays. The templates shipped in
`assets/image-templates/` are restored automatically when the store is empty (a fresh volume) — and
only then, so a deliberate deletion sticks.
