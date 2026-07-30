"""Static bearer middleware with shallow + deep health endpoints.

Routes:
  /healthz       — liveness (200 if the wrapper process is up). Used by the
                   container HEALTHCHECK so Coolify doesn't roll back during
                   slow MCP startup.
  /healthz/deep  — readiness (200 if the wrapped FastMCP app responds to an
                   MCP `initialize` request). Returns 503 with diagnostic JSON
                   if the in-process MCP cannot serve. For monitoring, not for
                   container orchestration.
  *              — checks Authorization: Bearer $STATIC_BEARER, then forwards.
"""
from __future__ import annotations
import asyncio
import hmac
import json
import os
from starlette.types import ASGIApp, Receive, Scope, Send

STATIC_BEARER = os.environ.get("STATIC_BEARER", "ddash")

_HEALTHZ_BODY = b'{"status":"ok"}'
_HEALTHZ_HEADERS = [
    (b"content-type", b"application/json"),
    (b"content-length", str(len(_HEALTHZ_BODY)).encode()),
]


def _json_response(status: int, payload: dict) -> tuple[dict, dict]:
    body = json.dumps(payload).encode()
    return (
        {"type": "http.response.start", "status": status,
         "headers": [(b"content-type", b"application/json"),
                     (b"content-length", str(len(body)).encode())]},
        {"type": "http.response.body", "body": body},
    )


async def _probe_mcp_initialize(app: ASGIApp, mcp_path: str = "/mcp") -> tuple[int, str]:
    """Invoke the wrapped ASGI app with a synthesized MCP `initialize` POST.

    Returns (status_code, response_body). Does not open a socket — we drive
    the ASGI protocol in-process.
    """
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "healthz", "version": "0"},
        },
    }).encode()

    scope: Scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": mcp_path,
        "raw_path": mcp_path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"127.0.0.1"),
            (b"content-type", b"application/json"),
            (b"accept", b"application/json, text/event-stream"),
            (b"content-length", str(len(body)).encode()),
            # Bypass our own bearer check by presenting the static bearer.
            (b"authorization", f"Bearer {STATIC_BEARER}".encode()),
        ],
        "client": ("127.0.0.1", 0),
        "server": ("127.0.0.1", 0),
    }

    received = False

    async def receive() -> dict:
        nonlocal received
        if not received:
            received = True
            return {"type": "http.request", "body": body, "more_body": False}
        # FastMCP's streamable-http transport keeps the connection open and
        # may await further receives. We never want to feed it more, but
        # returning `http.disconnect` immediately makes it cancel the
        # response mid-stream. Block forever; the asyncio.wait_for timeout
        # below caps the overall probe duration.
        await asyncio.Future()
        return {"type": "http.disconnect"}  # unreachable

    captured = {"status": 0, "body": bytearray(), "done": False}

    async def send(msg: dict) -> None:
        if msg["type"] == "http.response.start":
            captured["status"] = msg["status"]
        elif msg["type"] == "http.response.body":
            captured["body"].extend(msg.get("body", b""))
            if not msg.get("more_body", False):
                captured["done"] = True

    async def _drive() -> None:
        # Run the app; once we see a complete response body, we're done —
        # cancel the task so we don't wait for the SSE stream to close.
        task = asyncio.create_task(app(scope, receive, send))
        while not task.done():
            if captured["done"]:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
                return
            await asyncio.sleep(0.05)

    try:
        await asyncio.wait_for(_drive(), timeout=5.0)
    except asyncio.TimeoutError:
        return (504, f"timeout (status={captured['status']}, partial={len(captured['body'])}B)")
    except Exception as e:
        return (500, f"{type(e).__name__}: {e}")
    return (captured["status"], bytes(captured["body"]).decode("utf-8", "replace"))


class BearerMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path in ("/healthz", "/health"):
                await send({"type": "http.response.start", "status": 200, "headers": _HEALTHZ_HEADERS})
                await send({"type": "http.response.body", "body": _HEALTHZ_BODY})
                return
            if path == "/healthz/deep":
                status, snippet = await _probe_mcp_initialize(self.app)
                # 200/202 with a JSON-RPC `result` ⇒ healthy. Anything else ⇒ 503.
                ok = (200 <= status < 300) and ('"result"' in snippet)
                payload = {
                    "status": "ok" if ok else "down",
                    "upstream_status": status,
                    "upstream_snippet": snippet[:300],
                }
                start, body_msg = _json_response(200 if ok else 503, payload)
                await send(start)
                await send(body_msg)
                return
            if path == "/healthz/e2e":
                try:
                    import importlib, sys
                    import _e2e_probe as _probe_mod  # type: ignore[import]
                    importlib.reload(_probe_mod)
                    result = await asyncio.get_event_loop().run_in_executor(
                        None, _probe_mod.probe
                    )
                except Exception as exc:
                    result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
                ok = bool(result.get("ok"))
                start, body_msg = _json_response(200 if ok else 503, result)
                await send(start)
                await send(body_msg)
                return
            # OAuth discovery probes from MCP clients (Claude Code, etc.). We
            # use static bearer auth, not OAuth — return a clean JSON 404 so
            # the client falls back gracefully instead of choking on the
            # bearer-auth 401 our middleware would otherwise emit.
            if path.startswith("/.well-known/oauth-"):
                body = b'{"error":"oauth_not_supported"}'
                await send({"type": "http.response.start", "status": 404,
                            "headers": [(b"content-type", b"application/json"),
                                        (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
            # /fleet is the human dashboard — accept the bearer as a `?k=` query
            # param too, so it opens in a browser (https://…/fleet?k=ddash) without
            # a header. Header bearer still works; anything else 401s.
            if path == "/fleet":
                from urllib.parse import parse_qs
                headers = dict(scope.get("headers", []))
                auth = headers.get(b"authorization", b"").decode()
                hdr = auth.split(" ", 1)[1].strip() if auth.lower().startswith("bearer ") else ""
                key = (parse_qs(scope.get("query_string", b"").decode()).get("k") or [""])[0]
                presented = hdr or key
                if STATIC_BEARER and presented and hmac.compare_digest(presented, STATIC_BEARER):
                    await self.app(scope, receive, send)
                    return
                body = b'{"error":"unauthorized"}'
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"application/json"),
                                        (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
            if path not in ("/",):
                headers = dict(scope.get("headers", []))
                auth = headers.get(b"authorization", b"").decode()
                presented = auth.split(" ", 1)[1].strip() if auth.lower().startswith("bearer ") else ""
                if not (STATIC_BEARER and presented and hmac.compare_digest(presented, STATIC_BEARER)):
                    body = json.dumps({"error": "unauthorized"}).encode()
                    await send({"type": "http.response.start", "status": 401,
                                "headers": [(b"content-type", b"application/json"),
                                            (b"content-length", str(len(body)).encode()),
                                            (b"www-authenticate", b'Bearer realm="mcp"')]})
                    await send({"type": "http.response.body", "body": body})
                    return
        await self.app(scope, receive, send)
