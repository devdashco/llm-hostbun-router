#!/usr/bin/env python3
"""claudectl statusline — one self-contained renderer for every Claude Code pane.

Folds the old 5-script chain (statusline-ratelimits + headroom + statusline-command
+ cc-profile) into a single file with ZERO external deps beyond python3 — no jq, no
Headroom required. install.sh vendors this and points settings.json at it, so every
machine/session shows the byte-identical line:

    📁…/repo · ⑂branch±3 · opus · ctxfree▇67%
    👤acct✓·direct 5h▇88%↻2h 7d▂27%↻4d · cctl:sha

The context + limit gauges read as "how much is LEFT" (green→plenty, red→nearly
out), with a compact "↻2h" = time until that window resets, instead of the raw
used-% and an absolute wall-clock the reader had to subtract in their head.

The account ICON + `·route` tag say WHERE the request goes — the thing that used to
be invisible (👤 and 📡 both rendered as 👤, so a gateway-picked account looked
identical to your own keychain pin):
    👤acct✓·direct              no ANTHROPIC_BASE_URL → api.anthropic.com on the
                                keychain token cccc pinned. YOUR account, no gateway.
    📡acct·llm.hostbun.cc       gateway pool picks/bills the account SERVER-side
                                (`⚠auto` = this box is unmapped and rotating)
    🌐host·gateway              some other base URL
    🔑key·BILLED                pay-per-token API key (not a subscription)

The account NAME is coloured by its hottest window (worst of 5h/7d LEFT): green =
≥50% left, yellow = 20–49% left, red = <20% left, uncoloured = no reading. Staleness
is never silent: red `⌛stale` = the background refresh itself has failed for 10+ min
(numbers frozen; colour dropped), dim `⌛3h old` = refresh works but the harvested
reading is old because the account has served no traffic (idle accounts keep their
last reading — the router only learns from real responses).

Reads Claude Code's status JSON on stdin. Any segment whose data is absent this turn
is simply omitted — nothing is fabricated (e.g. rate-limit segments only appear once
the session has had one API response).

Optional side-effects, only if the files exist (so an existing Headroom / ClaudeWatch
menu-bar app keeps working): mirrors stdin to ~/.claude/headroom-usage.json and feeds
~/.claude/claudewatch-feed.sh.
"""
import json
import os
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
_VER_CACHE = f"{HOME}/.claude/.cctl-version"   # epoch\tvalue — refreshed lazily
_VER_TTL = 60                                  # sha only moves on a git pull
_SYNC_STAMP = f"{HOME}/.claude/.cctl-autosync" # last background-sync epoch
_SYNC_EVERY = 1800                             # self-sync at most every 30 min

# --- whoami: API-verified account ------------------------------------------
# The ★ (~/.claude-accounts/.cccc-local) is a cheap LOCAL claim of which account
# is loaded. To *prove* it we ask Anthropic itself — a tiny message call returns
# `anthropic-organization-id`, which we map (via the gateway account list) to a
# cccc account name. Ground truth: it reflects the real keychain token, not any
# file cccc/Claude may have left stale. Too slow for the render path (2 network
# calls), so a THROTTLED background pass (`--whoami`) writes the result to a cache
# and every render just reads it — the line shows `✓` once confirmed.
_ACCT_STAR = f"{HOME}/.claude-accounts/.cccc-local"
_WHO_CACHE = f"{HOME}/.claude/.cctl-whoami"        # epoch\torgid\tname
_WHO_STAMP = f"{HOME}/.claude/.cctl-whoami-stamp"  # last spawn (throttle, even on fail)
_WHO_TTL = 1800                                    # re-verify at most every 30 min
_WHO_MINGAP = 60                                   # never spawn more than 1×/min
# fleet presence: publish this box's verified account to the claudectl MCP server
# so the /fleet page + cccc TUI can show who's-using-what across machines.
_MCP_BASE = os.environ.get("CLAUDECTL_MCP", "https://claudectl.hostbun.cc").rstrip("/")
_MCP_BEARER = os.environ.get("CLAUDECTL_MCP_BEARER", "ddash")
_MACHINE_FILE = f"{HOME}/.claude-accounts/.cccc-machine"   # this box's fleet name
# anthropic-lane rotation: when this box routes claude through the rotating llm.hostbun.cc proxy,
# the SERVING Max account is chosen server-side (sticky, switch-on-limit). A throttled background
# pass reads the proxy's current sticky account + its harvested 5h/7d headroom into a cache the
# statusline renders — so you always see WHO is serving and how hot they are.
_LLM_ADMIN = os.environ.get("CCTL_LLM_ADMIN", "https://llm.hostbun.cc").rstrip("/")
_LLM_PW = os.environ.get("CCTL_LLM_PW", "ddash")
_POOL_CACHE = f"{HOME}/.claude/.cctl-anthropic"    # epoch\tname\tu5\tu7\tstatus\torg\tsource\treading_ts(ms)
_POOL_TTL = 40                                     # cache freshness before a background refresh
# --- failed-MCP segment ----------------------------------------------------
# `claude mcp list` health-checks every configured server (~10s — WAY too slow for
# the render path), printing `✘ Failed to connect` for the dead ones. So a throttled
# background pass runs it, caches the failed server names, and every render just reads
# the cache: the line loudly shows `⚠mcp✗app-db-nas` whenever a server is down, empty
# once all reconnect. Always-on so a silently-dead MCP can't hide.
_MCP_CACHE = f"{HOME}/.claude/.cctl-mcp"           # epoch\tfailed,comma,names
_MCP_STAMP = f"{HOME}/.claude/.cctl-mcp-stamp"     # last spawn (throttle, even on fail)
_MCP_TTL = 300                                     # re-check health at most every 5 min
_MCP_MINGAP = 90                                   # never spawn more than 1× / 90s


def _machine() -> str:
    """The name this box shows up as on the fleet page. Raw socket.gethostname()
    is unreliable (pmac's is literally 'p'), so prefer an explicit, stable name:
      $CLAUDECTL_MACHINE  →  ~/.claude-accounts/.cccc-machine  →  hostname."""
    name = os.environ.get("CLAUDECTL_MACHINE", "").strip()
    if not name:
        try:
            with open(_MACHINE_FILE) as f:
                name = f.read().strip()
        except OSError:
            name = ""
    if not name:
        import socket
        name = socket.gethostname().split(".")[0]
    return name or "?"

# --- LSP coverage segment --------------------------------------------------
# Claude Code consumes Language Servers via the official *-lsp plugins, enabled
# (globally, one-per-language) in ~/.claude/settings.json. The statusline calls
# it out: quiet ✓ when the current project's language is covered, LOUD red ✗
# when you're sitting in e.g. a Swift repo with swift-lsp off. `cccc doctor` is the
# full-fleet audit; this is the per-pane "does THIS repo have its LSP" glance.
_LSP_MARKETPLACE = "claude-plugins-official"
_LANG_LSP = {
    "TS/JS": "typescript-lsp", "Python": "pyright-lsp", "Go": "gopls-lsp",
    "Rust": "rust-analyzer-lsp", "Ruby": "ruby-lsp", "PHP": "php-lsp",
    "Swift": "swift-lsp", "Java": "jdtls-lsp", "Kotlin": "kotlin-lsp",
    "C#": "csharp-lsp", "Lua": "lua-lsp", "C/C++": "clangd-lsp",
}
_LANG_SHORT = {
    "TS/JS": "ts", "Python": "py", "Go": "go", "Rust": "rs", "Ruby": "rb",
    "PHP": "php", "Swift": "swift", "Java": "java", "Kotlin": "kt",
    "C#": "cs", "Lua": "lua", "C/C++": "c",
}
_RED, _DIM, _RST = "\033[31m", "\033[2m", "\033[0m"
_GRN, _YEL = "\033[32m", "\033[33m"
_BLD = "\033[1m"
_GAUGE = "▁▂▃▄▅▆▇█"


def _health(rem: float) -> str:
    """Color by how much budget is LEFT: green plenty, yellow tight, red nearly out."""
    return _GRN if rem >= 50 else _YEL if rem >= 20 else _RED


def _bar(rem: float) -> str:
    """One block char, taller = more remaining."""
    return _GAUGE[min(7, max(0, int(rem / 100 * 8 - 1e-9)))]


def _rel(epoch) -> str:
    """epoch → compact 'until reset' countdown: 45m / 2h / 4d ('now' if past)."""
    if not epoch:
        return ""
    try:
        secs = float(str(epoch).split(".")[0]) - time.time()
    except ValueError:
        return ""
    if secs <= 0:
        return "now"
    if secs < 3600:
        return f"{max(1, round(secs / 60))}m"
    if secs < 86400:
        return f"{round(secs / 3600)}h"
    return f"{round(secs / 86400)}d"


def _gauge_seg(label: str, rem: float, epoch=None) -> str:
    """`label ▆88%↻2h` — dim label, health-colored gauge+pct, dim reset countdown."""
    rem = round(rem)
    body = f"{_DIM}{label}{_RST}{_health(rem)}{_bar(rem)}{rem}%{_RST}"
    r = _rel(epoch)
    return f"{body}{_DIM}↻{r}{_RST}" if r else body


def _box_free():
    """% of this MACHINE's CPU capacity still free — 1-min loadavg against core count,
    same LEFT convention as every other gauge (green = idle box, red = saturated; can
    exceed-load → 0). os.getloadavg is a syscall on mac+linux: no subprocess, render-safe."""
    try:
        load1 = os.getloadavg()[0]
        cores = os.cpu_count() or 1
    except OSError:
        return None
    return max(0.0, min(100.0, 100.0 - load1 / cores * 100.0))


def _ctx_free(d: dict):
    """% of the context window still FREE — 100 (green) on a fresh session, falling
    as the conversation grows. Computed ourselves from token occupancy, NOT read from
    Claude Code's `remaining_percentage`: that field is measured against the reported
    `context_window_size` (200000) and so pins to 0% the instant an opus [1m] session
    crosses 200K — even with ~700K still free. We take occupancy = this turn's full
    input (fresh + cache-read + cache-write) and bump the window to 1M once it exceeds
    the nominal size (i.e. the 1M beta is really in play). Returns free% or None."""
    cw = d.get("context_window") or {}
    cu = cw.get("current_usage") or {}
    used = ((cu.get("input_tokens") or 0)
            + (cu.get("cache_read_input_tokens") or 0)
            + (cu.get("cache_creation_input_tokens") or 0)) or (cw.get("total_input_tokens") or 0)
    if not used:
        return None
    size = cw.get("context_window_size") or 200000
    if used > size:                       # crossed the nominal window → the 1M beta is active
        size = 1_000_000
    return max(0.0, min(100.0, (1 - used / size) * 100))


def _lsp_enabled() -> dict:
    try:
        with open(f"{HOME}/.claude/settings.json") as f:
            return json.load(f).get("enabledPlugins", {})
    except (OSError, json.JSONDecodeError):
        return {}


_LSP_CACHE = f"{HOME}/.claude/.cctl-lsp-langs"   # cwd\tepoch\tlangs — per-dir, TTL'd
_LSP_TTL = 300
_LSP_MARKERS = {
    "package.json": "TS/JS", "tsconfig.json": "TS/JS", "go.mod": "Go",
    "Cargo.toml": "Rust", "Package.swift": "Swift", "Gemfile": "Ruby",
    "composer.json": "PHP", "pyproject.toml": "Python", "setup.py": "Python",
    "requirements.txt": "Python", "Pipfile": "Python", "build.gradle": "Java",
    "pom.xml": "Java",
}
_LSP_EXTS = {
    ".py": "Python", ".swift": "Swift", ".ts": "TS/JS", ".tsx": "TS/JS",
    ".js": "TS/JS", ".jsx": "TS/JS", ".go": "Go", ".rs": "Rust", ".rb": "Ruby",
    ".php": "PHP", ".kt": "Kotlin", ".cs": "C#",
}
_LSP_PRUNE = {"node_modules", ".git", ".venv", "venv", "__pycache__", "dist",
              "build", ".next", "target", "vendor", ".cache", "Pods"}


def _detect_langs_raw(cwd: str) -> list:
    """Bounded language sniff: markers + extensions, depth<=2, file-capped, noise
    pruned. Deeper than a bare listdir (catches src/*.py, Sources/*.swift) but
    still cheap; results are cached per-cwd so most renders never call this."""
    langs: list = []
    def add(l):
        if l not in langs:
            langs.append(l)
    seen = 0
    for dirpath, dirnames, filenames in os.walk(cwd or "."):
        dirnames[:] = [x for x in dirnames
                       if x not in _LSP_PRUNE and not x.startswith(".")]
        if os.path.relpath(dirpath, cwd or ".").count(os.sep) >= 2:
            dirnames[:] = []
        for name in filenames:
            if name in _LSP_MARKERS:
                add(_LSP_MARKERS[name])
            else:
                _, e = os.path.splitext(name)
                if e in _LSP_EXTS:
                    add(_LSP_EXTS[e])
            seen += 1
            if seen > 1200:
                return langs
    return langs


def _detect_root(cwd: str) -> list:
    """Top-level-only signal (markers + immediate files). When a repo declares
    its language at the root, that IS the language — nested vendored code
    (a Go tool, a homebrew .rb) shouldn't trigger a warning."""
    langs: list = []
    try:
        for name in os.listdir(cwd or "."):
            l = _LSP_MARKERS.get(name) or _LSP_EXTS.get(os.path.splitext(name)[1])
            if l and l not in langs:
                langs.append(l)
    except OSError:
        pass
    return langs


def _detect_langs(cwd: str) -> list:
    """Cached per-cwd. Root-level signal wins; only walk deeper when the root is
    silent (e.g. Swift apps that keep sources in Sources/ or a subdir)."""
    cwd = cwd or os.getcwd()
    try:
        with open(_LSP_CACHE) as f:
            ckey, ts, val = f.read().split("\t", 2)
        if ckey == cwd and time.time() - float(ts) < _LSP_TTL:
            return [x for x in val.strip().split(",") if x]
    except (OSError, ValueError):
        pass
    langs = _detect_root(cwd) or _detect_langs_raw(cwd)
    try:
        with open(_LSP_CACHE, "w") as f:
            f.write(f"{cwd}\t{time.time()}\t{','.join(langs)}")
    except OSError:
        pass
    return langs


def _lsp_seg(cwd: str) -> str:
    if not cwd or os.path.realpath(cwd) == os.path.realpath(HOME):
        return ""   # home dir isn't a project — its stray files aren't signal
    enabled = _lsp_enabled()
    def off(l):
        p = _LANG_LSP.get(l)
        return bool(p) and enabled.get(f"{p}@{_LSP_MARKETPLACE}") is not True
    # Warnings fire ONLY for languages a repo declares at its ROOT — that's the
    # real language. Nested code (a vendored Go tool, a homebrew .rb) is found by
    # the deeper walk and can still earn a quiet ✓, but never a false ⚠.
    root = _detect_root(cwd)
    missing = [l for l in root if off(l)]
    if missing:
        return f"{_RED}⚠lsp✗{'/'.join(_LANG_SHORT[l] for l in missing)}{_RST}"
    langs = _detect_langs(cwd)
    covered = [l for l in langs if _LANG_LSP.get(l) and not off(l)]
    if covered:
        return f"{_DIM}lsp✓{_LANG_SHORT[covered[0]]}{_RST}"
    return ""


def _short_cwd(cwd: str) -> str:
    if not cwd:
        return ""
    if cwd.startswith(HOME):
        cwd = "~" + cwd[len(HOME):]
    segs = [s for s in cwd.split("/") if s != ""]
    if len(segs) > 2:
        return "…/" + "/".join(segs[-2:])
    return cwd


def _git(cwd: str):
    """(branch, dirty_count) for cwd, or ('', 0) if not a repo."""
    d = cwd or "."
    branch = subprocess.run(["git", "-C", d, "symbolic-ref", "--short", "HEAD"],
                            capture_output=True, text=True).stdout.strip()
    if not branch:
        return "", 0
    porc = subprocess.run(["git", "-C", d, "status", "--porcelain"],
                          capture_output=True, text=True).stdout
    dirty = sum(1 for ln in porc.splitlines() if ln.strip())
    return branch, dirty


def _model(name: str) -> str:
    # Claude 5 family (Fable/Mythos) + the 4.x line. Without Fable/Mythos here a pane running
    # Claude Fable 5 rendered the raw "Claude Fable 5" instead of a clean "fable" tag.
    for tag in ("Opus", "Sonnet", "Haiku", "Fable", "Mythos"):
        if tag in (name or ""):
            return tag.lower()
    return name or ""


def _read_token() -> str:
    """The OAuth access token `claude` actually auths with — keychain on macOS,
    ~/.claude/.credentials.json elsewhere. This is the REAL login, not a file
    cccc/Claude may have left stale."""
    try:
        raw = subprocess.run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials",
             "-a", os.environ.get("USER", ""), "-w"],
            capture_output=True, text=True, timeout=5).stdout
        return json.loads(raw)["claudeAiOauth"]["accessToken"]
    except Exception:  # noqa: BLE001  (not macOS / no keychain entry)
        pass
    try:
        with open(f"{HOME}/.claude/.credentials.json") as f:
            return json.load(f)["claudeAiOauth"]["accessToken"]
    except Exception:  # noqa: BLE001
        return ""


def _whoami_resolve() -> None:
    """Background pass (invoked as `--whoami`): ask Anthropic which account this
    box's token really is, map the org-id to a cccc name, cache it. Best-effort —
    any failure just leaves the previous cache (render falls back to the ★)."""
    import urllib.request
    tok = _read_token()
    if not tok:
        return
    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps({"model": "claude-haiku-4-5-20251001", "max_tokens": 1,
                             "messages": [{"role": "user", "content": "hi"}]}).encode(),
            headers={"authorization": f"Bearer {tok}", "anthropic-version": "2023-06-01",
                     "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
                     "content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=20) as r:
            org = r.headers.get("anthropic-organization-id", "")
    except Exception:  # noqa: BLE001
        return
    if not org:
        return
    name = ""
    try:
        # Map the verified org-id → account name via the router's account pool
        # (llm.hostbun.cc — the only gateway now; claude.hostbun.cc is retired).
        import http.cookiejar
        op = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        op.open(urllib.request.Request(f"{_LLM_ADMIN}/api/login",
                data=json.dumps({"password": _LLM_PW}).encode(),
                headers={"content-type": "application/json"}), timeout=15).read()
        st = json.load(op.open(f"{_LLM_ADMIN}/api/state", timeout=15))
        name = next((a.get("name", "") for a in (st.get("claudecodeAccountPool") or [])
                     if a.get("org") == org), "")
    except Exception:  # noqa: BLE001
        pass
    try:
        with open(_WHO_CACHE, "w") as f:
            f.write(f"{time.time()}\t{org}\t{name}")
    except OSError:
        pass
    # publish to the fleet registry so /fleet + the TUI can show who's on what
    try:
        payload = json.dumps({"machine": _machine(),
                              "account": name, "org_id": org}).encode()
        pr = urllib.request.Request(f"{_MCP_BASE}/presence", data=payload,
                                    headers={"authorization": f"Bearer {_MCP_BEARER}",
                                             "content-type": "application/json"}, method="POST")
        urllib.request.urlopen(pr, timeout=10)
    except Exception:  # noqa: BLE001
        pass


def _whoami_cached() -> str:
    """The API-verified account name from the cache, or '' if never resolved."""
    try:
        with open(_WHO_CACHE) as f:
            _, _, name = f.read().split("\t", 2)
        return name.strip()
    except (OSError, ValueError):
        return ""


def _whoami_cached_org() -> str:
    """The API-verified org id from the cache — a stable 4-char suffix that tells
    look-alike account names apart (e.g. claudemejlto vs claude2mejlto)."""
    try:
        with open(_WHO_CACHE) as f:
            _, org, _ = f.read().split("\t", 2)
        return org.strip()
    except (OSError, ValueError):
        return ""


def _whoami_spawn_if_stale() -> None:
    """Fire the background resolver when the cache is old OR a switch happened
    (★ file newer than the cache) — but never more than once/min, even if the
    resolver keeps failing offline. Fire-and-forget; never delays the line."""
    try:
        cts = os.stat(_WHO_CACHE).st_mtime
    except OSError:
        cts = 0
    try:
        star_m = os.stat(_ACCT_STAR).st_mtime
    except OSError:
        star_m = 0
    if time.time() - cts < _WHO_TTL and star_m <= cts:
        return                                   # fresh and no switch since → skip
    try:
        if time.time() - os.stat(_WHO_STAMP).st_mtime < _WHO_MINGAP:
            return
    except OSError:
        pass
    try:
        with open(_WHO_STAMP, "w") as f:         # stamp BEFORE spawn → throttle failures too
            f.write(str(time.time()))
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "--whoami"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    except Exception:  # noqa: BLE001
        pass


def _route_tag(where: str) -> str:
    """Dim suffix naming WHERE this pane's traffic actually goes. This used to be
    invisible: `direct` = no ANTHROPIC_BASE_URL, straight to api.anthropic.com on the
    keychain token cccc pinned. Anything else is a gateway base URL, named outright."""
    return f"{_DIM}·{where}{_RST}"


def _route_state() -> str:
    """The resolver's last verdict for a gateway-configured box, or "" when this box
    isn't a gateway box at all. `~/.claude-accounts/.cccc-key` present = configured for
    the gateway; `~/.claude/.cctl-route` "ts<TAB>state" = what shell/gateway-route.sh
    last decided — `up` (routing), `down` (failed open, router unreachable), or `direct`
    (DELIBERATE force-direct, user chose to bypass; ~/.claude-accounts/.cccc-force-direct).
    Any missing/garbled file → "" (never cry wolf)."""
    if not os.path.exists(os.path.join(HOME, ".claude-accounts", ".cccc-key")):
        return ""
    try:
        with open(os.path.join(HOME, ".claude", ".cctl-route")) as f:
            return (f.read().split("\t", 1) + [""])[1].strip()
    except (OSError, IndexError):
        return ""


def _direct_route_tag() -> str:
    """`·direct` for a plain login box. A gateway box that's currently direct gets a
    distinct tag so the reason is never ambiguous:
      router-down fallback (state `down`) → LOUD red `⚠router-down·direct`
      deliberate force-direct (state `direct`) → yellow `·direct⏵bypass` (chose to skip
        the router for speed; per-consumer tracking is off for this window)."""
    st = _route_state()
    if st == "down":
        return f"{_RED}⚠router-down·direct{_RST}"
    if st == "direct":
        return f"{_YEL}·direct⏵bypass{_RST}"
    return _route_tag("direct")


def _account():
    """(icon, name, note) for the account serving THIS pane — RAW name so the caller
    can colour it by how hot the account is. `note` is a pre-styled dim suffix: a ✓ once
    Anthropic-verified, `→otherpin` when cccc's keychain pin (which governs the NEXT pane
    you launch) differs from who's billing now, plus a `·<route>` tag.

    The ICON encodes the ROUTE and is never reused across routes — so you can always tell
    at a glance whether the account is YOUR keychain pin or one a gateway picked for you:
      👤 direct   — no base URL; keychain token (cccc's pin) → api.anthropic.com
      📡 gateway  — llm.hostbun.cc pool (account chosen SERVER-side via /api/pins)
      🌐 other gateway     🔑 api key (billed)
    """
    base = os.environ.get("ANTHROPIC_BASE_URL", "")
    if base:
        if "llm.hostbun.cc" in base:
            # The GATEWAY decides the account server-side: it resolves THIS box's consumer id
            # against its consumerAccounts LOCK map and bills that account — the pane's own
            # headers don't decide it. So we DON'T guess from the frozen env; the background
            # pass asks the gateway what this consumer resolves to and caches it. That's the
            # account that actually gets billed. source="auto" = this box is UNMAPPED and
            # riding the shared sticky (rotates) — flagged loudly so it's obvious it's unlocked.
            name, _u5, _u7, _st, _fr, org, source, _ages = _pool_read()
            if not name:
                return ("📡", "auto?", _route_tag("llm.hostbun.cc"))
            note = f"{_DIM}·{org[:4]}{_RST}" if org else ""
            if source == "auto":
                note += f"{_YEL}⚠auto{_RST}"          # not locked → rotating; needs a consumer lock
            return ("📡", name, note + _route_tag("llm.hostbun.cc"))
        return ("🌐", base.split("://", 1)[-1], _route_tag("gateway"))
    if os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY"):
        return ("🔑", os.environ.get("CC_LABEL", "key"), f"{_YEL}·BILLED{_RST}")
    # Interactive OAuth login, no base URL → DIRECT to api.anthropic.com on the keychain
    # token. ★ (~/.claude-accounts/.cccc-local) = what cccc pinned on this box; verified =
    # what Anthropic confirmed the real token is. Show verified when known.
    _whoami_spawn_if_stale()
    verified = _whoami_cached()
    try:
        star = open(_ACCT_STAR).read().strip()
    except OSError:
        star = ""
    email = ""
    try:
        with open(f"{HOME}/.claude.json") as f:
            email = (json.load(f).get("oauthAccount", {}) or {}).get("emailAddress", "")
    except (OSError, json.JSONDecodeError):
        pass
    if verified:
        note = f"{_GRN}✓{_RST}"
        if star and star != verified:                   # keychain token ≠ cccc's ★ → drift
            note += f"{_YEL}→{star}{_RST}"
        return ("👤", verified, note + _direct_route_tag())
    return ("👤", star or email or "login", _direct_route_tag())


def _limit_seg(label: str, node: dict) -> str:
    if not isinstance(node, dict):
        return ""
    pct = node.get("used_percentage")
    if pct is None:
        return ""
    return _gauge_seg(label, 100 - pct, node.get("resets_at"))


def _version() -> str:
    """Short sha of the claudectl checkout THIS script lives in.

    Put side by side (pmac vs pbox), two panes showing different shas means one
    box is running a stale statusline/TUI — pull + re-run install.sh to sync.
    A trailing '*' means this box has uncommitted edits to the shared tooling.
    Cached (60 s) so we don't spawn git every render; the sha only moves on pull.
    """
    try:
        with open(_VER_CACHE) as f:
            ts, val = f.read().split("\t", 1)
            if time.time() - float(ts) < _VER_TTL:
                return val
    except (OSError, ValueError):
        pass
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sha = subprocess.run(["git", "-C", repo, "rev-parse", "--short", "HEAD"],
                         capture_output=True, text=True).stdout.strip()
    val = ""
    if sha:
        dirty = subprocess.run(["git", "-C", repo, "status", "--porcelain", "-uno"],
                               capture_output=True, text=True).stdout.strip()
        val = f"cctl:{sha}{'*' if dirty else ''}"
    try:
        with open(_VER_CACHE, "w") as f:
            f.write(f"{time.time()}\t{val}")
    except OSError:
        pass
    return val


def _auto_sync():
    """Background self-sync — DISABLED by default. It used to fast-forward a clean
    clone from every render (throttled 30 min), but silent auto-pull surprised the
    fleet (stale/unexpected code appearing), so it's now opt-in: set
    CLAUDECTL_AUTOSYNC=1 to re-enable. Off, boxes only update when someone runs
    `git pull`/`sh install.sh` by hand — no cron, no background pull."""
    if os.environ.get("CLAUDECTL_AUTOSYNC", "0") != "1":
        return
    try:
        with open(_SYNC_STAMP) as f:
            if time.time() - float(f.read().strip()) < _SYNC_EVERY:
                return
    except (OSError, ValueError):
        pass
    try:                                   # stamp BEFORE spawning → no thundering herd
        with open(_SYNC_STAMP, "w") as f:
            f.write(str(time.time()))
    except OSError:
        return
    sync = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "tui", "cccc_sync.py")
    if not os.path.exists(sync):
        return
    try:
        subprocess.Popen(["python3", sync, "--quiet"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    except Exception:  # noqa: BLE001
        pass


def _side_effects(raw: str):
    """Preserve an existing Headroom / ClaudeWatch app, but never fail the line."""
    try:
        hu = f"{HOME}/.claude/headroom-usage.json"
        if os.path.isdir(os.path.dirname(hu)):
            with open(hu, "w") as f:
                f.write(raw)
    except OSError:
        pass
    feed = f"{HOME}/.claude/claudewatch-feed.sh"
    if os.path.exists(feed):
        try:
            subprocess.Popen(["bash", feed], stdin=subprocess.PIPE,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                             ).stdin.write(raw.encode())
        except Exception:  # noqa: BLE001
            pass


def _consumer_id() -> str:
    """This box's consumer id AS THE GATEWAY SEES IT: the X-Consumer header it sends,
    falling back to X-Project, then the machine name. Lowercased for the map lookup.
    This is the key the gateway's consumerAccounts lock map is keyed on."""
    ch = os.environ.get("ANTHROPIC_CUSTOM_HEADERS", "").replace("\\n", "\n")
    hdr = {}
    for ln in ch.splitlines():
        if ":" in ln:
            k, v = ln.split(":", 1)
            hdr[k.strip().lower()] = v.strip()
    return (hdr.get("x-consumer") or hdr.get("x-project") or _machine()).lower()


def _anthropic_refresh() -> None:
    """Background pass: ask the gateway what account THIS box is actually billed on. The
    truth is the server-side consumerAccounts LOCK map (gateway resolves consumer→account
    and that always wins), so we resolve THIS consumer against it. Only if this consumer is
    UNMAPPED do we fall back to the global sticky (source='auto', flagged in the render).
    Also grabs that account's harvested 5h/7d. Admin-gated, fail-silent — never blocks."""
    try:
        import urllib.error
        import urllib.request
        import http.cookiejar
        # Reuse the fleet-shared admin cookie (same file as the cccc TUI) and log in ONLY
        # on 401/403. A fresh login per refresh trips the router's per-IP login throttle
        # (>10/5min, fleet shares one egress) → every refresh 429s → the cache silently
        # goes stale and the statusline shows hours-old numbers as if current.
        cookie_file = f"{HOME}/.claude/.cctl-admin-cookie"
        cj = http.cookiejar.MozillaCookieJar(cookie_file)
        try:
            cj.load(ignore_discard=True, ignore_expires=True)
        except (OSError, http.cookiejar.LoadError):
            pass
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

        def _login():
            op.open(urllib.request.Request(f"{_LLM_ADMIN}/api/login",
                    data=json.dumps({"password": _LLM_PW}).encode(),
                    headers={"content-type": "application/json"}), timeout=8).read()
            try:
                os.makedirs(os.path.dirname(cookie_file), exist_ok=True)
                cj.save(ignore_discard=True, ignore_expires=True)
                os.chmod(cookie_file, 0o600)
            except OSError:
                pass

        try:
            st = json.load(op.open(f"{_LLM_ADMIN}/api/state", timeout=8))
        except urllib.error.HTTPError as e:
            if e.code not in (401, 403):
                raise
            _login()
            st = json.load(op.open(f"{_LLM_ADMIN}/api/state", timeout=8))
        pool = st.get("claudecodeAccountPool") or []
        # projectAccounts is the current name; consumerAccounts the pre-rename alias.
        pinmap = st.get("projectAccounts") or st.get("consumerAccounts") or {}
        cmap = {str(k).lower(): v for k, v in pinmap.items()}
        mapped = cmap.get(_consumer_id(), "")
        if mapped:                                        # LOCKED — this is what gets billed
            name, source = mapped, "lock"
            org = next((a.get("org", "") for a in pool
                        if str(a.get("name", "")).lower() == mapped.lower()), "")
        else:                                             # unmapped → router's default account
            name = st.get("defaultAccount") or ""
            org = next((a.get("org", "") for a in pool
                        if str(a.get("name", "")).lower() == str(name).lower()), "")
            source = "auto"
        u5 = u7 = status = hts = ""
        if name and org:
            try:
                for r in json.load(op.open(f"{_LLM_ADMIN}/api/limits", timeout=8)).get("rows", []):
                    if r.get("org_id") == org:
                        u5 = "" if r.get("u5") is None else str(round(r["u5"] * 100))
                        u7 = "" if r.get("u7") is None else str(round(r["u7"] * 100))
                        status = r.get("status") or ""
                        hts = str(r.get("ts") or "")   # when Anthropic last SAID this — ages the reading
                        break
            except Exception:  # noqa: BLE001
                pass
        with open(_POOL_CACHE, "w") as f:
            f.write(f"{int(time.time())}\t{name}\t{u5}\t{u7}\t{status}\t{org}\t{source}\t{hts}")
    except Exception:  # noqa: BLE001
        pass


def _pool_read():
    """(name, u5, u7, status, fresh, org, source) from the gateway-resolved account cache;
    kick a throttled background refresh when stale. source: 'lock' = this consumer is pinned
    server-side (billed = shown), 'auto' = unmapped, riding the shared sticky. Fields are ''
    when unknown. Shared by _account() and _anthropic_seg()."""
    name = u5 = u7 = status = org = source = ""
    fresh = False
    cache_ts = rd_ts = 0.0
    try:
        with open(_POOL_CACHE) as f:
            p = f.read().split("\t")
        cache_ts = float(p[0])
        fresh = (time.time() - cache_ts) < _POOL_TTL
        name = p[1] if len(p) > 1 else ""
        u5 = p[2] if len(p) > 2 else ""
        u7 = p[3] if len(p) > 3 else ""
        status = p[4].strip() if len(p) > 4 else ""
        org = p[5].strip() if len(p) > 5 else ""
        source = p[6].strip() if len(p) > 6 else ""
        try:
            rd_ts = float(p[7]) / 1000.0 if len(p) > 7 and p[7].strip() else 0.0
        except ValueError:
            rd_ts = 0.0
    except Exception:  # noqa: BLE001
        pass
    if not fresh:                       # kick a non-blocking refresh for next time
        try:
            subprocess.Popen([sys.executable, os.path.abspath(__file__), "--anthropic-refresh"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:  # noqa: BLE001
            pass
    return name, u5, u7, status, fresh, org, source, (cache_ts, rd_ts)


def _anthropic_seg() -> str:
    """`5h▆88% 7d▂27%` — how much of the serving account's 5h / 7d budget is LEFT.
    SAME battery convention as every other gauge on the line: a tall GREEN bar with a
    high % = plenty left (good); a low RED bar = nearly out (bad). (The proxy harvests
    USED% off the rate-limit headers; we flip it to LEFT so high is always good.)"""
    if "llm.hostbun.cc" not in os.environ.get("ANTHROPIC_BASE_URL", ""):
        return ""
    name, u5, u7, _st, _fr, _org, _src, _ages = _pool_read()
    if not name:
        return ""
    # 100 - used = LEFT; render with the shared green→red gauge (high = good).
    segs = [_gauge_seg(lab, max(0, 100 - int(u)))
            for lab, u in (("5h", u5), ("7d", u7)) if u != ""]
    return " ".join(segs)


def _mcp_resolve() -> None:
    """Background pass (`--mcp-refresh`): run `claude mcp list`, parse the servers
    that `✘ Failed to connect`, cache their short names. Best-effort — any failure
    leaves the previous cache untouched."""
    try:
        out = subprocess.run(["claude", "mcp", "list"], capture_output=True,
                             text=True, timeout=45).stdout
    except Exception:  # noqa: BLE001  (claude not on PATH / hang)
        return
    failed = []
    for ln in out.splitlines():
        if "Failed to connect" not in ln:
            continue
        # `<id>: <cmd> - ✘ Failed to connect` → id → last colon-segment is the short name
        ident = ln.split(" - ", 1)[0].rsplit(": ", 1)[0].strip()
        short = ident.split(":")[-1].strip()
        if short and short not in failed:
            failed.append(short)
    try:
        with open(_MCP_CACHE, "w") as f:
            f.write(f"{time.time()}\t{','.join(failed)}")
    except OSError:
        pass


def _mcp_spawn_if_stale() -> None:
    """Kick the health-check when the cache is older than the TTL — throttled to at
    most once / 90s even when it keeps failing. Fire-and-forget; never delays render."""
    try:
        if time.time() - os.stat(_MCP_CACHE).st_mtime < _MCP_TTL:
            return
    except OSError:
        pass
    try:
        if time.time() - os.stat(_MCP_STAMP).st_mtime < _MCP_MINGAP:
            return
    except OSError:
        pass
    try:
        with open(_MCP_STAMP, "w") as f:         # stamp BEFORE spawn → throttle failures too
            f.write(str(time.time()))
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "--mcp-refresh"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    except Exception:  # noqa: BLE001
        pass


def _mcp_seg() -> str:
    """`⚠2 mcp✗ cloak-cdp/telegram-bot` — COUNT first (never truncated away) then the
    failing MCP servers, or '' when all healthy. Names shown in full up to 3, else the
    first two + `+N`. Always loud red so a dead MCP can't sit unnoticed. Reads the cache;
    a stale cache also kicks a throttled background re-check."""
    _mcp_spawn_if_stale()
    try:
        with open(_MCP_CACHE) as f:
            _, names = f.read().split("\t", 1)
    except (OSError, ValueError):
        return ""                                # never checked yet → nothing to claim
    failed = [n for n in names.strip().split(",") if n]
    if not failed:
        return ""
    n = len(failed)
    shown = "/".join(failed) if n <= 3 else f"{'/'.join(failed[:2])}+{n - 2}"
    return f"{_RED}⚠{n} mcp✗ {shown}{_RST}"


def main() -> int:
    if "--whoami" in sys.argv:      # background self-invocation: resolve + cache, no stdin
        _whoami_resolve()
        return 0
    if "--anthropic-refresh" in sys.argv:   # background: cache the proxy's sticky account + headroom
        _anthropic_refresh()
        return 0
    if "--mcp-refresh" in sys.argv:         # background: health-check MCPs, cache the failed ones
        _mcp_resolve()
        return 0
    raw = sys.stdin.read()
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        d = {}

    cwd = d.get("cwd") or os.getcwd()
    branch, dirty = _git(cwd)
    rl = d.get("rate_limits") or {}
    ctx_free = _ctx_free(d)             # % context still free (window-aware; see _ctx_free)

    # Two lines — taller but each scannable:
    #   line 1  CONTEXT   where you are + what you're running
    #   line 2  ACCOUNT   who + real 5h/7d limits (the cccc stuff)
    line1 = []
    sc = _short_cwd(cwd)
    if sc:
        line1.append(f"{_DIM}📁{_RST}{sc}")
    if branch:
        line1.append(f"{_DIM}⑂{_RST}{branch}" + (f"{_YEL}±{dirty}{_RST}" if dirty else ""))
    m = _model((d.get("model") or {}).get("display_name", ""))
    if m:
        # model + reasoning effort + thinking, as one cluster (e.g. "opus·hi 🧠").
        # These come from Claude Code's OWN state — a transparent gateway can't change them.
        eff = ((d.get("effort") or {}).get("level") or "")
        eff_short = {"low": "lo", "medium": "med", "high": "hi"}.get(eff, eff)
        seg = m + (f"{_DIM}·{eff_short}{_RST}" if eff_short else "")
        if (d.get("thinking") or {}).get("enabled"):
            seg += f" {_YEL}🧠{_RST}"
        line1.append(seg)
    if ctx_free is not None:
        line1.append(_gauge_seg("ctxfree", ctx_free))   # % context FREE: 100 green → 0 red
    box = _box_free()
    if box is not None:
        line1.append(_gauge_seg("box", box))            # % machine capacity FREE (loadavg vs cores)
    lsp = _lsp_seg(cwd)
    if lsp:
        line1.append(lsp)
    mcp = _mcp_seg()                    # loud ⚠ whenever an MCP server is failing to connect
    if mcp:
        line1.append(mcp)

    # Account cluster: WHO + HOW-HOT as one unit. The account NAME is coloured by its
    # hottest window (green healthy → red nearly dead), so the name itself is the alarm,
    # then its 5h/7d gauges sit right beside it — e.g. `👤claudemejlto 5h▄49%↻2h 7d▁3%↻4d`.
    icon, aname, anote = _account()
    limit_segs = [s for s in (_limit_seg("5h", rl.get("five_hour")),
                              _limit_seg("7d", rl.get("seven_day"))) if s]
    frees = [100 - p for p in ((rl.get("five_hour") or {}).get("used_percentage"),
                               (rl.get("seven_day") or {}).get("used_percentage")) if p is not None]
    tail = ""
    if not limit_segs:                               # Claude didn't surface limits →
        pn, pu5, pu7, _st, _fr, _org, _src, pages = _pool_read()  # colour + headroom from the proxy harvest
        frees += [100 - int(u) for u in (pu5, pu7) if u != ""]
        tail = _anthropic_seg()
        now = time.time()
        cache_ts, rd_ts = pages
        if cache_ts and now - cache_ts > 600:
            # the background refresh has been FAILING for 10+ min — the numbers on
            # screen are frozen. Say so, and drop the health colour: a confident
            # green over dead data is worse than no colour.
            frees = []
            tail += f" {_RED}⌛stale{_RST}"
        elif rd_ts and now - rd_ts > 7200:
            # refresh works, but Anthropic hasn't SAID anything about this account in
            # 2h+ (idle account — the harvest only learns from served traffic). The
            # reading is real but old; age it instead of pretending it's current.
            tail += f" {_DIM}⌛{_rel(now + (now - rd_ts)) or '?'} old{_RST}"
    acol = _health(min(frees)) if frees else ""      # name colour = worst window; plain if unknown
    acct = f"{icon}{acol}{_BLD}{aname}{_RST}{anote}"
    line2 = [" ".join([acct] + limit_segs)]
    if tail:
        line2[0] += f" {tail}"
    v = _version()
    if v:
        line2.append(f"{_DIM}{v}{_RST}")             # tail anchor — spot cross-machine drift

    sys.stdout.write(" · ".join(line1) + "\n" + " · ".join(line2))
    _side_effects(raw)
    _auto_sync()                          # background, throttled, non-blocking
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
