#!/usr/bin/env python3
"""claudectl TUI — a curses dashboard for the Claude Max account pool behind the
llm.hostbun.cc router (the ONLY gateway; claude.hostbun.cc is retired).

Drives the router's /api/* control plane, hands-on: watch every account's live
5h/7d usage + reset countdown, pin this box's account (server-side /api/pins),
run a live limit check — without leaving the terminal. Pure stdlib
(curses + urllib), no deps, runs anywhere.

Navigation is ARROWS + ENTER ONLY — no letter hotkeys. ←/→ switch the
tabs (Accounts · Windows · Plugins · Setup), ↑/↓ move within a tab, ↵ opens the
selected account's action menu (or runs the highlighted list action), q quits.
  Accounts — the pool: pin one to this box, live 5h/7d limits, remove.
  Windows  — restart / set model / broadcast to ALL your running claude windows.
  Setup    — maintain the cccc tool itself (health check, update).

Run:
  python3 claudectl_tui.py

Env:
  CCTL_LLM_ADMIN     the router (default https://llm.hostbun.cc)
  CCTL_LLM_PW        admin password (default ddash)
  CLAUDECTL_MCP      fleet-presence registry (default https://claudectl.hostbun.cc)
"""
from __future__ import annotations

import curses
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

# per-project plugin sets (Plugins tab) — pure-stdlib sibling module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plugin_profiles as pp  # noqa: E402

# --- local login (what interactive `claude` reads) -------------------------
# macOS: the live OAuth token lives in the login keychain, service
#   "Claude Code-credentials", account = the OS username. We swap its
#   claudeAiOauth block, preserving everything else (mcpOAuth etc).
# Linux/other: Claude Code stores it in ~/.claude/.credentials.json — same shape.
import getpass
KC_SVC = "Claude Code-credentials"
KC_ACCT = os.environ.get("CLAUDECTL_KC_ACCT") or (os.environ.get("USER") or getpass.getuser())
_IS_MAC = sys.platform == "darwin"
CRED_FILE = os.path.expanduser("~/.claude/.credentials.json")
# which account cccc last applied to the LOCAL login — the one every new `claude`
# launches with. This is the authoritative "ON" account (the gateway's own active
# drifts server-side and doesn't affect interactive claude).
STATE_FILE = os.path.expanduser("~/.claude-accounts/.cccc-local")


def _read_local_selected() -> str:
    try:
        return open(STATE_FILE).read().strip()
    except Exception:
        return ""


def _write_local_selected(name: str) -> None:
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as f:
            f.write(name)
    except Exception:
        pass


ACCT_EMAILS = {
    "philip": "philip@devdash.co", "william": "william@devdash.co",
    "emphyx": "shared@emphyx.se", "claudemejlto": "claude@mejl.to",
    "kontaktemhpx": "kontakt@emphyx.se",
}


def acct_email(name: str) -> str:
    """Owner email for an account. The hardcoded map first, then an override file
    `~/.claude-accounts/<name>.email` (drop the real address there for accounts not
    in the map — e.g. the claudemejlto/claude2mejlto twins). '' if unknown."""
    e = ACCT_EMAILS.get(name)
    if e:
        return e
    try:
        v = open(os.path.expanduser(f"~/.claude-accounts/{name}.email")).read().strip()
        return v if "@" in v else ""
    except OSError:
        return ""


def _consumer_name() -> str:
    """This box's consumer id for the middleware (the same name the fleet page uses):
    $CLAUDECTL_MACHINE → ~/.claude-accounts/.cccc-machine → short hostname → 'box'."""
    n = os.environ.get("CLAUDECTL_MACHINE", "").strip()
    if not n:
        try:
            n = open(os.path.expanduser("~/.claude-accounts/.cccc-machine")).read().strip()
        except OSError:
            n = ""
    if not n:
        import socket
        n = socket.gethostname().split(".")[0]
    return n or "box"


# header lines cccc owns on the proxy contract — rewritten on every switch, everything
# else in ANTHROPIC_CUSTOM_HEADERS is preserved. (x-lane / x-account / x-ccc-account =
# legacy: the router IGNORES account headers by design — invariant "no header can
# override the pin" — so we strip them on every rewrite and never emit them again.)
_MANAGED_HDRS = ("x-consumer:", "x-project:", "x-lane:", "x-account:", "x-ccc-account:")


def set_consumer_headers(account: str = "") -> bool:
    """Write THIS box's identity headers into
    ~/.claude/settings.json env.ANTHROPIC_CUSTOM_HEADERS:

        X-Consumer: <box>          who is calling (pmac/wmac/pbox) — attribution/logging
        X-Project:  <box>-claude   satisfies the router's requireProject gate

    ACCOUNT selection is NOT a header: the router picks the pool account from its
    server-side pin map (/api/pins) and explicitly ignores X-Account. `account` is
    accepted for call-site symmetry but unused. New claude launches pick the
    headers up; a running pane keeps its launch env until restart. Returns ok."""
    consumer = _consumer_name()
    p = os.path.expanduser("~/.claude/settings.json")
    try:
        d = json.load(open(p))
    except (OSError, json.JSONDecodeError):
        return False
    env = d.get("env")
    if not isinstance(env, dict):
        env = {}
        d["env"] = env
    raw = env.get("ANTHROPIC_CUSTOM_HEADERS", "") or ""
    # keep any header we don't manage; replace our whole managed set
    kept = [ln for ln in raw.replace("\\n", "\n").splitlines()
            if ln.strip() and not ln.lower().lstrip().startswith(_MANAGED_HDRS)]
    kept += [f"X-Consumer: {consumer}", f"X-Project: {consumer}-claude"]
    env["ANTHROPIC_CUSTOM_HEADERS"] = "\n".join(kept)
    try:
        tmp = p + ".tmp"
        json.dump(d, open(tmp, "w"), indent=2)
        os.replace(tmp, p)
        return True
    except OSError:
        return False


LLM_ADMIN = os.environ.get("CCTL_LLM_ADMIN", "https://llm.hostbun.cc").rstrip("/")
LLM_PW = os.environ.get("CCTL_LLM_PW", "ddash")


_ADMIN_COOKIE = os.path.expanduser("~/.claude/.cctl-admin-cookie")


def _llm_admin_opener():
    """A urllib opener seeded with the CACHED admin session cookie. The admin login
    endpoint throttles at >10 logins / 5 min PER IP — and the whole fleet shares one
    egress IP — so logging in on every switch trips it. We log in at most once per
    cookie lifetime (7 days) and reuse the cookie for state/config (which aren't
    throttled). Returns (opener, cookiejar)."""
    import http.cookiejar
    cj = http.cookiejar.MozillaCookieJar(_ADMIN_COOKIE)
    try:
        cj.load(ignore_discard=True, ignore_expires=True)
    except (OSError, http.cookiejar.LoadError):
        pass
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj


def _refresh_statusline_account() -> None:
    """Make the statusline reflect an account switch LIVE: delete its cached account
    resolution (~/.claude/.cctl-anthropic) and kick a fresh background resolve, so the
    very next render shows the newly-locked account instead of lagging ~40s for the
    normal refresh. Best-effort — never raises."""
    try:
        c = os.path.expanduser("~/.claude/.cctl-anthropic")
        if os.path.exists(c):
            os.remove(c)
    except OSError:
        pass
    try:
        sl = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "..", "statusline", "cccc-statusline.py")
        if os.path.exists(sl):
            subprocess.Popen([sys.executable, os.path.abspath(sl), "--anthropic-refresh"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             stdin=subprocess.DEVNULL, start_new_session=True)
    except Exception:  # noqa: BLE001
        pass


def gateway_set_lock(account: str, consumer: str = "") -> dict:
    """THE robust account switch: pin THIS box's consumer→account in the router's
    server-side pin map via POST /api/pins (llm.hostbun.cc). The router then bills every
    pane on this box to `account` LIVE — no restart. /api/pins MERGES one key and
    validates the account name; the old POST /api/config {consumerAccounts} path was a
    silent no-op for already-pinned consumers (the wholesale merge let the stale
    projectAccounts clone win). Uses a CACHED admin cookie so it doesn't re-login every
    switch (which would trip the per-IP login throttle). Returns {ok, error?}."""
    consumer = (consumer or _consumer_name()).lower()
    op, cj = _llm_admin_opener()

    def _apply():
        for proj in (consumer, f"{consumer}-claude"):   # panes may identify via either
            r = op.open(urllib.request.Request(f"{LLM_ADMIN}/api/pins",
                        data=json.dumps({"project": proj, "account": account}).encode(),
                        headers={"content-type": "application/json"}, method="POST"), timeout=10)
            if not bool(json.load(r).get("ok", False)):
                return False
        _refresh_statusline_account()   # so the statusline shows the new account LIVE
        return True

    # 1) try with the cached cookie (no login → no throttle)
    try:
        return {"ok": _apply()}
    except urllib.error.HTTPError as e:
        if e.code not in (401, 403):
            # /api/pins 400s with a useful body (e.g. unknown account + the pool names)
            try:
                detail = json.loads(e.read().decode()).get("error", "")
            except Exception:  # noqa: BLE001
                detail = ""
            return {"ok": False, "error": f"router HTTP {e.code}" + (f": {detail}" if detail else "")}
        # cookie missing/expired → fall through to a single login
    except Exception:
        pass
    # 2) log in once, cache the cookie, retry
    try:
        op.open(urllib.request.Request(f"{LLM_ADMIN}/api/login",
                data=json.dumps({"password": LLM_PW}).encode(),
                headers={"content-type": "application/json"}), timeout=10).read()
        try:
            os.makedirs(os.path.dirname(_ADMIN_COOKIE), exist_ok=True)
            cj.save(ignore_discard=True, ignore_expires=True)
            os.chmod(_ADMIN_COOKIE, 0o600)
        except OSError:
            pass
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return {"ok": False, "error": "admin login throttled — wait ~1 min and retry (fleet shares one IP)"}
        return {"ok": False, "error": f"admin login HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"admin login failed: {e}"}
    try:
        return {"ok": _apply()}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


def _llm_json(sub: str, timeout: float = 8):
    """GET llm.hostbun.cc/api/<sub> as JSON — the router is the ONLY gateway now.
    Reuses the cached admin cookie and logs in ONCE on 401/403 (the login endpoint
    throttles per-IP, and the fleet shares one egress). Never raises — returns
    {"error": ...} so the UI thread can't be frozen by a slow/dead gateway."""
    op, cj = _llm_admin_opener()

    def _get():
        with op.open(f"{LLM_ADMIN}/api/{sub}", timeout=timeout) as r:
            return json.loads(r.read().decode() or "{}")
    try:
        return _get()
    except urllib.error.HTTPError as e:
        if e.code not in (401, 403):
            return {"error": f"HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"[:120]}
    # cookie missing/expired → one login, cache it, retry
    try:
        op.open(urllib.request.Request(f"{LLM_ADMIN}/api/login",
                data=json.dumps({"password": LLM_PW}).encode(),
                headers={"content-type": "application/json"}), timeout=timeout).read()
        try:
            os.makedirs(os.path.dirname(_ADMIN_COOKIE), exist_ok=True)
            cj.save(ignore_discard=True, ignore_expires=True)
            os.chmod(_ADMIN_COOKIE, 0o600)
        except OSError:
            pass
    except urllib.error.HTTPError as e:
        return {"error": ("admin login throttled — wait ~1 min (fleet shares one IP)"
                          if e.code == 429 else f"admin login HTTP {e.code}")}
    except Exception as e:  # noqa: BLE001
        return {"error": f"admin login failed: {e}"[:120]}
    try:
        return _get()
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"[:120]}


def _asdict(x) -> dict:
    """Coerce a remote-JSON value to a dict — `{}` for anything else. The router can
    answer with a list, a bare string, or `{"error": …}`; treating any of those as a
    dict (`.get`) would raise on the UI thread and freeze the dashboard. One guard
    instead of an `isinstance` at every access site."""
    return x if isinstance(x, dict) else {}


def _epoch_iso(sec):
    """Epoch seconds (the router's reset5/reset7) → ISO-8601 UTC. The _countdown/
    _clock/_remain_frac helpers parse ISO; None passes straight through."""
    try:
        return datetime.fromtimestamp(int(sec), timezone.utc).isoformat() if sec else None
    except Exception:  # noqa: BLE001
        return None


def _kc_read() -> dict:
    """Read the live credential blob — macOS keychain, else the creds file."""
    if _IS_MAC:
        try:
            out = subprocess.run(["security", "find-generic-password", "-s", KC_SVC,
                                  "-a", KC_ACCT, "-w"], capture_output=True, text=True, timeout=10)
            if out.returncode == 0 and out.stdout.strip():
                return json.loads(out.stdout)
        except Exception:
            pass
        return {}
    try:
        return json.load(open(CRED_FILE))
    except Exception:
        return {}


def _kc_write(blob: dict) -> bool:
    """Write the credential blob back — macOS keychain (-U upserts), else the file."""
    raw = json.dumps(blob)
    if _IS_MAC:
        try:
            r = subprocess.run(["security", "add-generic-password", "-U", "-s", KC_SVC,
                                "-a", KC_ACCT, "-w", raw], capture_output=True, timeout=10)
            return r.returncode == 0
        except Exception:
            return False
    try:
        os.makedirs(os.path.dirname(CRED_FILE), exist_ok=True)
        tmp = CRED_FILE + ".tmp"
        with open(tmp, "w") as f:
            f.write(raw)
        os.chmod(tmp, 0o600)
        os.replace(tmp, CRED_FILE)
        return True
    except Exception:
        return False


def _norm(s: str) -> str:
    """Collapse a name/email to bare alphanumerics for identity matching. This is the
    trick that binds the router's slug to a hand-named token file with no per-account
    map: `claude@mejl.to` → `claudemejlto` (== the slug), `Philip` → `philip`."""
    return "".join(c for c in s.lower() if c.isalnum())


def _direct_token(name: str) -> str:
    """The account's LOCAL setup-token — the only way to go direct, since the router
    never reveals its server-side tokens. The .token files are HAND-DROPPED and named
    inconsistently (short-name `philip.token` vs email `claude@mejl.to.token`), so we
    don't guess one filename: we ENUMERATE ~/.claude-accounts/*.token and match any file
    whose normalized basename equals the account's normalized name OR email. That makes
    the filename irrelevant — `claude@mejl.to` normalizes to the `claudemejlto` slug."""
    want = {_norm(name)}
    e = acct_email(name)
    if e:
        want.add(_norm(e))
    try:
        d = os.path.expanduser("~/.claude-accounts")
        cands = [f for f in os.listdir(d) if f.endswith(".token")]
    except OSError:
        return ""
    # exact-name file first (fast + unambiguous), then any normalized-identity match
    order = sorted(cands, key=lambda f: (f != f"{name}.token", _norm(f[:-6]) not in want))
    for f in order:
        if _norm(f[:-6]) not in want:
            continue
        try:
            t = open(os.path.join(d, f)).read().strip()
            if t.startswith("sk-ant-oat"):
                return t
        except OSError:
            continue
    return ""


def _token_revoked(tok: str) -> bool:
    """Ground-truth liveness: a 1-token inference call — the scope a setup-token ACTUALLY
    has. /oauth/profile is the wrong check (a healthy setup-token gets 403 there, no
    profile scope), so it can't tell alive from dead. Only a 401 means revoked; a 429/529
    or any network hiccup returns False so a transient blip never blocks the switch."""
    try:
        body = json.dumps({"model": "claude-haiku-4-5-20251001", "max_tokens": 1,
                           "messages": [{"role": "user", "content": "hi"}]}).encode()
        req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body,
                                     headers={"authorization": f"Bearer {tok}",
                                              "anthropic-beta": "oauth-2025-04-20",
                                              "anthropic-version": "2023-06-01",
                                              "content-type": "application/json"})
        urllib.request.urlopen(req, timeout=12).read(0)
    except urllib.error.HTTPError as e:
        return e.code == 401
    except Exception:  # noqa: BLE001
        return False
    return False


def _set_force_direct(on: bool) -> None:
    """Flip the deliberate direct-connect flag + blank the route cache so the very
    next shell re-decides. Shared by the Setup toggle and the account switches."""
    if on:
        os.makedirs(os.path.dirname(_FORCE_DIRECT_FLAG), exist_ok=True)
        open(_FORCE_DIRECT_FLAG, "w").close()
    else:
        try:
            os.remove(_FORCE_DIRECT_FLAG)
        except FileNotFoundError:
            pass
    try:
        os.remove(_ROUTE_MARKER)
    except FileNotFoundError:
        pass


def switch_direct_local(name: str) -> dict:
    """Switch DIRECT: put `name`'s local setup-token into the live login (keychain /
    creds file) and set force-direct, so new panes hit api.anthropic.com as `name`.
    Backs the old blob up to ~/.claude-accounts/.keychain-backup-<ts>.json first.
    Returns {ok, error?}."""
    # local file first; on a miss, self-heal by pulling the live token off the router.
    tok = _direct_token(name) or _sync_token_from_router(name)
    if not tok:
        return {"ok": False, "error": f"no token for {name} — the router won't reveal one "
                f"and ~/.claude-accounts/{name}.token is missing (is the gateway up?)"}
    # local copy was revoked → try ONE fresh pull from the router before giving up. The
    # gateway holds the current token even when the local file rotted, so a revoked
    # direct switch usually just needs a resync, not a hand-minted setup-token.
    if _token_revoked(tok):
        fresh = _sync_token_from_router(name)
        if fresh and fresh != tok and not _token_revoked(fresh):
            tok = fresh
        else:
            return {"ok": False, "error": f"{name}'s token is REVOKED and the router has no "
                    f"fresher copy — mint a new setup-token, or use 'switch — via router'"}
    blob = _kc_read()
    try:
        bak = os.path.expanduser(f"~/.claude-accounts/.keychain-backup-{int(time.time())}.json")
        with open(bak, "w") as f:
            json.dump(blob, f)
        os.chmod(bak, 0o600)
    except OSError:
        pass
    old = blob.get("claudeAiOauth") or {}
    blob["claudeAiOauth"] = {
        "accessToken": tok,
        # setup-tokens are long-lived and have no refresh flow — far-future expiry
        # so claude never tries to refresh.
        "expiresAt": int((time.time() + 365 * 86400) * 1000),
        "scopes": old.get("scopes") or ["user:inference", "user:profile"],
        "subscriptionType": old.get("subscriptionType") or "max",
    }
    if not _kc_write(blob):
        return {"ok": False, "error": "could not write the login (keychain/creds file)"}
    _set_force_direct(True)
    _write_local_selected(name)
    _refresh_statusline_account()
    return {"ok": True}


# claudectl MCP server — holds the cross-machine fleet presence registry (which
# box is on which account, each box's statusline verifies + publishes its own).
MCP_BASE = os.environ.get("CLAUDECTL_MCP", "https://claudectl.hostbun.cc").rstrip("/")
MCP_BEARER = os.environ.get("CLAUDECTL_MCP_BEARER", os.environ.get("STATIC_BEARER", "ddash"))


def _mcp_get(path: str) -> dict:
    """Best-effort GET against the claudectl MCP server (fleet presence). Never
    raises — the dashboard degrades to no-presence if it's unreachable."""
    try:
        req = urllib.request.Request(MCP_BASE + path,
                                     headers={"authorization": f"Bearer {MCP_BEARER}"})
        with urllib.request.urlopen(req, timeout=6) as r:
            d = json.load(r)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


REFRESH_MS = 2000   # auto-refetch from the router every 2s (always latest)

# ---------------------------------------------------------------- LIVE limits
# _LIVE holds the freshest per-account usable/5h/7d summary, filled by a background
# worker off the router's harvested /api/limits (free — no probe). The "⚡ LIVE limit
# check" menu action additionally POSTs /api/claudecode/limits {all:true}, which makes
# the ROUTER ping each subscription once for fresh headers (1 token per account).
_LIVE: dict = {}
_LIVE_AT = 0.0
LIVE_INTERVAL = int(os.environ.get("CLAUDECTL_LIVE_INTERVAL", "90"))
# cross-machine fleet presence, refreshed in the same background worker so a dead
# presence host can never stall the UI thread (it used to block fetch() up to 6s).
_PRES: dict = {}


def _llm_post(sub: str, body: dict | None = None, timeout: float = 30):
    """POST llm.hostbun.cc/api/<sub> as JSON, cookie-authed like _llm_json. Never
    raises — returns {"error": ...} on failure. Used for the mutating/live endpoints
    (claudecode/limits, accounts/remove)."""
    op, cj = _llm_admin_opener()

    def _post():
        r = op.open(urllib.request.Request(f"{LLM_ADMIN}/api/{sub}",
                    data=json.dumps(body or {}).encode(),
                    headers={"content-type": "application/json"}, method="POST"),
                    timeout=timeout)
        return json.loads(r.read().decode() or "{}")
    try:
        return _post()
    except urllib.error.HTTPError as e:
        if e.code not in (401, 403):
            try:
                return json.loads(e.read().decode())
            except Exception:  # noqa: BLE001
                return {"error": f"HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"[:120]}
    # cookie missing/expired → one login, cache it, retry
    try:
        op.open(urllib.request.Request(f"{LLM_ADMIN}/api/login",
                data=json.dumps({"password": LLM_PW}).encode(),
                headers={"content-type": "application/json"}), timeout=timeout).read()
        try:
            os.makedirs(os.path.dirname(_ADMIN_COOKIE), exist_ok=True)
            cj.save(ignore_discard=True, ignore_expires=True)
            os.chmod(_ADMIN_COOKIE, 0o600)
        except OSError:
            pass
    except urllib.error.HTTPError as e:
        return {"error": ("admin login throttled — wait ~1 min (fleet shares one IP)"
                          if e.code == 429 else f"admin login HTTP {e.code}")}
    except Exception as e:  # noqa: BLE001
        return {"error": f"admin login failed: {e}"[:120]}
    try:
        return _post()
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"[:120]}


def _sync_token_from_router(name: str) -> str:
    """Pull `name`'s LIVE setup-token from the router (/api/reveal) and cache it to
    ~/.claude-accounts/<name>.token (0600). This is how direct mode SELF-HEALS a
    stale/revoked local copy after a rotation: the gateway always holds the fresh token,
    so instead of dead-ending on 'mint a new setup-token' we just sync the live one.
    Returns the token, or '' if the router is unreachable / won't reveal it."""
    tok = _asdict(_llm_post("reveal", {"account": name})).get("token") or ""
    if not tok.startswith("sk-ant-oat"):
        return ""
    try:
        p = os.path.expanduser(f"~/.claude-accounts/{name}.token")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(tok)
        os.chmod(p, 0o600)
    except OSError:
        pass
    return tok


def _live_refresh():
    """One pass: read the usable/dead summary from the router's live limits. The
    router already probes Anthropic's real rate-limit headers (that IS /api/limits),
    so there's nothing to reveal or probe per-account any more."""
    global _LIVE, _LIVE_AT
    state = _llm_json("state")
    limits = _llm_json("limits")
    names = {a.get("org"): a.get("name")
             for a in (state.get("claudecodeAccountPool") or []) if isinstance(a, dict)}
    new: dict = {}
    for it in (limits.get("rows") if isinstance(limits, dict) else None) or []:
        if not isinstance(it, dict):
            continue
        name = names.get(it.get("org_id"))
        if not name:
            continue
        prev = new.get(name)
        if prev and (it.get("ts") or 0) < prev.get("_ts", 0):
            continue                     # keep the freshest row per account
        new[name] = {
            "u5": (it.get("u5") or 0) * 100, "u7": (it.get("u7") or 0) * 100,
            "s5": it.get("s5"), "s7": it.get("s7"),
            "usable": it.get("status") != "rejected", "_ts": it.get("ts") or 0,
        }
    if new:
        _LIVE = new
        _LIVE_AT = time.time()


# ---------------------------------------------------------------- live worker
def _live_worker():
    global _PRES
    while True:
        try:
            _live_refresh()
        except Exception:
            pass
        try:
            _PRES = _mcp_get("/presence")   # off the UI thread — a dead host costs nothing
        except Exception:
            pass
        time.sleep(LIVE_INTERVAL)


# ---------------------------------------------------------------- data
def _date_compact(iso: str | None) -> str:
    """Local reset DATE for the accounts row: 'Mon 13 Jul'. The countdown next to
    it already carries the hour precision; the row needs the calendar day."""
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%a %d %b")
    except Exception:
        return ""


def _countdown(iso: str | None) -> str:
    if not iso:
        return "—"
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except Exception:
        return iso[:16]
    secs = int((dt - datetime.now(timezone.utc)).total_seconds())
    if secs <= 0:
        return "now"
    d, rem = divmod(secs, 86400)
    h, rem = divmod(rem, 3600)
    m, _ = divmod(rem, 60)
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m:02d}m"
    return f"{m}m"


# ---------------------------------------------------------------- fleet control
# Broadcast to every running cmux claude/ccc pane (set model, effort, arbitrary
# command, or restart-all). Each claude runs `--session-id|--resume <uuid>` with
# CMUX_SURFACE_ID in its env; cmux accepts that UUID for --surface. Skips self.
_CMUX = os.environ.get("CMUX_BUNDLED_CLI_PATH", "cmux")
_MY_SURFACE = os.environ.get("CMUX_SURFACE_ID", "")
_HERE = os.path.dirname(os.path.realpath(__file__))   # realpath: `cccc` is a symlink into tui/
# ccc_refresh / ccc_doctor moved into the plugin (they're deps of the local MCP
# servers, which now ship via the marketplace); the TUI drives them from there.
_MCP_DIR = os.path.join(os.path.dirname(_HERE), "plugins", "claudectl", "mcp")
_REFRESH_SCRIPT = os.path.join(_MCP_DIR, "ccc_refresh.py")
_DOCTOR_SCRIPT = os.path.join(_MCP_DIR, "ccc_doctor.py")
_SYNC_SCRIPT = os.path.join(_HERE, "cccc_sync.py")
_DOCK_SCRIPT = os.path.join(os.path.dirname(_HERE), "dock", "dock_tui.py")
_PANES_SCRIPT = os.path.join(_HERE, "panes_tui.py")
# `cccc` is the ONLY command; these sub-tools are reached as `cccc <sub>` (headless,
# for cron/scripts) or from the TUI menu. Kept as separate files, dispatched here.
# `links` is the old name for `dock` — the panel outgrew being just a link list.
_SUBCMDS = {"sync": _SYNC_SCRIPT, "refresh": _REFRESH_SCRIPT, "doctor": _DOCTOR_SCRIPT,
            "dock": _DOCK_SCRIPT, "links": _DOCK_SCRIPT, "panes": _PANES_SCRIPT}

# ---------------------------------------------------------------- version check
# Every launch checks this checkout against origin/master in the background and
# AUTO-updates via cccc_sync.py (which is dev-clone-safe: it skips the pull when
# the tree is dirty and never resets a dev clone). The running process keeps the
# old code — the header says "restart" when new code landed on disk.
_REPO = os.path.dirname(os.path.dirname(_HERE))        # cccc/tui → repo root
_VER: dict = {}   # {"sha","behind","state":checking|latest|behind|updated|err}


def _git(*args: str, timeout: int = 20) -> str:
    r = subprocess.run(["git", "-C", _REPO, *args],
                       capture_output=True, text=True, timeout=timeout)
    return (r.stdout or "").strip()


def _version_check(autosync: bool = True) -> dict:
    """fetch origin → behind-count vs origin/master; when behind, run cccc sync
    (quiet) and re-measure. Writes the shared _VER dict the header renders."""
    global _VER
    sha = "?"
    try:
        sha = _git("rev-parse", "--short", "HEAD") or "?"
        _VER = {"sha": sha, "state": "checking"}
        _git("fetch", "-q", "origin", timeout=25)
        behind = int(_git("rev-list", "--count", "HEAD..origin/master") or 0)
        if behind and autosync:
            subprocess.run([sys.executable, _SYNC_SCRIPT, "--quiet"],
                           capture_output=True, timeout=180)
            new_sha = _git("rev-parse", "--short", "HEAD") or sha
            behind = int(_git("rev-list", "--count", "HEAD..origin/master") or 0)
            if new_sha != sha:
                # new code is on disk; THIS process still runs the old code
                _VER = {"sha": new_sha, "behind": behind,
                        "state": "updated" if behind == 0 else "behind"}
                return _VER
        _VER = {"sha": sha, "behind": behind,
                "state": "latest" if behind == 0 else "behind"}
    except Exception as e:  # noqa: BLE001 — a dead network must not kill the UI
        _VER = {"sha": sha, "state": "err", "err": f"{type(e).__name__}"[:40]}
    return _VER


# Doctor runs automatically at every launch (background) — the header shows a
# ✓/✗ chip and the Setup tab the first finding, so a broken LSP/env surfaces
# without anyone remembering to press the button.
_DOC: dict = {}   # {"ok": bool|None, "n": int, "first": str}


def _doctor_check() -> dict:
    global _DOC
    try:
        r = subprocess.run([sys.executable, _DOCTOR_SCRIPT],
                           capture_output=True, text=True, timeout=90)
        bad = [ln.strip() for ln in (r.stdout or "").splitlines()
               if ln.strip().startswith("✗")]
        _DOC = {"ok": not bad, "n": len(bad), "first": bad[0][:70] if bad else ""}
    except Exception as e:  # noqa: BLE001
        _DOC = {"ok": None, "n": 0, "first": f"doctor failed: {type(e).__name__}"}
    return _DOC


def _claude_surfaces() -> list[str]:
    import re as _re
    out = subprocess.run(["ps", "-Ao", "pid=,args="], capture_output=True, text=True).stdout
    seen = []
    for line in out.splitlines():
        if not _re.search(r"claude .*?--(?:session-id|resume) [0-9a-f-]{36}", line):
            continue
        pid = line.split(None, 1)[0]
        env = subprocess.run(["ps", "eww", "-o", "command=", "-p", pid],
                             capture_output=True, text=True).stdout
        m = _re.search(r"CMUX_SURFACE_ID=(\S+)", env)
        if m and m.group(1) != _MY_SURFACE and m.group(1) not in seen:
            seen.append(m.group(1))
    return seen


def _broadcast(text: str, confirm: bool = False) -> int:
    """Type `text` + Enter into every running claude pane (except this one).
    confirm=True sends a second Enter after a beat to accept a follow-up dialog
    default (e.g. `/model X` pops a 'Switch model? ❯ Yes' confirm)."""
    surfaces = _claude_surfaces()
    for s in surfaces:
        subprocess.run([_CMUX, "send", "--surface", s, text], capture_output=True)
        subprocess.run([_CMUX, "send-key", "--surface", s, "enter"], capture_output=True)
    if confirm and surfaces:
        time.sleep(1.0)
        for s in surfaces:
            subprocess.run([_CMUX, "send-key", "--surface", s, "enter"], capture_output=True)
    return len(surfaces)


def _claude_windows() -> list[dict]:
    """Every running claude/ccc window on THIS machine except our own pane, as
    {pid, surface, label}. The label (folder · account · pid) is best-effort — it
    scrapes the pane's statusline + the process cwd so the kill picker is readable.
    Heavier than _claude_surfaces (one lsof + one read-screen per window) but only
    built on demand when you open the kill menu."""
    import re as _re
    out = subprocess.run(["ps", "-Ao", "pid=,args="], capture_output=True, text=True).stdout
    wins = []
    for line in out.splitlines():
        if not _re.search(r"claude .*?--(?:session-id|resume) [0-9a-f-]{36}", line):
            continue
        pid = line.split(None, 1)[0]
        env = subprocess.run(["ps", "eww", "-o", "command=", "-p", pid],
                             capture_output=True, text=True).stdout
        m = _re.search(r"CMUX_SURFACE_ID=(\S+)", env)
        surf = m.group(1) if m else ""
        if not surf or surf == _MY_SURFACE:
            continue
        # folder = basename of the process cwd (the friendly part of the label)
        folder = ""
        try:
            cwd = subprocess.run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"],
                                 capture_output=True, text=True, timeout=5).stdout
            mc = _re.search(r"^n(.+)$", cwd, _re.M)
            folder = os.path.basename(mc.group(1).rstrip("/")) if mc else ""
        except Exception:
            pass
        # account = the 👤 name off the pane's statusline
        acct = ""
        try:
            sc = subprocess.run([_CMUX, "read-screen", "--surface", surf, "--lines", "6"],
                                capture_output=True, text=True, timeout=5).stdout
            ma = _re.search(r"👤\s*([^\s·✓✗]+)", sc)
            acct = ma.group(1) if ma else ""
        except Exception:
            pass
        label = " · ".join([p for p in (folder or surf[:8], acct, f"pid {pid}") if p])
        wins.append({"pid": pid, "surface": surf, "label": label})
    return wins


def _kill_window(pid: str) -> bool:
    """Stop a running claude agent by PID: SIGTERM, then SIGKILL if it survives.
    Leaves the ghostty pane sitting at a shell — does NOT relaunch (that's what
    restart does). Returns True if the signal was delivered."""
    try:
        os.kill(int(pid), signal.SIGTERM)
    except Exception:
        return False
    time.sleep(0.6)
    try:
        os.kill(int(pid), 0)               # still alive? escalate.
        os.kill(int(pid), signal.SIGKILL)
    except Exception:
        pass                               # already gone — good
    return True


def _run_external(stdscr, argv):
    """Suspend curses, run a blocking external command (e.g. ccc_refresh --go),
    wait for a keypress, resume."""
    curses.endwin()
    try:
        subprocess.run(argv)
        try:
            input("\n[done] press Enter to return to cccc… ")
        except Exception:
            pass
    finally:
        stdscr.clear()
        stdscr.refresh()


def _clock(iso: str | None) -> str:
    """Absolute local reset time. Today → '18:00'; this week → 'Sat 18:00';
    further out (a 7d window can land next week) → 'Sat 12 Jul 18:00' so the
    day is never ambiguous."""
    if not iso:
        return ""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()
    except Exception:
        return ""
    now = datetime.now().astimezone()
    days = (dt.date() - now.date()).days
    if days == 0:
        return dt.strftime("%H:%M")
    if 0 < days <= 6:
        return dt.strftime("%a %H:%M")
    return dt.strftime("%a %-d %b %H:%M")


def _remain_frac(iso: str | None, window_h: float = 168.0):
    """Fraction of the rolling window still LEFT, 0..1. The window ENDS at `iso`
    (resets_at) and is `window_h` long (7d = 168h). 1.0 = just reset (whole week
    ahead), 0.0 = reset now. Drives the time-left gauge (drains right→left)."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except Exception:
        return None
    rem_h = (dt - datetime.now(timezone.utc)).total_seconds() / 3600.0
    if rem_h <= 0:
        return 0.0
    return max(0.0, min(1.0, rem_h / window_h))


def fetch() -> dict:
    """Accounts + live 5h/7d, sourced from the llm.hostbun.cc router (the ONLY
    gateway now — claude.hostbun.cc is retired). /api/state → claudecodeAccountPool
    (name↔org, the account list) merged with /api/limits (the router's harvested
    Anthropic rate-limit rows, keyed by org_id)."""
    # short timeout: this runs on the UI thread every refresh — a slow/unreachable
    # gateway must fail fast and show an error, not freeze the dashboard.
    state = _llm_json("state", timeout=8)
    limits = _llm_json("limits", timeout=8)
    pool = state.get("claudecodeAccountPool") if isinstance(state, dict) else None
    # newest limits row per org (a busy account carries several project/model rows)
    lim_by_org: dict = {}
    for it in (limits.get("rows") if isinstance(limits, dict) else None) or []:
        if isinstance(it, dict) and it.get("org_id"):
            prev = lim_by_org.get(it["org_id"])
            if not prev or (it.get("ts") or 0) >= (prev.get("ts") or 0):
                lim_by_org[it["org_id"]] = it
    local_sel = _read_local_selected()  # the ★ this box pins
    # what THIS box is actually billed on: the server-side consumer→account lock
    pins = _asdict(_asdict(state).get("projectAccounts") or _asdict(state).get("consumerAccounts"))
    my_pin = pins.get(_consumer_name().lower(), "")
    # cross-machine presence: which boxes are on which account (from the MCP server)
    pres = _PRES   # refreshed by _live_worker; never blocks the UI thread
    machines_by = {a.get("name"): (a.get("machines") or [])
                   for a in (pres.get("accounts") or []) if isinstance(a, dict)}
    rows = []
    for a in pool or []:
        a = _asdict(a)                                # router could hand back a list of junk
        name = a.get("name", "?")
        org = a.get("org") or ""
        lm = lim_by_org.get(org, {})
        u5, u7 = lm.get("u5"), lm.get("u7")
        iso5, iso7 = _epoch_iso(lm.get("reset5")), _epoch_iso(lm.get("reset7"))
        rows.append({
            "name": name,
            "local": name == local_sel,          # ← the ★ (what cccc pins this box to)
            "active": name == my_pin,            # ← what this box is billed on right now
            # owner: real email isn't derivable from the token, so fall back to the
            # known map, else the org id.
            "owner": acct_email(name) or (org[:8] if org else ""),
            "org": org,                          # real Anthropic org id (spot fakes)
            "sub": "?",                          # tier not exposed by the router
            "status": lm.get("status") or "",
            # router util is a 0..1 fraction; the gauges want a 0..100 USED %.
            "u5": (u5 * 100 if isinstance(u5, (int, float)) else None),
            "r5": _countdown(iso5),
            "c5": _clock(iso5),
            "u7": (u7 * 100 if isinstance(u7, (int, float)) else None),
            "r7": _countdown(iso7),
            "c7": _clock(iso7),
            "d7": _date_compact(iso7),   # reset DATE for the row ('Mon 13 Jul')
            "wk_left": _remain_frac(iso7),       # 0..1 of the 7d window LEFT
            "machines": machines_by.get(name, []),   # boxes currently on this account
        })
    err = ""
    for r in (state, limits):
        if isinstance(r, dict) and r.get("error"):
            err = str(r["error"])
            break
    if not rows and not err:
        err = "router returned no claudecodeAccountPool"
    return {"rows": rows, "err": err}


# ---------------------------------------------------------------- ui helpers
def _prompt(stdscr, label: str, secret: bool = False) -> str:
    stdscr.timeout(-1)   # block for input (suspend the auto-refresh timeout)
    curses.echo()
    h, w = stdscr.getmaxyx()
    stdscr.move(h - 1, 0)
    stdscr.clrtoeol()
    stdscr.addstr(h - 1, 0, label[: w - 1], curses.A_BOLD)
    stdscr.refresh()
    try:
        if secret:
            curses.noecho()
            buf = ""
            while True:
                ch = stdscr.getch()
                if ch in (10, 13):
                    break
                if ch in (27,):
                    buf = ""
                    break
                if ch in (curses.KEY_BACKSPACE, 127, 8):
                    buf = buf[:-1]
                elif 32 <= ch < 127:
                    buf += chr(ch)
            val = buf
        else:
            val = stdscr.getstr(h - 1, len(label), 300).decode()
    except Exception:
        val = ""
    curses.noecho()
    stdscr.timeout(REFRESH_MS)   # restore auto-refresh
    return val.strip()


def _confirm(stdscr, msg: str) -> bool:
    return _prompt(stdscr, msg + " [y/N] ").lower().startswith("y")


def _popup(stdscr, title: str, text: str):
    h, w = stdscr.getmaxyx()
    lines = []
    for raw in text.splitlines() or [""]:
        while len(raw) > w - 4:
            lines.append(raw[: w - 4])
            raw = raw[w - 4:]
        lines.append(raw)
    ph = min(len(lines) + 2, h - 2)
    pw = w - 2
    win = curses.newwin(ph, pw, 1, 1)
    win.box()
    win.addstr(0, 2, f" {title} "[: pw - 4], curses.A_BOLD)
    for i, ln in enumerate(lines[: ph - 2]):
        win.addstr(1 + i, 2, ln[: pw - 4])
    win.refresh()
    win.getch()


def _form(stdscr, title: str, fields, hint: str = ""):
    """Centered, boxed multi-field entry menu. fields = [(label, secret_bool), ...].
    Tab/↓/Enter → next field, Enter on last → submit, Esc → cancel.
    Returns list of values (str) or None if cancelled."""
    stdscr.timeout(-1)          # block; suspend auto-refresh while the form is up
    curses.curs_set(1)
    curses.noecho()
    h, w = stdscr.getmaxyx()
    labels = [lbl for lbl, _ in fields]
    lw = max(len(l) for l in labels) + 1
    pw = min(max(60, lw + 44), w - 2)
    ph = len(fields) + 6
    y0 = max(0, (h - ph) // 2)
    x0 = max(0, (w - pw) // 2)
    win = curses.newwin(ph, pw, y0, x0)
    win.keypad(True)
    bufs = ["" for _ in fields]
    cur = 0
    hint = hint or "[Tab/↵] next   [↵ on last] save   [Esc] cancel"
    try:
        while True:
            win.erase()
            win.box()
            win.addstr(0, 2, f" {title} "[: pw - 4], curses.A_BOLD)
            fieldw = pw - lw - 6
            for i, (lbl, secret) in enumerate(fields):
                row = 2 + i
                active = (i == cur)
                win.addstr(row, 2, lbl.rjust(lw), curses.A_BOLD if active else curses.A_DIM)
                shown = ("•" * len(bufs[i])) if secret else bufs[i]
                shown = shown[-fieldw:]
                box_attr = curses.A_REVERSE if active else curses.A_UNDERLINE
                win.addstr(row, lw + 4, (" " + shown).ljust(fieldw)[:fieldw], box_attr)
            win.addstr(ph - 2, 2, hint[: pw - 4], curses.A_DIM)
            # park the cursor at the end of the active field
            cx = lw + 5 + min(len(bufs[cur]), fieldw - 1)
            win.move(2 + cur, cx)
            win.refresh()

            ch = win.getch()
            if ch in (27,):                       # Esc → cancel
                return None
            if ch in (9, curses.KEY_DOWN):        # Tab / ↓ → next field
                cur = (cur + 1) % len(fields)
            elif ch in (curses.KEY_BTAB, curses.KEY_UP):   # Shift-Tab / ↑ → prev
                cur = (cur - 1) % len(fields)
            elif ch in (10, 13):                  # Enter
                if cur < len(fields) - 1:
                    cur += 1
                else:
                    return [b.strip() for b in bufs]
            elif ch in (curses.KEY_BACKSPACE, 127, 8):
                bufs[cur] = bufs[cur][:-1]
            elif 32 <= ch < 127:
                bufs[cur] += chr(ch)
    finally:
        curses.curs_set(0)
        stdscr.timeout(REFRESH_MS)


def _wrap(text: str, width: int) -> list[str]:
    """Greedy word-wrap into lines of at most `width` cols."""
    out, cur = [], ""
    for wd in (text or "").split():
        if cur and len(cur) + 1 + len(wd) > width:
            out.append(cur)
            cur = wd
        else:
            cur = (cur + " " + wd).strip()
    if cur:
        out.append(cur)
    return out or [""]


def _menu(stdscr, title, items):
    """Arrow-selectable action menu. items = [(label, value[, desc]), ...] (or
    (None, None) for a separator). The highlighted action's plain-English
    description renders in a panel at the bottom, so every action says exactly
    what it does. Navigation is ARROWS + ENTER ONLY — ↑/↓ move, ↵ picks, Esc
    cancels. No letter hotkeys. Returns the chosen value, or None if cancelled."""
    stdscr.timeout(-1)
    curses.curs_set(0)
    h, w = stdscr.getmaxyx()
    # normalize every entry to (label, value, desc)
    items = [(it[0], it[1], (it[2] if len(it) > 2 else "")) for it in items]
    pickable = [i for i, (lbl, v, _) in enumerate(items) if v is not None]
    if not pickable:
        return None
    sel = pickable[0]
    DESC = 3                                    # text rows reserved for the description
    labw = max([len(l) for l, _, _ in items if l] + [len(title)])
    pw = min(max(labw + 10, 62), w - 2)
    ph = min(len(items) + 5 + DESC, h - 2)      # +border/sep/desc/footer
    win = curses.newwin(ph, pw, max(0, (h - ph) // 2), max(0, (w - pw) // 2))
    win.keypad(True)
    listmax = ph - 4 - DESC                     # item rows that fit above the desc panel
    try:
        while True:
            win.erase(); win.box()
            win.addstr(0, 2, f" {title} "[: pw - 4], curses.A_BOLD)
            for i, (lbl, v, _) in enumerate(items[:listmax]):
                row = 1 + i
                if v is None:                                  # separator
                    win.addstr(row, 2, ("─" * (pw - 4))[: pw - 4], curses.A_DIM)
                    continue
                active = (i == sel)
                pointer = "▸ " if active else "  "
                line = f"{pointer}{lbl}".ljust(pw - 4)[: pw - 4]
                win.addstr(row, 2, line, curses.A_REVERSE if active else curses.A_NORMAL)
            # description panel for the highlighted action
            dy = ph - 2 - DESC
            win.addstr(dy, 2, ("─" * (pw - 4))[: pw - 4], curses.A_DIM)
            for j, dl in enumerate(_wrap(items[sel][2], pw - 6)[:DESC]):
                win.addstr(dy + 1 + j, 2, dl[: pw - 4], curses.color_pair(6))
            win.addstr(ph - 2, 2, "[↑↓] move   [↵] pick   [esc] back"[: pw - 4], curses.A_DIM)
            win.refresh()

            ch = win.getch()
            if ch == 27:
                return None
            elif ch == curses.KEY_DOWN:
                nx = [i for i in pickable if i > sel]
                sel = nx[0] if nx else pickable[0]
            elif ch == curses.KEY_UP:
                pv = [i for i in pickable if i < sel]
                sel = pv[-1] if pv else pickable[-1]
            elif ch in (10, 13):
                return items[sel][1]
    finally:
        stdscr.timeout(REFRESH_MS)


# ---- action lists, grouped by tab ---------------------------------------------
# Every entry is (label, action-id, plain-English blurb). Selection is arrows +
# Enter only — the action-id is an internal dispatch key, NOT a keyboard hotkey.
# Four tabs, plain names: Accounts · Windows · Models · Setup. Each tab holds
# only actions about ONE thing — no catch-all "tools" drawer.

# per-account menu, opened with ↵ on a highlighted account row (Accounts tab)
_ACCOUNT_ITEMS = [
    ("switch — via router (llm.hostbun.cc)", "switch",
     "Pin THIS box to this account in the router's server-side pin map "
     "(/api/pins). Every pane routing through llm.hostbun.cc bills to it LIVE; "
     "no restart. Also turns force-direct OFF so the pin actually applies."),
    ("switch — DIRECT (bypass router)", "switch_direct",
     "Put this account's LOCAL setup-token (~/.claude-accounts/<name>.token) into "
     "the login and force direct-connect: new panes hit api.anthropic.com as this "
     "account. Needs the local token file — router tokens are never revealed."),
    ("test account (live)", "test",
     "Ask the router to ping this subscription once (1 token) and report the "
     "fresh 5h/7d reading — or the exact refusal (429 spent window vs "
     "✕ OAuth-disabled dead login)."),
    ("reveal token", "reveal",
     "Not possible: the router stores tokens server-side and never reveals them "
     "(by design). Mint a fresh setup-token if you need one elsewhere."),
    ("rename account", "rename",
     "Rename in the llm.hostbun.cc panel (Accounts tab) — the router owns the "
     "pool; cccc pins, it doesn't own."),
    ("delete account", "delete",
     "Remove this account from the router's pool (/api/accounts/remove). "
     "Irreversible — you'd need a fresh setup-token to re-add it."),
]

# Accounts tab — pool-wide actions, shown as rows BELOW the account list.
# (Per-account stuff is in _ACCOUNT_ITEMS above, reached with ↵ on a row.)
_POOL_ITEMS = [
    ("＋ add an account", "add",
     "Add accounts in the llm.hostbun.cc panel (name + setup-token, sk-ant-oat…) — "
     "the router owns the pool."),
    ("⟳ refresh now", "refresh",
     "Re-fetch the table now: accounts + the router's harvested 5h/7d usage. Free "
     "— for a guaranteed-fresh reading use LIVE limit check."),
    ("⚡ LIVE limit check", "live_probe",
     "POST /api/claudecode/limits {all:true}: the router pings every subscription "
     "once (1 token each) for fresh rate-limit headers. Ground truth — catches "
     "idle/refunded accounts whose harvested reading went stale."),
]

# Windows tab — every action touches ALL your running claude/ccc windows at once.
_WINDOWS_ITEMS = [
    ("restart ALL windows", "fleet_restart",
     "Kill + resume every running ccc window across all cmux workspaces. Reloads "
     "plugins and switches each to the CURRENT account. Interrupts in-flight work; "
     "each window resumes its own session after."),
    ("set model on ALL windows", "fleet_model",
     "Type `/model X` + confirm into every running claude/ccc window."),
    ("set effort on ALL windows", "fleet_effort",
     "Type `/effort low|medium|high` into every running claude/ccc window."),
    ("send a command to ALL windows", "fleet_broadcast",
     "Type an arbitrary line + Enter into every running claude/ccc window."),
    ("reload plugins on ALL windows", "fleet_reload_plugins",
     "Type `/reload-plugins --force` + Enter into every running claude/ccc window "
     "so each reloads its plugins/MCP without a full restart."),
    ("kill ONE window…", "fleet_kill_one",
     "Pick one running claude window and STOP it now (SIGTERM → SIGKILL). Its pane "
     "drops to a shell and it does NOT come back — use restart to bring it back. "
     "Your own window is never in the list."),
    ("kill ALL windows", "fleet_kill_all",
     "Stop EVERY running claude window on this machine right now. Every pane drops "
     "to a shell, no resume. Your own window is never touched. Interrupts all work."),
]

# Live Anthropic routing for THIS box — drives the header chip + the toggle label.
# Reads the DELIBERATE force-direct flag and gateway-route.sh's marker (~/.claude/.cctl-route,
# "ts<TAB>state"). Returns (mode, chip, kind): mode ∈ direct|gateway|down; kind picks the colour.
_FORCE_DIRECT_FLAG = os.path.expanduser("~/.claude-accounts/.cccc-force-direct")
_ROUTE_MARKER = os.path.expanduser("~/.claude/.cctl-route")


def _route_state():
    if os.path.exists(_FORCE_DIRECT_FLAG):
        return ("direct", "⚡ DIRECT", "warn")     # deliberate bypass — wins even when router is up
    st = ""
    try:
        with open(_ROUTE_MARKER) as f:
            parts = f.read().strip().split("\t")
            st = parts[1] if len(parts) > 1 else ""
    except Exception:
        pass
    if st == "down":
        return ("down", "⚠ ROUTER-DOWN·direct", "err")   # fell back, NOT deliberate — loud
    if st == "up":
        return ("gateway", "▸ ROUTER", "ok")
    return ("gateway", "▸ ROUTER", "dim")            # no marker yet → gateway is the default


# Setup tab — maintenance of the cccc tool itself on this machine.
_SETUP_ITEMS = [
    ("check installation / version", "version_check",
     "Fetch origin and compare this checkout to origin/master, then run the "
     "install verifier (install.sh checks: wrapper on PATH, statusLine points "
     "here, script executes). Launch already auto-checks + auto-syncs; this "
     "forces it now and shows the result."),
    ("health check (doctor)", "doctor",
     "Check LSP / environment health on this machine (the old separate `cccd`). "
     "Runs automatically at every launch — the ✓/✗ chip in the title bar is its "
     "latest verdict; this shows the full report."),
    ("doctor --fix (enable missing LSPs)", "doctor_fix",
     "Enable the missing LSP plugins doctor found, at user scope, then re-check."),
    ("route: gateway ⇄ direct (toggle)", "toggle_direct",
     "Toggle DELIBERATE direct-connect. ON = bypass the llm.hostbun.cc router and hit "
     "api.anthropic.com straight on the keychain login (faster; loses per-consumer "
     "tracking for that window). OFF = route through the gateway as usual. Writes/removes "
     "~/.claude-accounts/.cccc-force-direct, honored by every new shell (gateway-route.sh) "
     "BEFORE the health probe, so it wins even when the router is up. Open a new pane / "
     "re-source rc for running panes to pick it up."),
    ("update this tool (sync)", "sync",
     "git-pull this cccc checkout onto the latest code and re-vendor. Asks whether "
     "to also restart running ccc windows. Launch already auto-syncs when behind."),
    ("project dock links (dock)", "dock",
     "Open the per-project Dock link editor (the old `cccc dock` CLI) in place."),
    ("pane layouts (panes)", "panes",
     "Open the cmux pane-layout tool (the old `cccc panes` CLI) in place."),
]

# Plugins tab — pool-wide actions, shown BELOW the project list.
# (Per-project stuff is a ↵ menu on a project row: apply / show plugins.)
_PLUGIN_POOL = [
    ("★ apply LEAN GLOBAL (this box)", "plugin_global",
     "Write ~/.claude/settings.json enabledPlugins = the lean CORE only. Any repo "
     "WITHOUT its own .claude/settings.json then loads just core (~40 tools instead "
     "of ~650). Per-machine. Restart claude to take effect."),
    ("⇊ apply ALL mapped repos", "plugin_apply_all",
     "Write .claude/settings.json into every mapped repo present on this box "
     "(core + its packs). Skips repos not found locally. Big write — confirms first."),
    ("⟳ reload config", "plugin_reload",
     "Re-read plugin-profiles.json from disk (after you edit the packs / project map)."),
]

_TAB_ITEMS = {"windows": _WINDOWS_ITEMS, "setup": _SETUP_ITEMS}


# ---------------------------------------------------------------- main loop
def run(stdscr):
    curses.curs_set(0)
    curses.use_default_colors()
    # Semantic palette. Slots 1-6 keep their meaning (red/green/yellow/blue/
    # magenta/cyan) so the rest of the draw code is untouched; on a 256-colour
    # terminal we swap in softer, designed shades and add a header/accent slot.
    if curses.COLORS >= 256:
        for slot, c in ((1, 203), (2, 42), (3, 214), (4, 111), (5, 176), (6, 80)):
            curses.init_pair(slot, c, -1)
        curses.init_pair(7, 231, 61)    # header bar: white on indigo
        curses.init_pair(8, 147, -1)    # accent (periwinkle) — titles, active tab
    else:
        for i in range(1, 7):
            curses.init_pair(i, i, -1)
        curses.init_pair(7, curses.COLOR_WHITE, curses.COLOR_BLUE)
        curses.init_pair(8, curses.COLOR_CYAN, -1)
    C_ACTIVE = curses.color_pair(2) | curses.A_BOLD   # green (bold)
    C_GREEN = curses.color_pair(2)                    # green
    C_WARN = curses.color_pair(3)                     # yellow
    C_HOT = curses.color_pair(1)                      # red
    C_CYAN = curses.color_pair(6)                     # cyan
    C_DIM = curses.A_DIM
    C_HEADER = curses.color_pair(7) | curses.A_BOLD   # top brand bar
    C_ACCENT = curses.color_pair(8) | curses.A_BOLD   # accent for titles/tabs

    def put(y, x, s, a=curses.A_NORMAL):
        try:
            stdscr.addstr(y, x, s, a)
        except curses.error:
            pass
        return x + len(s)

    # ---- status line: one consistent place that tells the user what just happened,
    #      or that a slow op is IN PROGRESS. icon + colour so "working / done / failed"
    #      is readable at a glance instead of a flat blue string. --------------------
    STATUS = {"msg": "ready", "kind": "info"}       # kind: info | busy | ok | err
    _ICON = {"info": "· ", "busy": "⏳ ", "ok": "✓ ", "err": "✗ "}

    def _status_attr(kind):
        return {"ok": C_GREEN | curses.A_BOLD, "err": C_HOT | curses.A_BOLD,
                "busy": C_CYAN | curses.A_BOLD, "info": curses.color_pair(4)}.get(kind, C_DIM)

    def paint_status():
        """Draw the status line at the bottom right now (used for instant feedback)."""
        hh, ww = stdscr.getmaxyx()
        line = " " + _ICON.get(STATUS["kind"], "") + STATUS["msg"]
        try:
            stdscr.addstr(hh - 1, 0, line.ljust(ww)[:ww], _status_attr(STATUS["kind"]))
        except curses.error:
            pass

    def busy(msg):
        """Show a slow op is running — paints immediately so the UI never looks frozen."""
        STATUS["msg"], STATUS["kind"] = msg, "busy"
        paint_status(); stdscr.refresh()

    def ok(msg):
        STATUS["msg"], STATUS["kind"] = msg, "ok"

    def err(msg):
        STATUS["msg"], STATUS["kind"] = msg, "err"

    def info(msg):
        STATUS["msg"], STATUS["kind"] = msg, "info"

    sel = 0                       # selected account row (Accounts tab)
    # paint a frame BEFORE the first (blocking) fetch — otherwise the curses
    # alt-screen sits BLANK while the network call to the router is in
    # flight, which reads as "nothing happens" on a slow/unreachable gateway.
    _hh, _ww = stdscr.getmaxyx()
    put(0, 0, " claudectl ".ljust(_ww)[:_ww], C_HEADER)
    put(2, 2, f"connecting to {LLM_ADMIN.split('://')[-1]} …", C_CYAN)
    busy("loading accounts from the router (llm.hostbun.cc)…")
    stdscr.refresh()
    data = fetch()
    stdscr.timeout(REFRESH_MS)   # getch() returns -1 after this idle -> auto-refresh
    import threading
    threading.Thread(target=_live_worker, daemon=True).start()   # LIVE 7d/usable in bg
    threading.Thread(target=_version_check, daemon=True).start()  # auto-update check
    threading.Thread(target=_doctor_check, daemon=True).start()   # auto health check

    # -- tabs: the ONLY top-level navigation. ←/→ switch tab, ↑/↓ move within it,
    #    ↵ selects/opens, q quits. No letter hotkeys anywhere. -----------------
    TABS = [("accounts", "Accounts"), ("windows", "Windows"),
            ("plugins", "Plugins"), ("setup", "Setup")]
    # start on a given tab (handy for scripts / testing): CCCC_TAB=plugins
    tab = next((i for i, (k, _) in enumerate(TABS)
                if k == os.environ.get("CCCC_TAB", "")), 0)
    list_sel = {"windows": 0, "plugins": 0, "setup": 0}   # cursor within each list tab
    pl_cfg = pp.load()                       # per-project plugin map (Plugins tab)
    pl_projects = pp.projects(pl_cfg)

    def bar_split(u, width=8):
        # (# filled cells, # empty cells) for a usage bar; any usage shows >=1
        # cell, and it only fills the last cell at a true 100%.
        if not isinstance(u, (int, float)):
            return 0, width
        n = int(round(max(0.0, min(1.0, u / 100.0)) * width))
        if u > 0 and n == 0:
            n = 1
        if u < 100 and n >= width:
            n = width - 1
        return n, width - n

    def draw_used_bar(y, x, u, rev, width=6):
        # usage gauge, normal intuition: fill = quota USED (more filled = more
        # spent). green while plenty remains → yellow busy → red almost gone.
        # `u` is the USED %; the number printed is also USED %.
        if not isinstance(u, (int, float)):
            x = put(y, x, "─" * width + "  —", C_DIM | rev)
            return x
        nf, ne = bar_split(u, width)
        att = C_HOT if u >= 90 else C_WARN if u >= 70 else C_GREEN
        x = put(y, x, "█" * nf, att | rev)
        x = put(y, x, "░" * ne, C_DIM | rev)
        x = put(y, x, f" {u:>3.0f}%", att | rev)
        return x

    def live_summary():
        """One-line ground-truth capacity string (shared by init + dashboard)."""
        if not _LIVE:
            return None, "probing live limits… (Accounts → ⚡ LIVE limit check to force now)"
        uz = [n for n, v in _LIVE.items() if v.get("usable")]
        dead = [n for n, v in _LIVE.items() if not v.get("usable")]
        s = f"✅ {len(uz)}/{len(_LIVE)} usable"
        if dead:
            s += f"  ·  ❌ dead: {', '.join(dead)}"
        return bool(uz), s

    # ---- action dispatch: one place that runs a chosen action-id. Menus and
    #      list tabs only ever produce these ids; there are no keyboard hotkeys.
    def dispatch(action, cur):
        nonlocal data
        if action == "switch" and cur:
            name = cur["name"]
            # Pin THIS box to `name` in the router's server-side pin map (/api/pins).
            # The router bills EVERY pane on this box to `name` LIVE — no restart —
            # as long as the box ROUTES through the gateway
            # (ANTHROPIC_BASE_URL=llm.hostbun.cc). Tokens live server-side; there
            # is no keychain swap: gateway mode IS the switch.
            busy(f"pinning {name} on the router · all panes, live…")
            gl = gateway_set_lock(name)
            if gl.get("ok"):
                was_direct = os.path.exists(_FORCE_DIRECT_FLAG)
                _set_force_direct(False)         # a pin only bites when routing via gateway
                _write_local_selected(name)      # ★ tracks the pin
                set_consumer_headers(name)       # keep X-Consumer/X-Project fresh
                ok(f"now on {name} via router ✓ live on every gateway pane"
                   + (" · direct-connect turned OFF (new panes route via gateway)"
                      if was_direct else " — no restart"))
            else:
                err(f"pin FAILED: {gl.get('error','?')}  (is the box routing through "
                    f"the gateway? Setup tab → gateway on)")
            data = fetch()
        elif action == "switch_direct" and cur:
            name = cur["name"]
            busy(f"switching login to {name} + forcing direct-connect…")
            r = switch_direct_local(name)
            if r.get("ok"):
                ok(f"now on {name} DIRECT · login swapped, router bypassed — open a "
                   f"new pane (running panes keep their launch env)")
            else:
                err(f"direct switch failed: {r.get('error','?')}")
            data = fetch()
        elif action == "test" and cur:
            # THE live read: the router pings this one subscription (1 token) and
            # returns a fresh reading — or the reason it can't (429 vs OAuth dead).
            name = cur["name"]
            busy(f"live-testing {name} via the router (1 token)…")
            r = _asdict(_llm_post("claudecode/limits", {"account": name}, timeout=45))
            rd = _asdict(r.get("reading"))
            if rd:
                ok(f"{name}: 5h {round((rd.get('u5') or 0) * 100)}% / "
                   f"7d {round((rd.get('u7') or 0) * 100)}% used · live ✓")
                _live_refresh()
            else:
                why = r.get("reason") or r.get("error") or "no reading"
                err(f"{name}: {why}")
        elif action in ("reveal", "rename", "add"):
            # Tokens are server-side and never revealed; pool naming/creation is
            # edited in the llm.hostbun.cc panel.
            info("router-managed pool — add / rename accounts (and their tokens) "
                 "in the llm.hostbun.cc panel; cccc pins, it doesn't own them")
        elif action == "delete" and cur:
            name = cur["name"]
            if not _confirm(stdscr, f"delete account '{name}' from the router pool? "
                                    f"IRREVERSIBLE — needs a fresh setup-token to re-add"):
                info("delete cancelled")
            else:
                busy(f"removing {name} from the pool…")
                r = _llm_post("accounts/remove", {"account": name})
                if isinstance(r, dict) and r.get("ok"):
                    ok(f"{name} removed from the pool")
                else:
                    err(f"remove failed: {(r or {}).get('error', '?')}")
                data = fetch()
            stdscr.timeout(REFRESH_MS)
        elif action == "live_probe":
            busy(f"live limit check · router pings every subscription (1 token × {len(data['rows'])})…")
            r = _llm_post("claudecode/limits", {"all": True}, timeout=120)
            accts = (r or {}).get("accounts") if isinstance(r, dict) else None
            if accts is not None:
                got = sum(1 for a in accts if isinstance(a, dict) and a.get("reading"))
                _live_refresh()
                data = fetch()
                ok(f"live limits refreshed · fresh reading on {got}/{len(accts)} accounts")
            else:
                err(f"live probe failed: {(r or {}).get('error', '?')}")
        elif action == "refresh":
            busy("refreshing accounts from the router…")
            data = fetch()
            ok(f"refreshed · {len(data['rows'])} accounts")
        elif action == "version_check":
            busy("checking against origin/master…")
            res = _version_check(autosync=False)
            if res.get("state") == "behind" and _confirm(
                    stdscr, f"{res.get('behind')} commit(s) behind origin — sync now?"):
                busy("syncing (git pull + re-vendor)…")
                _run_external(stdscr, ["python3", _SYNC_SCRIPT])
                res = _version_check(autosync=False)
            busy("verifying install (install.sh self-check)…")
            _run_external(stdscr, ["sh", os.path.join(os.path.dirname(_HERE), "install.sh")])
            ok(f"version {res.get('sha')} · {res.get('state')}"
               + (" — restart cccc to load it" if res.get("state") == "updated" else ""))
            stdscr.timeout(REFRESH_MS)
        elif action == "doctor":
            busy("running doctor…")
            _run_external(stdscr, ["python3", _DOCTOR_SCRIPT])
            _doctor_check()                       # refresh the header chip too
            ok("doctor done")
            stdscr.timeout(REFRESH_MS)
        elif action == "doctor_fix":
            busy("doctor --fix (enabling missing LSP plugins)…")
            _run_external(stdscr, ["python3", _DOCTOR_SCRIPT, "--fix"])
            _doctor_check()
            ok("doctor --fix done" + ("" if _DOC.get("ok") else f" · {_DOC.get('n')} issue(s) remain"))
            stdscr.timeout(REFRESH_MS)
        elif action == "dock":
            _run_external(stdscr, ["python3", _DOCK_SCRIPT])
            stdscr.timeout(REFRESH_MS)
        elif action == "panes":
            _run_external(stdscr, ["python3", _PANES_SCRIPT])
            stdscr.timeout(REFRESH_MS)
        elif action == "toggle_direct":
            if os.path.exists(_FORCE_DIRECT_FLAG):
                _set_force_direct(False)
                ok("route: GATEWAY — direct-connect off · new panes route through llm.hostbun.cc")
            else:
                _set_force_direct(True)
                ok("route: DIRECT — bypassing router · new panes hit api.anthropic.com "
                   "(open a new pane / re-source rc for running ones)")
        elif action == "sync":
            restart = _confirm(stdscr, "sync: git-pull this checkout. also restart ccc panes onto new code?")
            busy("syncing (git pull + re-vendor)…")
            _run_external(stdscr, ["python3", _SYNC_SCRIPT] + (["--restart"] if restart else []))
            ok("sync done")
            stdscr.timeout(REFRESH_MS)
        elif action == "fleet_restart":
            n = len(_claude_surfaces())
            if _confirm(stdscr, f"restart ALL {n} ccc sessions? kill+resume each → reloads plugins "
                                f"& current account, interrupts in-flight work"):
                busy(f"restarting {n} pane(s) · reloading plugins + current account…")
                _run_external(stdscr, ["python3", _REFRESH_SCRIPT, "--go"])
                ok(f"restarted {n} pane(s) · each resumed on the current account")
                stdscr.timeout(REFRESH_MS)
        elif action == "fleet_model":
            mdl = _prompt(stdscr, "set model on ALL sessions → ")
            if mdl:
                busy(f"broadcasting /model {mdl} to all running panes…")
                n = _broadcast(f"/model {mdl}", confirm=True)
                ok(f"/model {mdl} sent to {n} pane(s)")
        elif action == "fleet_effort":
            ef = _prompt(stdscr, "set effort on ALL sessions (low/medium/high) → ")
            if ef:
                busy(f"broadcasting /effort {ef} to all running panes…")
                n = _broadcast(f"/effort {ef}")
                ok(f"/effort {ef} sent to {n} pane(s)")
        elif action == "fleet_broadcast":
            cmd = _prompt(stdscr, "broadcast to ALL sessions → ")
            if cmd:
                busy("broadcasting to all running panes…")
                n = _broadcast(cmd)
                ok(f"sent to {n} pane(s)")
        elif action == "fleet_reload_plugins":
            busy("broadcasting /reload-plugins --force to all running panes…")
            n = _broadcast("/reload-plugins --force", confirm=True)
            ok(f"/reload-plugins --force sent to {n} pane(s)")
        elif action == "fleet_kill_one":
            busy("finding running claude windows…")
            wins = _claude_windows()
            if not wins:
                info("no other running claude windows to kill")
            else:
                items = [(w["label"], w["pid"],
                          f"Stop this claude agent now (pid {w['pid']}, {w['surface'][:8]}). "
                          f"Pane drops to a shell — no resume.") for w in wins]
                pidsel = _menu(stdscr, "kill which window?", items)
                if pidsel:
                    w = next(x for x in wins if x["pid"] == pidsel)
                    if _confirm(stdscr, f"kill {w['label']}?  (stops the agent, no resume)"):
                        busy(f"killing pid {pidsel}…")
                        ok(f"killed {w['label']}" if _kill_window(pidsel)
                           else f"kill failed for pid {pidsel}")
        elif action == "fleet_kill_all":
            busy("finding running claude windows…")
            wins = _claude_windows()
            if not wins:
                info("no other running claude windows to kill")
            elif _confirm(stdscr, f"KILL all {len(wins)} running claude windows?  "
                                  f"(stops them now, no resume — your own is untouched)"):
                busy(f"killing {len(wins)} window(s)…")
                n = sum(_kill_window(w["pid"]) for w in wins)
                ok(f"killed {n}/{len(wins)} window(s) · panes dropped to a shell")

    while True:
        rows = data["rows"]
        n_acct = len(rows)
        # Accounts tab: the cursor walks the account rows THEN the pool-action rows
        # below them, so `sel` ranges over n_acct + len(_POOL_ITEMS).
        sel = max(0, min(sel, n_acct + len(_POOL_ITEMS) - 1))
        cur = rows[sel] if sel < n_acct else None   # None when a pool-action row is selected
        stdscr.erase()
        h, w = stdscr.getmaxyx()
        tab_key = TABS[tab][0]

        def render_list(items, lsel, base):
            """Draw a ↑↓-navigable action list + a one-line description of the
            highlighted row, so every action states what it does."""
            for i, (lbl, v, desc) in enumerate(items):
                y = base + i
                if y >= h - 4:
                    break
                active = (i == lsel)
                pointer = "▸ " if active else "  "
                put(y, 2, f"{pointer}{lbl}"[:w - 3],
                    (curses.A_REVERSE | curses.A_BOLD) if active else curses.A_NORMAL)
            put(h - 4, 0, ("─" * w)[:w], C_DIM)
            for j, dl in enumerate(_wrap(items[lsel][2], w - 4)[:1]):
                put(h - 3, 2, dl[:w - 3], C_CYAN)

        # ---- title + tab bar (rows 0-1) --------------------------------------
        host_str = LLM_ADMIN.split('://')[-1]
        age = (f"live {int(time.time() - _LIVE_AT)}s ago" if _LIVE_AT else "probing…")
        dot = ("● " if _LIVE else "◌ ") + age
        # full-width brand bar: name left, host middle-dim, live-dot right
        stdscr.addstr(0, 0, " " * w, C_HEADER)
        put(0, 1, "claudectl", C_HEADER)
        x0 = put(0, 11, f"cccc · {host_str}", curses.color_pair(7))
        # version + doctor chips from the launch-time background checks
        _vst = _VER.get("state", "")
        if _vst == "latest":
            x0 = put(0, x0 + 1, f"✓{_VER['sha']}", curses.color_pair(7) | curses.A_DIM)
        elif _vst == "updated":
            x0 = put(0, x0 + 1, "⬆ updated — restart cccc", C_WARN | curses.A_BOLD)
        elif _vst == "behind":
            x0 = put(0, x0 + 1, f"⬆ {_VER.get('behind', '?')} behind — Setup→sync", C_WARN)
        elif _vst == "err":
            x0 = put(0, x0 + 1, "ver?", curses.A_DIM)
        if _DOC:
            if _DOC.get("ok"):
                x0 = put(0, x0 + 1, "· doctor✓", curses.color_pair(7) | curses.A_DIM)
            else:
                x0 = put(0, x0 + 1, f"· doctor {_DOC.get('n') or '?'}✗ → Setup", C_WARN)
        # always-visible ROUTE chip: is THIS box hitting the router or bypassing it?
        _rs = _route_state()
        _rattr = {"ok": curses.color_pair(7) | curses.A_BOLD, "warn": C_WARN | curses.A_BOLD,
                  "err": C_HOT | curses.A_BOLD, "dim": curses.color_pair(7) | curses.A_DIM}[_rs[2]]
        put(0, x0 + 1, f"· {_rs[1]}", _rattr)
        put(0, max(11, w - len(dot) - 1), dot,
            curses.color_pair(7) | (curses.A_BOLD if _LIVE else curses.A_DIM))
        tx = 1
        for i, (k, label) in enumerate(TABS):
            if i == tab:
                tx = put(1, tx, f" {label} ", C_ACCENT | curses.A_REVERSE)
            else:
                tx = put(1, tx, f" {label} ", C_DIM)
            tx = put(1, tx, " ", C_DIM)

        # ---- body per tab ----------------------------------------------------
        if tab_key == "accounts":
            ok_cap, summ = live_summary()
            # put(), not stdscr.addstr: a pane shorter than these rows makes curses
            # raise, and an unguarded raise here kills the whole dashboard.
            put(2, 0, summ[:w], (C_GREEN if ok_cap else C_HOT) if _LIVE else C_DIM)
            loc = next((r["name"] for r in rows if r.get("local")), None)
            put(3, 0, (f"★ PINNED: {loc}   (what `claude`/`ccc` launches as)" if loc
                       else "★ PINNED: (none — ↵ on an account → switch to pin it)")[:w],
                C_ACTIVE if loc else C_WARN)
            put(4, 0, ("  bars = % USED (green ok · yellow busy · red almost gone)  ·  "
                       "WEEKLY is the binding limit  ·  ★ pinned acct  ● gateway active")[:w], C_DIM)
            # column x-positions must mirror the row draw below: mark(2) + name(12)
            # + ·org(6) + state(9) + weekly bar(11) + " · reset"(9) + " date"(11)
            # + " " + 5h bar(11) + " · reset"(9)
            put(5, 0, f"  {'ACCOUNT':<12}{'ORG':<6}{'STATE':<9}{'WEEKLY':<11}{' · RESETS':<9}{' (DATE)':<11} {'5-HOUR':<11}{' · RESETS':<9}  BOX",
                C_ACCENT | curses.A_UNDERLINE)
            if data["err"]:
                put(h - 5, 2, f"! {data['err']}"[:w - 3], C_HOT)
            for idx, r in enumerate(rows):
                y = 6 + idx
                if y >= h - 4:
                    break
                rev = curses.A_REVERSE if idx == sel else 0
                lv = _LIVE.get(r["name"], {})            # live ground truth (may be empty)
                usable = lv.get("usable", None)
                u7 = lv.get("u7", r["u7"])               # prefer LIVE 7d over the cached value
                u5 = lv.get("u5", r["u5"])
                dead = usable is False
                mark = "★" if r.get("local") else ("●" if r["active"] else " ")
                nameattr = ((C_HOT if dead else C_ACTIVE if r.get("local") else curses.A_NORMAL)) | rev
                # STATE: one plain word.
                if dead:
                    state, statt = "USED UP", C_HOT
                elif (r["status"] or "") == "error":
                    state, statt = "error", C_HOT
                elif r.get("local"):
                    state, statt = "in use", C_ACTIVE
                elif r["active"]:
                    state, statt = "active", C_GREEN
                else:
                    state, statt = "ready", C_DIM
                x = put(y, 0, f"{mark} ", nameattr)
                x = put(y, x, f"{r['name'][:11]:<12}", nameattr)
                # org suffix — tells look-alike names apart (claudemejlto vs claude2mejlto)
                o4 = (r.get("org") or "")[:4]
                x = put(y, x, f"·{o4} " if o4 else "     ", C_DIM | rev)
                x = put(y, x, f"{state:<9}", statt | rev)
                # WEEKLY (binding): used-bar + %, then reset countdown
                x = draw_used_bar(y, x, u7, rev)
                if dead:
                    lim = "7d" if lv.get("s7") == "rejected" else "5h"
                    rh = lv.get("reset7_h" if lim == "7d" else "reset5_h")
                    reset = f"{rh}h" if rh is not None else "?"
                else:
                    reset = (r.get("r7") or "").replace(" ", "") or "—"
                x = put(y, x, f" · {reset:<6}", C_DIM | rev)
                x = put(y, x, f" {r.get('d7') or '':<10}", C_DIM | rev)
                # 5-HOUR: used-bar + %, then ITS reset countdown
                x = put(y, x, " ", rev)
                x = draw_used_bar(y, x, u5, rev)
                r5 = (r.get("r5") or "").replace(" ", "") or "—"
                x = put(y, x, f" · {r5:<6}", C_DIM | rev)
                # BOX: machines verified on this account
                machs = r.get("machines") or []          # boxes verified on this account
                if machs and x < w - 2:
                    put(y, x + 2, ("⌂" + ",".join(machs))[:w - x - 3], C_CYAN | rev)
            # pool-wide account actions, as selectable rows below the account list
            pool_base = 6 + n_acct + 1
            put(pool_base - 1, 2, ("─ manage " + "─" * 44)[:w - 3], C_DIM)
            for j, (lbl, v, desc) in enumerate(_POOL_ITEMS):
                y = pool_base + j
                if y >= h - 4:
                    break
                active = (sel == n_acct + j)
                pointer = "▸ " if active else "  "
                put(y, 2, f"{pointer}{lbl}"[:w - 3],
                    (curses.A_REVERSE | curses.A_BOLD) if active else curses.A_NORMAL)
            # bottom line: detail for a selected account, else the pool action's blurb
            if cur:
                org = cur.get("org") or ""
                org_short = (org.split("-")[0] if "-" in org else org[:8]) if org else "no-org?"
                # weekly (7d) is the binding limit → lead with it, plain words.
                def _left(u):
                    return f"{100 - u:.0f}" if isinstance(u, (int, float)) else "?"
                det = (f"  {cur['name']}:  WEEKLY {_left(cur['u7'])}% left · resets {cur.get('c7') or '?'} "
                       f"(in {cur['r7'] or '—'})    ·    5h {_left(cur['u5'])}% left · resets "
                       f"{cur.get('c5') or '?'} (in {cur['r5'] or '—'})    ·    org {org_short}")
                put(h - 3, 0, det[:w], C_CYAN)
            elif sel >= n_acct:
                put(h - 3, 2, _wrap(_POOL_ITEMS[sel - n_acct][2], w - 4)[0][:w - 3], C_CYAN)
            put(h - 2, 0, "←→ tab   ↑↓ move   ↵ open / run   q quit"[:w], C_DIM)

        elif tab_key == "plugins":
            n_proj = len(pl_projects)
            list_sel["plugins"] = max(0, min(list_sel["plugins"],
                                             n_proj + len(_PLUGIN_POOL) - 1))
            plsel = list_sel["plugins"]
            if not pl_cfg:
                put(2, 0, "  plugin-profiles.json not found / unreadable."[:w], C_HOT)
                put(4, 0, f"  expected at: {pp.CONFIG_PATH}"[:w], C_DIM)
            else:
                core_n = len(pp.core_ids(pl_cfg))
                put(2, 0, ("  per-project plugin sets — cut the ~350K tool-schema tax "
                           "every request pays")[:w], C_DIM)
                put(3, 0, (f"  core = {core_n} plugins (loads everywhere)   "
                           "● applied  ~ drift  ○ inherits global  · not on box")[:w], C_DIM)
                put(4, 0, f"  {'PROJECT':<22}{'STATE':<10}{'#':>3}  PACKS"[:w],
                    C_ACCENT | curses.A_UNDERLINE)
                for i, proj in enumerate(pl_projects):
                    y = 5 + i
                    if y >= h - 4:
                        break
                    st = pp.status(pl_cfg, proj)
                    glyph, col = {"applied": ("●", C_GREEN), "drift": ("~", C_WARN),
                                  "inherit": ("○", C_DIM), "no-repo": ("·", C_DIM)
                                  }.get(st, ("?", C_DIM))
                    rev = curses.A_REVERSE if i == plsel else 0
                    cnt = len(pp.resolve(pl_cfg, proj))
                    packs = " ".join(pp.project_packs(pl_cfg, proj)) or "core only"
                    line = f"{glyph} {proj[:20]:<21}{st:<10}{cnt:>3}  {packs}"
                    put(y, 0, line[:w], col | (curses.A_BOLD if i == plsel else 0) | rev)
                pool_base = 5 + n_proj + 1
                put(pool_base - 1, 2, ("─ actions " + "─" * 44)[:w - 3], C_DIM)
                for j, (lbl, _v, _d) in enumerate(_PLUGIN_POOL):
                    y = pool_base + j
                    if y >= h - 4:
                        break
                    active = (plsel == n_proj + j)
                    put(y, 2, f"{'▸ ' if active else '  '}{lbl}"[:w - 3],
                        (curses.A_REVERSE | curses.A_BOLD) if active else curses.A_NORMAL)
                if plsel < n_proj:
                    proj = pl_projects[plsel]
                    path = pp.repo_path(proj) or "(not on this box)"
                    put(h - 3, 0, f"  {proj}: {len(pp.resolve(pl_cfg, proj))} plugins → {path}"[:w], C_CYAN)
                elif plsel - n_proj < len(_PLUGIN_POOL):
                    put(h - 3, 2, _wrap(_PLUGIN_POOL[plsel - n_proj][2], w - 4)[0][:w - 3], C_CYAN)
            put(h - 2, 0, "←→ tab   ↑↓ move   ↵ apply / show   q quit"[:w], C_DIM)

        else:  # windows / setup
            items = _TAB_ITEMS[tab_key]
            if tab_key == "setup":
                # make the route toggle SELF-DESCRIBING: label states current mode + what ↵ does.
                _rs = _route_state()
                _tlabel = ("route: ⚡ DIRECT (bypassing router) — ↵ to route via gateway" if _rs[0] == "direct"
                           else "route: ▸ ROUTER (llm.hostbun.cc) — ↵ to force DIRECT bypass")
                items = [((_tlabel, v, d) if v == "toggle_direct" else (l, v, d)) for (l, v, d) in items]
            put(2, 0, {"windows": "  Windows — every action hits ALL your running claude/ccc windows",
                       "setup": "  Setup — maintain the cccc tool on this machine"}[tab_key][:w], C_DIM)
            if tab_key == "setup":
                # live verdicts from the launch-time background checks
                _v = _VER.get("state", "checking…")
                _dline = ("doctor: checking…" if not _DOC else
                          "doctor: ✓ all good" if _DOC.get("ok") else
                          f"doctor: {_DOC.get('n')}✗ · {_DOC.get('first', '')}")
                put(3, 2, f"version: {_VER.get('sha', '?')} ({_v})   ·   {_dline}"[:w - 3],
                    C_WARN if (_DOC and not _DOC.get("ok")) or _v in ("behind", "updated") else C_DIM)
            render_list(items, list_sel[tab_key], 4)
            put(h - 2, 0, "←→ tab   ↑↓ move   ↵ run   q quit"[:w], C_DIM)

        paint_status()
        stdscr.refresh()

        ch = stdscr.getch()
        if ch == -1:            # idle timeout -> auto-refetch latest from the gateway
            data = fetch()
            continue
        if ch in (ord("q"), 27):
            return
        elif ch == curses.KEY_LEFT:
            tab = (tab - 1) % len(TABS)
        elif ch == curses.KEY_RIGHT:
            tab = (tab + 1) % len(TABS)
        elif tab_key == "accounts":
            total = n_acct + len(_POOL_ITEMS)
            if ch == curses.KEY_DOWN:
                sel = min(sel + 1, total - 1)
            elif ch == curses.KEY_UP:
                sel = max(sel - 1, 0)
            elif ch in (10, 13):
                if sel < n_acct and cur:                     # account row → per-account menu
                    picked = _menu(stdscr, f"account · {cur['name']}", _ACCOUNT_ITEMS)
                    if picked:
                        dispatch(picked, cur)
                elif sel >= n_acct:                          # pool-action row → run it
                    dispatch(_POOL_ITEMS[sel - n_acct][1], cur)
        elif tab_key == "plugins":
            n_proj = len(pl_projects)
            total = n_proj + len(_PLUGIN_POOL)
            if ch == curses.KEY_DOWN:
                list_sel["plugins"] = min(list_sel["plugins"] + 1, total - 1)
            elif ch == curses.KEY_UP:
                list_sel["plugins"] = max(list_sel["plugins"] - 1, 0)
            elif ch in (10, 13):
                s = list_sel["plugins"]
                if s < n_proj:                               # project row → per-project menu
                    proj = pl_projects[s]
                    picked = _menu(stdscr, f"plugins · {proj}", [
                        ("apply → write .claude/settings.json", "apply",
                         f"Write the full set ({len(pp.resolve(pl_cfg, proj))} plugins) into "
                         f"{proj}/.claude/settings.json (replaces enabledPlugins, keeps other keys). "
                         "Restart claude in that repo to take effect."),
                        ("show full plugin list", "show",
                         "List every plugin id this project would enable (core + its packs)."),
                    ])
                    if picked == "apply":
                        busy(f"writing {proj}/.claude/settings.json…")
                        r = pp.apply_project(pl_cfg, proj)
                        (ok if r.get("ok") else err)(
                            f"{proj}: wrote {r.get('count')} plugins → restart claude there to apply"
                            if r.get("ok") else f"{proj}: {r.get('error')}")
                    elif picked == "show":
                        _popup(stdscr, f"{proj} · {len(pp.resolve(pl_cfg, proj))} plugins",
                               "\n".join(pp.resolve(pl_cfg, proj)))
                else:                                        # pool-action row
                    act = _PLUGIN_POOL[s - n_proj][1]
                    if act == "plugin_global":
                        if _confirm(stdscr, f"write lean global? (~/.claude/settings.json = "
                                            f"{len(pp.core_ids(pl_cfg))} core plugins)"):
                            busy("writing lean global settings…")
                            r = pp.apply_global_lean(pl_cfg)
                            (ok if r.get("ok") else err)(
                                f"lean global applied: {r.get('count')} core plugins · "
                                "restart claude to take effect"
                                if r.get("ok") else f"failed: {r.get('error')}")
                    elif act == "plugin_apply_all":
                        on_box = [p for p in pl_projects if pp.repo_path(p)]
                        if _confirm(stdscr, f"write .claude/settings.json into {len(on_box)} "
                                            f"repos on this box?"):
                            busy(f"applying {len(on_box)} repos…")
                            done = sum(1 for p in on_box if pp.apply_project(pl_cfg, p).get("ok"))
                            ok(f"applied {done}/{len(on_box)} repos · restart claude in each")
                    elif act == "plugin_reload":
                        pl_cfg = pp.load()
                        pl_projects = pp.projects(pl_cfg)
                        ok(f"config reloaded · {len(pl_projects)} projects")
        else:  # windows / setup list tabs
            items = _TAB_ITEMS[tab_key]
            n = len(items)
            if ch == curses.KEY_DOWN:
                list_sel[tab_key] = (list_sel[tab_key] + 1) % n
            elif ch == curses.KEY_UP:
                list_sel[tab_key] = (list_sel[tab_key] - 1) % n
            elif ch in (10, 13):
                dispatch(items[list_sel[tab_key]][1], cur)


def _guard(quiet=False, fix=False) -> int:
    """Subscription-only audit: prove nothing can spend pay-per-token API credits.
    A Max login is an OAuth token (sk-ant-oat); when its limit is hit it just BLOCKS.
    Billed usage only happens if an API key / auth token / apiKeyHelper is present —
    so this checks every place one could hide. `cccc guard` (—fix strips settings ones)."""
    fails = []
    warn = []
    # 1. environment this shell (panes inherit it)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        if os.environ.get(k):
            fails.append(f"env {k} is set → claude would BILL. `unset {k}` (and remove from your shell rc).")
    if os.environ.get("ANTHROPIC_BASE_URL"):
        warn.append(f"env ANTHROPIC_BASE_URL={os.environ['ANTHROPIC_BASE_URL']} → routes through a proxy (not direct subscription).")
    # 2. settings.json: apiKeyHelper / env keys
    sp = os.path.expanduser("~/.claude/settings.json")
    try:
        cfg = json.load(open(sp))
    except Exception:
        cfg = {}
    changed = False
    if cfg.get("apiKeyHelper"):
        fails.append(f"settings.json apiKeyHelper is set → injects an API key (BILLED).")
        if fix:
            cfg.pop("apiKeyHelper", None); changed = True
    env = cfg.get("env") or {}
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        if k in env:
            fails.append(f"settings.json env.{k} is set (BILLED).")
            if fix:
                env.pop(k, None); changed = True
    if changed:
        cfg["env"] = env
        json.dump(cfg, open(sp, "w"), indent=2)
    # 3. the actual login token in the keychain
    blob = _kc_read()
    tok = (blob.get("claudeAiOauth") or {}).get("accessToken", "") if isinstance(blob, dict) else ""
    if tok and not str(tok).startswith("sk-ant-oat"):
        fails.append(f"keychain login is {'an API key (BILLED)' if str(tok).startswith('sk-ant-api') else 'not a Max OAuth token'} — `cccc` switch to a real account.")

    def out(m):
        if not quiet:
            print(m)
    if fails:
        out("✗ NOT subscription-only — pay-per-token paths found:")
        for f in fails:
            out(f"  ✗ {f}")
        for w in warn:
            out(f"  · {w}")
        if fix and changed:
            out("  ✓ stripped the settings.json ones. Re-run to confirm.")
        return 1
    out("✓ subscription-only: no API key / auth token / apiKeyHelper anywhere. "
        "A limit will just BLOCK — never spend paid tokens.")
    for w in warn:
        out(f"  · {w}")
    return 0


# Names that USED to be symlinks straight at this file, with the subcommand
# recovered from argv[0]. A box that pulled the new code but never re-ran
# install.sh still has those symlinks; landing here under one of these names now
# means the dispatch is gone, and we would silently open the dashboard instead of
# the screen that was asked for. Say so instead. (This reads argv[0] only to
# refuse — never to choose a subcommand.)
_STALE_SYMLINK_NAMES = ("cmuxdock", "cccl", "cccp", "cccd", "cccr", "cccs")


def main():
    argv = sys.argv[1:]
    # The one-word Dock commands (cmuxdock/cccp/cccd/…) are generated wrapper
    # scripts on PATH that pass their subcommand explicitly — see install.sh.
    # Nothing here reads argv[0] to decide what to run; what you type is what runs.
    _self = os.path.basename(sys.argv[0])
    if _self in _STALE_SYMLINK_NAMES:
        sys.stderr.write(
            f"cccc: `{_self}` is still a symlink from an older install, but the\n"
            f"      argv[0] dispatch it relied on is gone. Re-run the installer:\n"
            f"          sh {os.path.join(os.path.dirname(_HERE), 'install.sh')}\n"
            f"      (or `cccc sync`, which re-runs it for you)\n")
        return 2
    # `cccc` is the single entry point. A leading subcommand runs the matching
    # tool headlessly (for cron/scripts); no subcommand opens the TUI, where the
    # same actions live as menu items.
    if argv and argv[0] == "guard":
        return _guard(quiet="--quiet" in argv, fix="--fix" in argv)
    if argv and argv[0] in _SUBCMDS:
        script = _SUBCMDS[argv[0]]
        if not os.path.exists(script):
            # `dock`/`links` live in the devdashco/claudectl repo (the cmuxdock
            # plugin) since the cccc/ move — this checkout doesn't ship them.
            sys.stderr.write(f"cccc: `{argv[0]}` is not in this checkout — the cmux Dock "
                             f"moved to the devdashco/claudectl repo (cmuxdock plugin).\n")
            return 2
        os.execvp("python3", ["python3", script, *argv[1:]])
    if argv and argv[0] in ("-h", "--help"):
        print("cccc — claudectl dashboard (single command; all actions inside)\n\n"
              "  cccc                       open the TUI (pin an account, watch limits)\n"
              "  cccc sync [--quiet]        git-pull this checkout + re-vendor (cron uses this)\n"
              "  cccc refresh [--go]        restart running ccc panes onto the current code\n"
              "  cccc doctor                LSP / environment health check\n"
              "  cccc guard [--fix]         verify subscription-only (no billed API-token path)\n"
              "  cccc panes [--list]        pick a cmux pane and respawn it (restart an MCP / resume claude)\n")
        return
    try:
        curses.wrapper(run)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    raise SystemExit(main())
