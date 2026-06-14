"""headroom-compress — tiny HTTP wrapper around headroom.compress().

POST /compress  { messages, model?, model_limit?, ...opts }  -> { messages, stats }
GET  /health

This is NOT a full LLM proxy. It only runs headroom's compression pipeline on a
list of messages and hands the (possibly shorter) list back. The llm-hostbun-proxy
calls it before forwarding a request upstream, then forwards the compressed body.

Any failure returns the messages unchanged (passthrough) so the proxy never breaks
inference because of the compressor.
"""
import os
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

from headroom import compress, CompressConfig

app = FastAPI(title="headroom-compress", version="1")

# Defaults (env-overridable). Per-request fields override these.
DEFAULT_MODEL = os.environ.get("HR_MODEL", "claude-sonnet-4-5-20250929")
COMPRESS_USER = os.environ.get("HR_COMPRESS_USER", "0").lower() in ("1", "true", "yes")
PROTECT_RECENT = int(os.environ.get("HR_PROTECT_RECENT", "4"))
MIN_TOKENS = int(os.environ.get("HR_MIN_TOKENS", "250"))


class CompressIn(BaseModel):
    messages: list[dict[str, Any]]
    model: str | None = None
    model_limit: int | None = None
    compress_user_messages: bool | None = None
    protect_recent: int | None = None
    target_ratio: float | None = None


@app.get("/health")
def health():
    return {"ok": True, "service": "headroom-compress"}


@app.post("/compress")
def do_compress(req: CompressIn):
    cfg = CompressConfig(
        compress_user_messages=COMPRESS_USER if req.compress_user_messages is None else req.compress_user_messages,
        protect_recent=PROTECT_RECENT if req.protect_recent is None else req.protect_recent,
        min_tokens_to_compress=MIN_TOKENS,
    )
    if req.target_ratio is not None:
        cfg.target_ratio = req.target_ratio

    kw = {}
    if req.model_limit:
        kw["model_limit"] = req.model_limit

    try:
        res = compress(req.messages, model=req.model or DEFAULT_MODEL, config=cfg, **kw)
    except Exception as e:  # never 500 the proxy — hand the messages back untouched
        return {
            "messages": req.messages,
            "stats": {"tokens_before": 0, "tokens_after": 0, "tokens_saved": 0,
                      "compression_ratio": 0.0, "transforms_applied": [], "error": str(e)},
        }

    return {
        "messages": res.messages,
        "stats": {
            "tokens_before": res.tokens_before,
            "tokens_after": res.tokens_after,
            "tokens_saved": res.tokens_saved,
            "compression_ratio": res.compression_ratio,
            "transforms_applied": res.transforms_applied,
        },
    }
