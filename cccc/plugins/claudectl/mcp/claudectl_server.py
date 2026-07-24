"""claudectl MCP — the typed facade over the llm.hostbun.cc router control plane.

The router (repo `llm-hostbun-router`, this file lives in its `cccc/` subdir) is
the ONLY middleman between our code and a model: one OpenAI-compatible base URL
(`https://llm.hostbun.cc/v1`) that picks the provider from the model id —
`local` (llama.cpp on pbox) | `claudecode` (the Claude Max account pool →
api.anthropic.com) | `crazyrouter` (cloud relay, per token).

Every tool here drives the router's cookie-gated JSON control plane at
`https://llm.hostbun.cc/api/*` (login: POST /api/login {"password":
ADMIN_PASSWORD}, default ddash). `claude.hostbun.cc` — the old claudebox
wrapper — is RETIRED and DNS-dead; its `/v1/accounts/*` and `/ui/*` APIs are
gone forever. The account tools now manage the router's own
`claudecodeAccountPool`: tokens live server-side in the router's
/data/config.json and are NEVER revealed back out — import/rotate only.

Invariants the router enforces (do not design around them):
  * one project → one account, no rotation — account selection is a
    server-side pin (`proxy_pin` / `account_switch`), headers never override.
  * NO fallback: a 429 is a spent usage window, a 403 permission_error is a
    dead (OAuth-disabled) login, and the caller is told either way.

Tool groups:
  * account tools (accounts_list, live_limits, window_status, account_add,
    account_delete, account_switch, usage_today, fleet_presence, models_list)
    — the Claude Max pool + its 5h/7d usage windows.
  * proxy_* tools — routing config, pins/routes, health, model catalog,
    stats and the Postgres call log.

Fleet presence (HTTP transport only): each box's statusline POSTs its verified
account to /presence on the deployed server (claudectl.hostbun.cc); GET
/presence + GET /fleet render the cross-machine view.

Env (Coolify / local):
  STATIC_BEARER       — bearer _auth.py checks on inbound MCP calls (default ddash)
  LLM_PROXY_BASE      — router base URL (default https://llm.hostbun.cc)
  ADMIN_PASSWORD      — router admin password (default ddash)
  CLAUDECTL_PRESENCE_URL — remote presence feed merged in stdio mode
                        (default https://claudectl.hostbun.cc/presence)
  CCCC_MACHINE        — this box's consumer name (account_switch default)
  CLAUDECTL_TRANSPORT — stdio | http (default stdio)
  PORT                — when http (default 8000)
"""
from __future__ import annotations

import html as _html
import json
import logging
import os
import socket
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------- config
# llm.hostbun.cc is the llm-hostbun-router (Node). Its /api/* control surface is
# cookie-gated by a password login (default ddash).
LLM_PROXY_BASE = os.environ.get("LLM_PROXY_BASE", "https://llm.hostbun.cc").rstrip("/")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "ddash")
TRANSPORT = os.environ.get("CLAUDECTL_TRANSPORT", "stdio").lower()
HTTP_TIMEOUT = float(os.environ.get("CLAUDECTL_TIMEOUT", "45"))
# The deployed claudectl server hosts the presence registry; a local (stdio)
# instance merges that remote feed into fleet_presence.
PRESENCE_URL = os.environ.get(
    "CLAUDECTL_PRESENCE_URL", "https://claudectl.hostbun.cc/presence").rstrip("/")

log = logging.getLogger("claudectl")
if not log.handlers:
    h = logging.StreamHandler(sys.stderr)
    h.setFormatter(logging.Formatter("[claudectl] %(asctime)s %(levelname)s %(message)s"))
    log.addHandler(h)
log.setLevel(logging.INFO)

mcp = FastMCP("claudectl", host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))


# ---------------------------------------------------------------- router call
# One session cookie module-wide; re-login lazily on 401.
_proxy_cookie: Optional[str] = None


async def _proxy_login(client: httpx.AsyncClient) -> Optional[str]:
    r = await client.post(f"{LLM_PROXY_BASE}/api/login",
                          json={"password": ADMIN_PASSWORD})
    if r.status_code == 200:
        return r.headers.get("set-cookie", "").split(";")[0] or None
    return None


async def _proxy_call(method: str, sub: str, body: Optional[dict] = None,
                      params: Optional[dict] = None) -> dict:
    """One call to the router's /api/<sub>, logging in if needed."""
    global _proxy_cookie
    url = f"{LLM_PROXY_BASE}/api/{sub}"
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True) as c:
        for attempt in (1, 2):
            headers = {"Accept": "application/json"}
            if _proxy_cookie:
                headers["Cookie"] = _proxy_cookie
            try:
                if method == "GET":
                    r = await c.get(url, headers=headers, params=params or {})
                else:
                    r = await c.post(url, headers=headers, json=body or {})
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
            if r.status_code == 401 and attempt == 1:
                _proxy_cookie = await _proxy_login(c)
                if not _proxy_cookie:
                    return {"ok": False, "error": "admin login failed (bad ADMIN_PASSWORD?)"}
                continue
            try:
                data = r.json()
            except Exception:  # noqa: BLE001
                data = {"raw": r.text[:2000]}
            if isinstance(data, dict):
                data.setdefault("http_status", r.status_code)
                return data
            return {"http_status": r.status_code, "data": data}
    return {"ok": False, "error": "unreachable"}


def _default_consumer() -> str:
    """This box's consumer name: CCCC_MACHINE env, then the
    ~/.claude-accounts/.cccc-machine file, then the short hostname."""
    c = os.environ.get("CCCC_MACHINE", "").strip()
    if not c:
        try:
            with open(os.path.expanduser("~/.claude-accounts/.cccc-machine")) as f:
                c = f.read().strip()
        except OSError:
            c = ""
    if not c:
        c = socket.gethostname().split(".")[0].strip()
    return c.lower()


def _iso(epoch: Any) -> Optional[str]:
    """Epoch seconds → ISO-8601 UTC, or None."""
    if not isinstance(epoch, (int, float)) or epoch <= 0:
        return None
    try:
        return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat(timespec="seconds")
    except (OverflowError, OSError, ValueError):
        return None


def _pct(frac: Any) -> Optional[float]:
    """Router utilization is a 0..1 fraction; return 0..100 or None (no reading)."""
    if isinstance(frac, (int, float)):
        return round(frac * 100, 1)
    return None


# ---------------------------------------------------------------- account tools
@mcp.tool()
async def accounts_list() -> dict:
    """Every Claude Max account in the router's pool (GET /api/accounts).

    Rich per-account view: name, Anthropic org id, the projects PINNED to it,
    harvested `limits` (5h/7d utilization 0..1, reset epochs, status — `null`
    means "no reading yet", NEVER 0%), and per-account spend from the call log
    (calls/tokens lifetime + 24h, rate_limited/error counts). Also returns
    `orphanPins` (projects pinned to an account no longer in the pool) and
    `defaultAccount`. Tokens are server-side only and never included.
    """
    return await _proxy_call("GET", "accounts")


@mcp.tool()
async def live_limits(account: str = "") -> dict:
    """THE live ground-truth usage-window read (POST /api/claudecode/limits).

    The router pings each subscription ONCE (claude-haiku-4-5, max_tokens:1 —
    costs 1 token per account) purely to pull fresh
    `anthropic-ratelimit-unified-*` headers. Pass `account` for one account
    (returns {reading:{u5,u7,reset5,reset7,s5,s7,...}} — utilization 0..1,
    resets epoch s — or reading:null with status/errType saying why); omit it
    to sweep the whole pool ({accounts:[...], checkedAt}).

    Reading the failure modes: a 429 means the window is SPENT — wait for
    `reset`, the account is fine. A 403 `permission_error` ("OAuth
    authentication is currently not allowed…") is a DEAD login — the
    subscription itself is disabled; no reset fixes it, re-pin its projects.
    Prefer the free harvested numbers (accounts_list / window_status) unless
    you need truth for an idle or possibly-refunded account.
    """
    a = (account or "").strip()
    body: dict[str, Any] = {"account": a} if a else {"all": True}
    return await _proxy_call("POST", "claudecode/limits", body)


@mcp.tool()
async def window_status() -> dict:
    """Per-account 5h/7d usage-window summary from the router's HARVESTED
    readings (GET /api/accounts — free, no probe).

    For each account: 5h and 7d utilization % + reset times (ISO + epoch) and
    status. Harvested off real traffic headers, so an IDLE account keeps its
    last reading and `limits: null` means "no reading" — never 0%; use
    `live_limits` when you need current truth for an idle account.
    """
    data = await _proxy_call("GET", "accounts")
    if not isinstance(data, dict) or not isinstance(data.get("accounts"), list):
        return data if isinstance(data, dict) else {"ok": False, "error": "bad payload"}
    out = []
    for a in data["accounts"]:
        lim = a.get("limits") if isinstance(a.get("limits"), dict) else None
        row: dict[str, Any] = {"name": a.get("name"), "projects": a.get("projects") or []}
        if lim is None:
            row.update({"reading": None,
                        "note": "no harvested reading (idle account?) — not 0%; use live_limits"})
        else:
            row.update({
                "u5_pct": _pct(lim.get("u5")), "reset5_at": _iso(lim.get("reset5")),
                "u7_pct": _pct(lim.get("u7")), "reset7_at": _iso(lim.get("reset7")),
                "reset5": lim.get("reset5"), "reset7": lim.get("reset7"),
                "status": lim.get("status"), "s5": lim.get("s5"), "s7": lim.get("s7"),
                "reading_ts": lim.get("ts"),
            })
        out.append(row)
    out.sort(key=lambda r: -(r.get("u5_pct") or 0))
    return {"accounts": out, "defaultAccount": data.get("defaultAccount", ""),
            "orphanPins": data.get("orphanPins") or [],
            "note": "harvested off real traffic — limits:null = no reading, never 0%"}


@mcp.tool()
async def account_add(name: str, token: str, email: str = "") -> dict:
    """Create, import, or rotate ONE pool account (POST /api/accounts/token).

    `token` must be a Claude Max setup-token (`sk-ant-oat…`, from
    `claude setup-token`); whitespace (a line-wrapped paste) is stripped
    server-side. The router stores it in /data/config.json (the ONLY copy
    anywhere) and NEVER reveals it back out; there is no read/export endpoint.
    Merge-safe: other accounts' tokens are untouched.

    Create-if-absent: an existing name rotates its token; a NEW name is ADDED
    to the pool (the only create path — POST config replaces the pool
    wholesale). `email` is an optional human label for which Anthropic login
    this is (and updates it on an existing account).
    """
    body: dict[str, Any] = {"account": name, "token": token}
    if email:
        body["email"] = email
    return await _proxy_call("POST", "accounts/token", body)


@mcp.tool()
async def account_disable(name: str, disabled: bool = True) -> dict:
    """Disable / re-enable ONE pool account (POST /api/accounts/disable).

    A disabled account is NEVER routed to: any project pinned to it gets the
    honest `403 no_account_for_project` (re-pin it) instead of the router
    hammering a dead/retired subscription. Keeps the token (unlike
    account_delete, which is irreversible) — flip `disabled=False` to revive.
    Returns `stranded`: the projects now pinned to a disabled account that
    must be re-pinned. Use this for a cancelled/OAuth-disabled login you want
    the router to stop trying.
    """
    return await _proxy_call("POST", "accounts/disable",
                             {"account": name, "disabled": disabled})


@mcp.tool()
async def account_delete(name: str, force: bool = False) -> dict:
    """Remove ONE account from the router's pool (POST /api/accounts/remove).

    IRREVERSIBLE: the pool holds the only copy of the token — there is no
    backup and no reveal, so re-adding needs a fresh `claude setup-token`.
    Refuses (409) if any project still pins the account, unless force=true
    which drops those pins too (they would otherwise 403
    no_account_for_project).
    """
    body: dict[str, Any] = {"account": name}
    if force:
        body["force"] = True
    return await _proxy_call("POST", "accounts/remove", body)


@mcp.tool()
async def account_switch(account: str, consumer: str = "") -> dict:
    """Switch which pool account THIS box bills to, by re-pinning its consumers
    (two merge-safe POST /api/pins calls: `<consumer>` and `<consumer>-claude`).

    `consumer` defaults to this box's name (CCCC_MACHINE env →
    ~/.claude-accounts/.cccc-machine → short hostname, lowercased). Account
    selection is a SERVER-SIDE pin — there is no "active account" and no
    header override; other projects' pins are untouched. The router rejects an
    unknown account name. Note: `<consumer>-claude` covers the local Claude
    Code route (e.g. pmac-claude).
    """
    acct = (account or "").strip()
    cons = (consumer or "").strip().lower() or _default_consumer()
    targets = [cons, f"{cons}-claude"]
    results = {}
    for t in targets:
        results[t] = await _proxy_call("POST", "pins", {"project": t, "account": acct})
    ok = all(isinstance(r, dict) and r.get("ok") for r in results.values())
    return {"ok": ok, "account": acct, "pinned": targets, "results": results}


@mcp.tool()
async def usage_today(window: str = "24h") -> dict:
    """What ran through the Claude Max pool over `window` (GET /api/stats).

    Returns the claudecode provider rows (old call-log rows carry
    provider='anthropic', new ones 'claudecode' — both are counted) plus
    by_model / by_project token breakdowns and the router totals. window ∈
    15m|1h|6h|24h|7d|30d|all. For per-ACCOUNT spend and window headroom use
    `accounts_list` — its usage/limits fields carry the account split.
    """
    stats = await _proxy_call("GET", "stats", params={"window": window})
    if not isinstance(stats, dict):
        return {"ok": False, "error": "bad payload"}
    cc = [p for p in (stats.get("byProvider") or [])
          if isinstance(p, dict) and p.get("provider") in ("claudecode", "anthropic")]
    return {
        "window": window,
        "claudecode": cc,
        "by_model": stats.get("byModel"),
        "by_project": stats.get("byProject"),
        "premium_usage": stats.get("premiumUsage"),   # apps using opus/fable on the shared pool
        "router_totals": {k: stats.get(k) for k in
                          ("windowCalls", "windowTokens", "windowPromptTokens",
                           "windowCompletionTokens", "windowErrors", "windowCost")},
        "note": "per-account spend/headroom lives on accounts_list (usage + limits fields)",
    }


@mcp.tool()
async def models_list() -> dict:
    """All model ids the router serves, across every provider
    (GET https://llm.hostbun.cc/v1/models — public, no auth)."""
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True) as c:
            r = await c.get(f"{LLM_PROXY_BASE}/v1/models",
                            headers={"Accept": "application/json"})
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    try:
        data = r.json()
    except Exception:  # noqa: BLE001
        data = {"raw": r.text[:2000]}
    if isinstance(data, dict):
        data.setdefault("http_status", r.status_code)
        return data
    return {"http_status": r.status_code, "data": data}


# ---------------------------------------------------------------- proxy_* tools
@mcp.tool()
async def proxy_state() -> dict:
    """Full routing config of the llm.hostbun.cc router (GET /api/state).

    Returns the live CFG: providers (local | claudecode | crazyrouter),
    per-provider bases, forceModel (global override), modelRoutes (per-model
    provider pins), projectRoutes/projectGroups, projectAccounts (account
    pins), projectLimits, cloudPolicy + cloudAllowlist, defaultRoute,
    jsonEnforce, logging, auth mode, and masked secret flags. This is the
    'what does this router do right now' view.
    """
    return await _proxy_call("GET", "state")


@mcp.tool()
async def proxy_health() -> dict:
    """Live health of the router's three providers (GET /api/health).
    Probes local (llama.cpp on pbox) and crazyrouter; claudecode health is
    "do we hold accounts" (an unauthenticated probe would read as down).
    Returns {up,status,ms,count?,error?} per provider."""
    return await _proxy_call("GET", "health")


@mcp.tool()
async def proxy_models() -> dict:
    """Merged model catalog per provider (GET /api/models) — local +
    claudecode + crazyrouter — i.e. every model id the router can route,
    grouped by provider."""
    return await _proxy_call("GET", "models")


@mcp.tool()
async def proxy_resolve(model: str, project: Optional[str] = None) -> dict:
    """Dry-run: show exactly which provider `model` routes to, WITHOUT calling
    the upstream (POST /api/resolve). Returns provider, sentModel, reason,
    whether it's blocked/gated, and the target base. Use to debug routing."""
    return await _proxy_call("POST", "resolve", {"model": model, "project": project or ""})


@mcp.tool()
async def proxy_test(model: str, prompt: Optional[str] = None,
                     max_tokens: Optional[int] = None) -> dict:
    """Route AND call `model` through the router end-to-end (POST /api/test)
    — verifies the provider actually answers. Returns the routed provider +
    the reply. NB: a claudecode test spends real subscription window."""
    body: dict[str, Any] = {"model": model}
    if prompt is not None:
        body["prompt"] = prompt
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    return await _proxy_call("POST", "test", body)


@mcp.tool()
async def proxy_stats(window: str = "24h") -> dict:
    """Usage stats over `window` (GET /api/stats) — window ∈
    15m|1h|6h|24h|7d|30d|all. Returns call/token/error/cost totals plus
    breakdowns byProvider, byModel, byProject, byClient, byKey (with $
    estimates for crazyrouter, the only per-token provider)."""
    return await _proxy_call("GET", "stats", params={"window": window})


@mcp.tool()
async def proxy_calls(limit: int = 30, q: Optional[str] = None,
                      provider: Optional[str] = None, model: Optional[str] = None,
                      project: Optional[str] = None,
                      status: Optional[str] = None) -> dict:
    """Recent router call log (GET /api/calls) — the real-time debug feed,
    backed by Postgres. Filters: q (search model/ip/ua/prompt/reply),
    provider (local|claudecode|crazyrouter; old rows may carry 'anthropic'),
    model, project, status ('ok'|'error'|code). Each row shows the full
    picture of a call: routing (provider, req_model→sent_model, key_label),
    which project, timing (duration_ms), token usage, the request knobs
    (effort, thinking_tokens, max_tokens, temperature, stream), and
    req_preview/resp_preview content. limit≤500."""
    params: dict[str, Any] = {"limit": limit}
    for k, v in (("q", q), ("provider", provider), ("model", model),
                 ("project", project), ("status", status)):
        if v:
            params[k] = v
    return await _proxy_call("GET", "calls", params=params)


@mcp.tool()
async def proxy_limits() -> dict:
    """Harvested per-account usage-window snapshot (GET /api/limits), read for
    FREE off the `anthropic-ratelimit-unified-*` response headers of real
    claudecode traffic — no probe, zero tokens, unlike `live_limits` which
    spends 1 token per account. Returns one row per Anthropic org id:
    {org_id, account, ts (last seen), u5/u7 (5h/7d utilization 0..1),
    reset5/reset7 (epoch s), status/s5/s7, project, model}. Rows go stale for
    accounts with no recent traffic (ts shows freshness); a missing row is
    "no reading", never 0%. `accounts_list` gives the same data already
    joined to account names."""
    return await _proxy_call("GET", "limits")


@mcp.tool()
async def proxy_pin(project: str, account: str = "") -> dict:
    """Pin ONE project to ONE pool account (POST /api/pins) — merge-safe:
    every other project's pin is untouched, and an unknown account name is
    rejected. Empty `account` CLEARS the pin (the project then 403s
    no_account_for_project on claudecode). This is the safe door — POST
    /api/config (proxy_config) REPLACES the whole projectAccounts map, so a
    single-pin edit through it deletes every other pin. A pin on `promopilot`
    also covers every job path (`promopilot:generatetext`)."""
    body: dict[str, Any] = {"project": project, "account": (account or "").strip()}
    return await _proxy_call("POST", "pins", body)


@mcp.tool()
async def proxy_route(project: str, provider: str = "", model: str = "",
                      allow_providers: Optional[list[str]] = None,
                      allow_models: Optional[list[str]] = None,
                      block: bool = False, clear: bool = False) -> dict:
    """Set or clear ONE project's routing rule (POST /api/routes) —
    merge-safe: every other project's rule is untouched. Unlike POST
    /api/config (proxy_config), which REPLACES the whole projectRoutes map.

    Two independent axes: provider(+model) is the PIN (rewrites the request);
    allow_providers/allow_models is the ALLOWLIST (refuses with 400 blocked on
    mismatch — never substitutes). An empty/absent list = no restriction,
    never "nothing allowed". block=true rejects every call; clear=true
    returns the project to auto routing. Providers: local | claudecode |
    crazyrouter. Rules resolve exact path → consumer → group, so a rule on
    `promopilot` covers `promopilot:generatetext`."""
    body: dict[str, Any] = {"project": project}
    if clear:
        body["clear"] = True
    elif block:
        body["block"] = True
    else:
        if provider:
            body["provider"] = provider
        if model:
            body["model"] = model
        if allow_providers:
            body["allowProviders"] = allow_providers
        if allow_models:
            body["allowModels"] = allow_models
    return await _proxy_call("POST", "routes", body)


@mcp.tool()
async def proxy_config(patch: dict) -> dict:
    """Live-edit the router config (POST /api/config) — applies instantly,
    persists to /data/config.json, no redeploy.

    `patch` carries only the keys you want to change. Common ones:
      forceModel:{enabled,provider,model} — force EVERY request to one place
      modelRoutes:{"<model>":{provider,rewriteModel?}} — pin a model
      cloudPolicy:"open"|"allowlist"|"off" + cloudAllowlist:[...] — crazyrouter gate
      defaultRoute:"local"|"claudecode"|"crazyrouter"
      projectLimits — per-project usage caps
      bases:{local,claudecode,crazyrouter} — upstream URLs
      jsonEnforce:bool, requireProject:bool, logging:{...}
      crazyrouterKey / adminPassword — secrets ("" clears, omit keeps, value sets)

    WARNING: this endpoint assigns projectRoutes and projectAccounts
    WHOLESALE — sending one entry deletes every other project's rule/pin. For
    single-key edits use proxy_route / proxy_pin (they merge). It never
    touches `consumers` (deliberately — a save without key hashes would wipe
    every API key). Fetch proxy_state() first to see current values.
    """
    return await _proxy_call("POST", "config", patch or {})


@mcp.tool()
async def proxy_reset_config() -> dict:
    """Reset the router config to its env defaults (POST /api/reset)
    — deletes the /data/config.json overlay. Destructive to custom routing,
    pins, and the account pool overlay. Use with extreme care."""
    return await _proxy_call("POST", "reset")


@mcp.tool()
async def proxy_clear_calls() -> dict:
    """Wipe the router's Postgres call log (POST /api/calls/clear).
    Irreversible — this is the audit trail behind stats/accounts spend."""
    return await _proxy_call("POST", "calls/clear")


# ---------------------------------------------------------------- fleet presence
# "Who is using what across the fleet." Each box's statusline knows, via a live
# Anthropic call, which account its LOCAL keychain token really is (the org-id ->
# account map). It POSTs that to the deployed server's /presence; that server
# keeps the latest per-machine and renders it — joined with the router's
# harvested per-account limits — as a JSON feed (for the cccc TUI) and an HTML
# page (GET /fleet). The router itself CANNOT provide this: it only knows its
# server-side pins, not which remote machine holds which local keychain token.
_PRESENCE_FILE = os.environ.get("PRESENCE_FILE", "/tmp/claudectl-presence.json")
_PRESENCE_STALE = int(os.environ.get("PRESENCE_STALE", "1800"))   # gray out after 30 min silent
_PRESENCE_EVICT = int(os.environ.get("PRESENCE_EVICT", "21600"))  # forget entirely after 6 h silent
_presence_lock = threading.Lock()


def _presence_load() -> dict:
    try:
        with open(_PRESENCE_FILE) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _presence_put(machine: str, account: str, org_id: str) -> None:
    machine = (machine or "").strip()[:64]
    if not machine:
        return
    with _presence_lock:
        d = _presence_load()
        now = time.time()
        d[machine] = {"account": (account or "").strip()[:64],
                      "org_id": (org_id or "").strip()[:64], "ts": now}
        # opportunistic prune: a box silent past the evict window is forgotten, so
        # decommissioned/renamed machines (e.g. an old hostname) drop off the page.
        d = {m: v for m, v in d.items() if now - (v.get("ts") or 0) <= _PRESENCE_EVICT}
        try:
            with open(_PRESENCE_FILE, "w") as f:
                json.dump(d, f)
        except OSError:
            pass


async def _presence_remote() -> dict:
    """Machines dict from the deployed presence registry. Only fetched in
    stdio mode — the deployed HTTP server IS that registry (fetching its own
    /presence from inside /presence would recurse)."""
    if TRANSPORT != "stdio" or not PRESENCE_URL:
        return {}
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as c:
            r = await c.get(PRESENCE_URL, headers={"Accept": "application/json"})
        d = r.json()
    except Exception:  # noqa: BLE001 — presence is best-effort
        return {}
    m = d.get("machines") if isinstance(d, dict) else None
    return m if isinstance(m, dict) else {}


@mcp.tool()
async def fleet_presence() -> dict:
    """Who's using what across the fleet: every machine's last-published
    account (each box's statusline verifies its OWN keychain token against
    Anthropic and reports it to the deployed registry), joined with the
    router's harvested per-account 5h/7d limits (null = no reading, never 0%).
    Returns {machines, accounts, orphan_machines} where each account lists the
    machines currently on it."""
    pres = dict(_presence_load())
    # merge the deployed registry (stdio mode: the fleet data lives there)
    for m, v in (await _presence_remote()).items():
        cur = pres.get(m)
        if not cur or (v.get("ts") or 0) >= (cur.get("ts") or 0):
            pres[m] = {"account": v.get("account", ""), "org_id": v.get("org_id", ""),
                       "ts": v.get("ts") or 0}
    now = time.time()
    machines = {m: {**v, "age_s": round(now - (v.get("ts") or 0)),
                    "stale": (now - (v.get("ts") or 0)) > _PRESENCE_STALE}
                for m, v in pres.items()
                if now - (v.get("ts") or 0) <= _PRESENCE_EVICT}   # forget long-silent boxes
    by_acct: dict[str, list] = {}
    for m, v in machines.items():
        by_acct.setdefault(v.get("account") or "?", []).append(m)
    # join with the router's pool + harvested limits
    ra = await _proxy_call("GET", "accounts")
    acct_objs = [a for a in (ra.get("accounts") or []) if isinstance(a, dict) and a.get("name")] \
        if isinstance(ra, dict) else []
    names = [a["name"] for a in acct_objs]
    accounts = []
    for a in acct_objs:
        lim = a.get("limits") if isinstance(a.get("limits"), dict) else {}
        accounts.append({
            "name": a["name"],
            "five_hour_pct": _pct(lim.get("u5")), "five_hour_resets_at": _iso(lim.get("reset5")),
            "seven_day_pct": _pct(lim.get("u7")), "seven_day_resets_at": _iso(lim.get("reset7")),
            "projects": a.get("projects") or [],
            "machines": sorted(by_acct.get(a["name"], [])),
        })
    orphan = sorted(m for m, v in machines.items()
                    if (v.get("account") or "?") not in names)
    return {"machines": machines, "accounts": accounts, "orphan_machines": orphan,
            "note": "machine.account is API-verified by that box; limits are the router's "
                    "harvested readings (null = no reading, never 0%)"}


def _fleet_html(data: dict) -> str:
    """Render fleet_presence() as a self-contained auto-refreshing HTML page."""
    def esc(x):
        return _html.escape(str(x))

    def bar(pct):
        p = pct if isinstance(pct, (int, float)) else None
        if p is None:
            return '<span class="dim">—</span>'
        col = "g" if p < 50 else "y" if p < 80 else "r"
        return (f'<span class="bar"><span class="fill {col}" style="width:{min(100, p):.0f}%"></span></span>'
                f'<span class="pct">{p:.0f}%</span>')

    def ago(s):
        if not isinstance(s, (int, float)):
            return ""
        s = int(s)
        return f"{s}s" if s < 60 else f"{s // 60}m" if s < 3600 else f"{s // 3600}h"

    rows = []
    for a in data.get("accounts", []):
        machs = a.get("machines") or []
        mtags = " ".join(f'<span class="mach">{esc(m)}</span>' for m in machs) or '<span class="dim">— idle —</span>'
        rows.append(f"""
        <tr>
          <td class="acct">{esc(a['name'])}</td>
          <td>{bar(a.get('five_hour_pct'))}</td>
          <td>{bar(a.get('seven_day_pct'))}</td>
          <td class="machs">{mtags}</td>
        </tr>""")
    orphans = data.get("orphan_machines") or []
    orow = ""
    if orphans:
        tags = " ".join(f'<span class="mach warn">{esc(m)}</span>' for m in orphans)
        orow = f'<p class="orphan">⚠ machines on an unknown/removed account: {tags}</p>'
    machines = data.get("machines", {})
    seen = (f'<p class="dim">{len(machines)} machine(s) reporting · '
            f'auto-refresh 15s · limits harvested by the router ("—" = no reading, never 0%)</p>')
    # per-machine last-seen footnote
    foot = " · ".join(
        f'{esc(m)}<span class="dim">{("→" + esc(v.get("account"))) if v.get("account") else ""} '
        f'{ago(v.get("age_s"))} ago{" (stale)" if v.get("stale") else ""}</span>'
        for m, v in sorted(machines.items()))
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>claudectl · fleet</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background:#0d1117; color:#e6edf3; margin:0; padding:28px; }}
  h1 {{ font-size:16px; margin:0 0 4px; font-weight:600; }}
  h1 .sub {{ color:#7d8590; font-weight:400; font-size:13px; }}
  table {{ border-collapse:collapse; width:100%; max-width:820px; margin-top:16px; }}
  th {{ text-align:left; font-weight:600; color:#7d8590; font-size:12px;
        text-transform:uppercase; letter-spacing:.04em; padding:6px 12px 6px 0; }}
  td {{ padding:9px 12px 9px 0; border-top:1px solid #21262d; vertical-align:middle; }}
  .acct {{ font-weight:600; white-space:nowrap; }}
  .bar {{ display:inline-block; width:90px; height:8px; border-radius:4px;
          background:#21262d; overflow:hidden; vertical-align:middle; margin-right:8px; }}
  .fill {{ display:block; height:100%; }}
  .fill.g {{ background:#3fb950; }} .fill.y {{ background:#d29922; }} .fill.r {{ background:#f85149; }}
  .pct {{ font-variant-numeric:tabular-nums; color:#c9d1d9; }}
  .mach {{ display:inline-block; background:#1f6feb33; color:#79c0ff; border:1px solid #1f6feb55;
           border-radius:5px; padding:1px 8px; margin:2px 3px 2px 0; font-size:13px; }}
  .mach.warn {{ background:#f8514922; color:#ff7b72; border-color:#f8514955; }}
  .dim {{ color:#7d8590; }} .orphan {{ margin-top:14px; }}
  footer {{ margin-top:22px; color:#7d8590; font-size:12px; max-width:820px; }}
</style></head><body>
  <h1>claudectl · fleet <span class="sub">— who's using what</span></h1>
  {seen}
  <table>
    <tr><th>account</th><th>5h used</th><th>7d used</th><th>machines on it</th></tr>
    {''.join(rows)}
  </table>
  {orow}
  <footer>last seen — {foot or '<span class="dim">none</span>'}</footer>
</body></html>"""


def _install_fleet_routes(app) -> None:
    """Attach the presence feed + HTML page to the FastMCP Starlette app."""
    from starlette.requests import Request
    from starlette.responses import HTMLResponse, JSONResponse

    async def presence_post(request: Request):
        try:
            b = await request.json()
        except Exception:  # noqa: BLE001
            b = {}
        if not (b.get("machine") or "").strip():
            return JSONResponse({"error": "machine required"}, status_code=400)
        _presence_put(b.get("machine", ""), b.get("account", ""), b.get("org_id", ""))
        return JSONResponse({"ok": True})

    async def presence_get(request: Request):
        return JSONResponse(await fleet_presence())

    async def fleet_page(request: Request):
        return HTMLResponse(_fleet_html(await fleet_presence()))

    app.add_route("/presence", presence_post, methods=["POST"])
    app.add_route("/presence", presence_get, methods=["GET"])
    app.add_route("/fleet", fleet_page, methods=["GET"])


if __name__ == "__main__":
    if TRANSPORT == "stdio":
        mcp.run(transport="stdio")
    else:
        import uvicorn
        from _auth import BearerMiddleware
        app = mcp.streamable_http_app()
        _install_fleet_routes(app)
        uvicorn.run(
            BearerMiddleware(app),
            host="0.0.0.0",
            port=int(os.environ.get("PORT", "8000")),
        )
