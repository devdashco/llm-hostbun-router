"""E2E probe: hit GET /v1/models on the llm.hostbun.cc router (public, no auth).
200 = the router is reachable and serving, so bad wiring => Coolify rolls back
instead of shipping a broken server. (claude.hostbun.cc is retired — the old
/v1/accounts probe is gone with it.)"""
import os
import httpx

LLM_HOST = os.environ.get("LLM_HOST", "https://llm.hostbun.cc").rstrip("/")


def probe() -> dict:
    try:
        r = httpx.get(f"{LLM_HOST}/v1/models",
                      headers={"Accept": "application/json"},
                      timeout=20.0)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{LLM_HOST} unreachable: {type(e).__name__}: {e}"[:200]}
    if r.status_code != 200:
        return {"ok": False, "status": r.status_code,
                "error": f"/v1/models returned {r.status_code}"}
    try:
        models = r.json().get("data", []) or []
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"bad json: {e}"[:150]}
    return {"ok": True, "n_models": len(models),
            "ids": [m.get("id") for m in models][:20]}
