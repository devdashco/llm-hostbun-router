#!/usr/bin/env python3
"""claudectl statusline — one self-contained renderer for every Claude Code pane.

Folds the old 5-script chain (statusline-ratelimits + headroom + statusline-command
+ cc-profile) into a single file with ZERO external deps beyond python3 — no jq, no
Headroom required. install.sh vendors this and points settings.json at it, so every
machine/session shows the byte-identical line:

    📁…/repo · ⑂branch±3 · opus · ctxfree▇67% · 🔌17✓
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

The 🔌 badge is MCP health, and it is deliberately hard to miss. A dead MCP server
is otherwise INVISIBLE: `claude` prints "failed to connect" once at startup, it
scrolls away, and after that the tool is simply absent — you discover it when a
tool call fails. So:

    🔌17✓                        dim: all 17 servers of this session answered
    🔌⚠1/17 🔑gitlab             BOLD RED, and it MOVES to the front of the line
    🔌16✓ ⟳autonoma              yellow: enabled but installed after this session
                                 started — not broken, just needs a restart

    🔑 the server answered and said no (401/token revoked) — fix the credential
    💀 it never answered (refused / DNS / TLS / timeout) — the box or route is down
    ✖ failed some other way   ? enabled + configured, yet never showed up at all

Truth comes from Claude Code's own per-server logs filtered to THIS session id, so
the badge says exactly what `/mcp` says — nothing is probed or inferred. A healthy
http server is noisy (its SSE stream idles out and re-dials every few minutes), and
none of that churn counts as broken; only a decisive failure does. `cccc-statusline.py
--mcp` prints the per-server table behind the badge.

The 🧩 badge is the same idea one level up — a PLUGIN that never loaded at all, which
is quieter still: it has no MCP log for 🔌 to find, and its skills/agents/servers are
simply absent while `/plugin` buries the reason in an "Errors" tab nobody opens.

    🧩✗3 keyvault cloudflare+1   bold red, also at the front of the line

Its oracle is `claude --debug plugin list` — Claude Code's OWN loader, because the
predicate is not reproducible from the settings files (a plugin can still resolve via
a marketplace fallback, and inferring that would mean publishing a guess as a fact).
That costs a subprocess, so it runs `nice`d in the background at most every 30 min per
project and the render only ever reads its cache. Silent while everything loads.

Reads Claude Code's status JSON on stdin. Any segment whose data is absent this turn
is simply omitted — nothing is fabricated (e.g. rate-limit segments only appear once
the session has had one API response).

Optional side-effects, only if the files exist (so an existing Headroom / ClaudeWatch
menu-bar app keeps working): mirrors stdin to ~/.claude/headroom-usage.json and feeds
~/.claude/claudewatch-feed.sh.
"""
import calendar
import json
import os
import re
import shutil
import subprocess
import sys
import time

HOME = os.path.expanduser("~")


def _cc_config_dir() -> str:
    """Claude Code's config dir — honors CLAUDE_CONFIG_DIR (which relocates
    `.credentials.json`, documented for Linux/Windows), else ~/.claude. Reading the
    default path after `claude`'s config was relocated is how the line shows a STALE
    account/limit; this keeps the statusline pointed at the live config."""
    d = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return os.path.expanduser(d) if d else f"{HOME}/.claude"


def _cc_file(name: str, legacy: str) -> str:
    """Resolve a Claude config file: prefer <config-dir>/<name>, fall back to the legacy
    ~/ path when that file isn't in the config dir. Only `.credentials.json` is
    documented to relocate, so for `settings.json` / `.claude.json` we read whichever
    actually exists rather than guess — never a stale copy when a fresh one is present."""
    p = os.path.join(_cc_config_dir(), name)
    return p if os.path.exists(p) else os.path.expanduser(legacy)


_VER_CACHE = f"{HOME}/.claude/.cctl-version"   # epoch\tvalue — refreshed lazily
_VER_TTL = 60                                  # sha only moves on a git pull
_HOST_CACHE = f"{HOME}/.claude/.cctl-githost"  # cwd\tepoch\thost — per-dir, TTL'd
_HOST_TTL = 300                                # origin remote almost never changes
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

# linked-issue open/closed: the branch name only NAMES an issue (regex guess, no
# network) — whether that issue is actually still open needs one `gh issue view`
# call, which is too slow for the render path. Same cache+throttled-background-spawn
# shape as whoami/pool above: render reads a cache, kicks a bounded background `gh`
# call when stale, never blocks on the network itself.
_ISSUE_CACHE = f"{HOME}/.claude/.cctl-issuestate"        # cwd\tnum\tepoch\tstate
_ISSUE_TTL = 120
_ISSUE_STAMP = f"{HOME}/.claude/.cctl-issuestate-stamp"  # last spawn (throttle)
_ISSUE_MINGAP = 30


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
_CYN = "\033[36m"
_BLD = "\033[1m"
_PROG_DIR = f"{HOME}/.config/claudectl/progress"   # cccc fixer's live per-issue JSONL
_GAUGE = "▁▂▃▄▅▆▇█"
_ORANGE = "\033[38;5;208m"   # feature-branch flag — distinct from the yellow ±dirty count
_CYN = "\033[36m"            # linked GitHub issue number
_MAG = "\033[38;5;170m"      # GitLab host badge — the fleet migrated GH→GitLab, make it visible
_MAIN_BRANCHES = {"main", "master", "trunk", "develop", "dev", "staging", "production"}
_ISSUE_RE = re.compile(r"(?:^|[-/_])#?(\d{2,6})(?:[-_]|$)")


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


_CMUX_SNAP = f"{HOME}/.cache/cmux-tool/snapshot.json"
_CMUX_SNAP_STALE = 900          # `cmx save` runs every 5 min; 15 min is three misses


def _age(secs: float) -> str:
    """A duration, shortest useful unit: 40s / 12m / 3h / 2d."""
    if secs < 60:
        return f"{int(secs)}s"
    if secs < 3600:
        return f"{int(secs / 60)}m"
    if secs < 86400:
        return f"{secs / 3600:.0f}h"
    return f"{secs / 86400:.0f}d"


def _link_uptime():
    """How long the cmux link to this box has been up, in seconds — the age of the
    OLDEST live `cmuxd-remote`, which is the daemon the Mac's app pushes here and
    keeps per remote workspace. It is the one clock that answers 'did the terminal
    come back by itself', because it restarts when the connection does.

    /proc only: `comm` (12 chars, fits) then `stat` on the handful that match, so a
    render costs ~18ms of small reads and no subprocess. Absent on the Mac (nothing
    here runs cmuxd-remote) → None, so the segment simply is not drawn there."""
    try:
        btime = next(int(l.split()[1]) for l in open("/proc/stat") if l.startswith("btime"))
        hz = os.sysconf("SC_CLK_TCK")
        pids = os.listdir("/proc")
    except (OSError, StopIteration, ValueError):
        return None
    oldest = None
    for pid in pids:
        if not pid.isdigit():
            continue
        try:
            if open(f"/proc/{pid}/comm").read().strip() != "cmuxd-remote":
                continue
            st = open(f"/proc/{pid}/stat").read()
            # field 22 is starttime, counted AFTER the comm field — which is
            # parenthesised and may itself contain spaces, so the split has to start
            # at the LAST ')' or a process called "cmuxd remote" shifts every index.
            start = btime + int(st[st.rindex(")") + 2:].split()[19]) / hz
        except (OSError, ValueError, IndexError):
            continue                      # the process died mid-walk
        age = time.time() - start
        if oldest is None or age > oldest:
            oldest = age
    return oldest


def _cmux_seg():
    """THE TERMINALS ON THIS BOX: how many of the Mac's workspaces are connected to
    it right now, and how long that connection has lived.

    Every pane the human watches is a shell HERE reached over a relay from the Mac,
    and until this segment there was no standing answer to 'are they all still
    attached, and did they survive the last restart' — you had to go and ask
    (`cmx status`). It is read from the snapshot `cmx save` already writes every 5
    min, so a render does no network and cannot hang on a sleeping Mac.

    Honesty, the house rule: a snapshot that is MISSING or STALE renders `?`, never
    a count — an unread terminal and an empty one look identical, and '0 connected'
    is the one thing this must never invent. Same reason the workspace count is
    `connected/total` the moment they disagree: a bare `21` when two are down reads
    as an all-clear on exactly the screen that should be shouting."""
    try:
        with open(_CMUX_SNAP) as f:
            snap = json.load(f)
        sec = (snap.get("sections") or {}).get("workspaces") or {}
        rows = sec.get("data") or []
        at = float(sec.get("at") or 0)
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return ""
    up = _link_uptime()
    if up is None:                        # not the box the shells run on
        return ""
    life = f"{_DIM}·{_RST}{_age(up)}"
    if not rows or time.time() - at > _CMUX_SNAP_STALE:
        # the link is a LIVE read and stands on its own; only the count is stale
        return f"{_DIM}⧉{_RST}{_YEL}?{_RST}{life}"
    remote = [r for r in rows if r.get("dest")]
    ok = [r for r in remote if (r.get("state"), r.get("daemon")) == ("connected", "ready")]
    if not remote:
        return ""
    if len(ok) == len(remote):
        return f"{_DIM}⧉{_RST}{_GRN}{len(ok)}{_RST}{life}"
    return f"{_RED}⧉{len(ok)}/{len(remote)}{_RST}{life}"


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
        with open(_cc_file("settings.json", f"{HOME}/.claude/settings.json")) as f:
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


# --- MCP health segment ----------------------------------------------------
# A dead MCP server used to be INVISIBLE: `claude` prints "failed to connect" once
# at startup, scrolls away, and from then on the tool simply isn't there — you find
# out by watching a tool call fail. This segment keeps that on screen.
#
# Ground truth is Claude Code's OWN per-server debug log (~/.cache/claude-cli-nodejs/
# <cwd>/mcp-logs-<server>/<session>.jsonl) filtered to THIS session id, so it says
# exactly what `/mcp` says — no probing, no second opinion, nothing fabricated.
#
# The hard part is that a HEALTHY http server is noisy: its SSE stream idles out
# every ~5 min and reconnects ("HTTP connection dropped", "Terminal connection error
# 2/3", "Failed to reconnect SSE stream", "SSE GET-stream reconnection exhausted;
# leaving transport up"). None of those mean broken — Claude re-dials lazily and the
# POST channel keeps working. So only *decisive* lines move the verdict, last one
# wins, and everything else (SIGINT, "exited cleanly", a dropped stream, a retry
# counter) is NEUTRAL. That's why mailmcp — which churns its stream all day — reads
# green here instead of crying wolf every 5 minutes.
_MCP_LOGS = f"{HOME}/.cache/claude-cli-nodejs"
_MCP_PROBE = 40          # distinct session log-files to probe when locating ours
_MCP_OK = ("Successfully connected", "Connection established with capabilities",
           "reconnection successful", "completed successfully",
           "Channel notifications skipped", "leaving transport up")
_MCP_BAD = ("Connection failed", "Server rejected the configured Authorization",
            "reached, giving up", "not cached")
_MCP_AUTH = ("401", "403", "invalid_token", "revoked", "unauthorized", "not authorized",
             "authorization header", "invalid api key", "authentication", "forbidden")
_MCP_DOWN = ("econnrefused", "timed out", "timeout", "getaddrinfo", "enotfound",
             "no available server", "connection closed", "socket hang up",
             "502", "503", "504", "econnreset", "unable to connect", "certificate")
# 🔑 = the server answered and said no (token revoked/401) — fix the credential.
# 💀 = it never answered (refused/DNS/TLS/timeout) — the box or route is down.
# ✖ = it failed for some other reason.  ⟳ = installed after this session started,
# so it simply isn't loaded yet (restart).  ? = configured, enabled, and yet never
# showed up this session — the silent one worth looking at.
_MCP_GLYPH = {"auth": "🔑", "down": "💀", "err": "✖", "new": "⟳", "?": "?"}


# --- broken-plugin segment -------------------------------------------------
# The sibling failure to a dead MCP server, and even quieter: a plugin that never
# LOADS. `claude` collects those into /plugin's "Errors" tab and otherwise says
# nothing, so the skills, agents and MCP servers it would have provided are simply
# absent — with no log dir, so the 🔌 badge above cannot see them either.
#
# 2026-07-25, the case this was written for: nine plugins (keyvault, cloudflare,
# hyperdx, fix-codebase, the three LSPs, …) were recorded in installed_plugins.json
# as installed INTO /Documents/GitHub/bofrid (scope project/local) while
# ~/.claude/settings.json enabled them globally — so every session outside bofrid
# reported "not cached" and silently ran without them. Fix was reinstalling each at
# --scope user; this badge is so the next one is noticed the same day.
#
# The oracle is `claude --debug plugin list`, i.e. Claude Code's OWN loader — the
# predicate it uses is not reproducible from the settings files alone (a plugin can
# still resolve through a marketplace fallback, and inferring that would mean
# publishing a guess as a fact). It costs a subprocess, so it follows the same
# cache + throttled-background-spawn shape as whoami/pool/issue-state: the render
# only ever reads a file.
_PLG_CACHE = f"{HOME}/.claude/.cctl-plugins"        # cwd\tepoch\tname:reason,…
_PLG_STAMP = f"{HOME}/.claude/.cctl-plugins-stamp"  # last spawn (throttle, even on fail)
_PLG_TTL = 1800        # re-probe a project at most every 30 min
_PLG_MINGAP = 120      # box-wide: never more than one probe every 2 min
_PLG_MAXAGE = 10800    # a verdict older than 3h is dropped, not asserted
_PLG_RE = re.compile(r'Plugin "([^"]+)" (not cached|is enabled)')


def _plugin_resolve(cwd: str) -> None:
    """Background: ask `claude` itself which plugins failed to load here, cache it."""
    claude = shutil.which("claude")
    if not claude or not cwd:
        return
    dbg = f"{HOME}/.claude/debug"
    try:
        before = set(os.listdir(dbg))
    except OSError:
        return
    try:
        subprocess.run([claude, "--debug", "plugin", "list"], cwd=cwd, timeout=180,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return
    bad = {}
    for name in sorted(set(os.listdir(dbg)) - before):
        p = os.path.join(dbg, name)
        try:
            with open(p, errors="replace") as f:
                for plug, why in _PLG_RE.findall(f.read()):
                    bad[plug.split("@")[0]] = "cache" if why == "not cached" else "missing"
        except OSError:
            continue
        try:                       # the probe's own debug file is litter — drop it
            os.remove(p)
        except OSError:
            pass
    try:
        with open(_PLG_CACHE, "w") as f:
            f.write(f"{cwd}\t{time.time()}\t" +
                    ",".join(f"{k}:{v}" for k, v in sorted(bad.items())))
    except OSError:
        pass


def _plugin_cached(cwd: str):
    """[(plugin, reason)] for cwd, or None when we have no fresh verdict for it."""
    try:
        with open(_PLG_CACHE) as f:
            ckey, ts, val = f.read().split("\t", 2)
    except (OSError, ValueError):
        return None
    if ckey != cwd or time.time() - float(ts) > _PLG_MAXAGE:
        return None
    return [tuple(x.split(":", 1)) for x in val.strip().split(",") if ":" in x]


def _plugin_spawn_if_stale(cwd: str) -> None:
    """Kick the probe when this project's verdict is stale — throttled and detached.
    It spawns a real `claude` (~25 s), not a file read, so it runs at the lowest
    priority the box will give it: these machines sit near full load and the badge is
    worth far less than a responsive foreground. A load-based skip was tried first and
    was WRONG — pbox is pegged almost always, so it never probed at all."""
    try:
        with open(_PLG_CACHE) as f:
            ckey, ts, _ = f.read().split("\t", 2)
        if ckey == cwd and time.time() - float(ts) < _PLG_TTL:
            return
    except (OSError, ValueError):
        pass
    try:
        with open(_PLG_STAMP) as f:
            if time.time() - float(f.read().strip()) < _PLG_MINGAP:
                return
    except (OSError, ValueError):
        pass
    try:                                   # stamp BEFORE spawning → no thundering herd
        with open(_PLG_STAMP, "w") as f:
            f.write(str(time.time()))
    except OSError:
        return
    cmd = ["python3", os.path.abspath(__file__), "--plugin-refresh", cwd]
    if shutil.which("nice"):
        cmd = ["nice", "-n", "19"] + cmd
    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    except Exception:  # noqa: BLE001
        pass


def _plugin_seg(cwd: str) -> str:
    """Silent while every plugin loads (the 🔌 badge already carries 'tooling is
    fine'); a bold red `🧩✗3 keyvault cloudflare+1` the moment one doesn't."""
    _plugin_spawn_if_stale(cwd)
    bad = _plugin_cached(cwd)
    if not bad:
        return ""
    names = " ".join(n for n, _ in bad[:2])
    more = f"+{len(bad) - 2}" if len(bad) > 2 else ""
    return f"{_RED}{_BLD}🧩✗{len(bad)}{_RST} {_RED}{names}{more}{_RST}"


def _mcp_dir(name: str) -> str:
    """Server name → its log dir. Claude Code slugs every non-alphanumeric to '-',
    so `plugin:coolify:coolify-cli` lands in `mcp-logs-plugin-coolify-coolify-cli`."""
    return "mcp-logs-" + re.sub(r"[^A-Za-z0-9-]", "-", name)


def _mcp_enabled_plugins(cwd: str) -> dict:
    """Merged enabledPlugins across the settings files that can switch a plugin on —
    a project's .claude/settings.json enables plugins for that repo alone, so reading
    only the global file would call a perfectly-configured server 'missing'. The
    project files are resolved against the SESSION's cwd, not the process's."""
    out = {}
    for p in (_cc_file("settings.json", "~/.claude/settings.json"),
              _cc_file("settings.local.json", "~/.claude/settings.local.json"),
              os.path.join(cwd or ".", ".claude/settings.json"),
              os.path.join(cwd or ".", ".claude/settings.local.json")):
        try:
            with open(p) as f:
                out.update(json.load(f).get("enabledPlugins") or {})
        except (OSError, ValueError):
            pass
    return out


def _mcp_configured(cwd: str, started: float):
    """(labels, expected, fresh) — every MCP server this box is CONFIGURED to run,
    so the segment can also flag one that never opened a log at all. `labels` maps a
    log dir to the name `/mcp` shows; `expected` is the enabled subset; `fresh` are
    the ones (re)installed after this session started — not broken, just not loaded."""
    enabled = _mcp_enabled_plugins(cwd)
    try:
        with open(f"{HOME}/.claude/plugins/installed_plugins.json") as f:
            inst = json.load(f).get("plugins") or {}
    except (OSError, ValueError):
        inst = {}
    labels, expected, fresh = {}, set(), set()
    for key, entries in inst.items():
        plug = key.split("@", 1)[0]
        for e in entries or []:
            try:
                with open(os.path.join(e.get("installPath") or "", ".mcp.json")) as f:
                    servers = json.load(f)
            except (OSError, ValueError):
                continue
            new = _mcp_epoch(e.get("lastUpdated") or e.get("installedAt") or "")
            for srv in servers:
                d = _mcp_dir(f"plugin-{plug}-{srv}")
                labels[d] = srv
                if enabled.get(key):
                    expected.add(d)
                    if started and new and new > started:
                        fresh.add(d)
            break
    try:                                   # user-scope servers (`claude mcp add`)
        with open(_cc_file(".claude.json", "~/.claude.json")) as f:
            for srv in (json.load(f).get("mcpServers") or {}):
                labels[_mcp_dir(srv)] = srv
                expected.add(_mcp_dir(srv))
    except (OSError, ValueError):
        pass
    return labels, expected, fresh


def _mcp_epoch(stamp: str) -> float:
    """ISO-8601 (or Claude's log-file name form) → epoch; 0 when unparseable."""
    m = re.match(r"(\d{4})-(\d\d)-(\d\d)T(\d\d)[-:](\d\d)[-:](\d\d)", stamp or "")
    if not m:
        return 0.0
    try:
        return calendar.timegm(tuple(int(x) for x in m.groups()) + (0, 0, 0))
    except (ValueError, OverflowError):
        return 0.0


def _mcp_label(d: str) -> str:
    """Fallback display name for a log dir with no live plugin behind it (the plugin
    was removed, but its logs — and its failure — are still part of this session).
    The dir is `plugin-<plugin>-<server>` with both halves glued, so drop the leading
    plugin name and show the server: coolify-hostbun-coolify-hostbun → coolify-hostbun."""
    rest = d.replace("mcp-logs-", "", 1)
    if not rest.startswith("plugin-"):
        return rest
    parts = rest[len("plugin-"):].split("-")
    for k in range(1, len(parts)):
        if parts[k:k + k] == parts[:k]:
            return "-".join(parts[k:])
    return "-".join(parts)


def _mcp_sid(path: str) -> str:
    """The session a log file belongs to. Every line carries sessionId and a file is
    opened per (server, session), so the first line settles it in one read."""
    try:
        with open(path, errors="replace") as f:
            return (json.loads(f.readline()) or {}).get("sessionId") or ""
    except (OSError, ValueError):
        return ""


def _mcp_verdict(path: str) -> str:
    """'ok' | 'auth' | 'down' | 'err' from the LAST decisive line — see the note above
    on why drops and retries are deliberately not decisive. '' = no evidence either
    way, which is reported as unknown rather than guessed at."""
    try:
        sz = os.path.getsize(path)
        with open(path, errors="replace") as f:
            if sz > 65536:                 # long-lived servers log all day; the verdict
                f.seek(sz - 65536)         # only needs the tail
                f.readline()               # drop the partial line the seek landed in
            lines = f.readlines()
    except OSError:
        return ""
    state = ""
    for l in lines:
        try:
            d = json.loads(l)
        except ValueError:
            continue
        msg = " ".join(str(d.get(k) or "") for k in ("debug", "error", "message"))
        if any(p in msg for p in _MCP_BAD):
            low = msg.lower()
            # The final line of a dying server is often the bland "max reconnection
            # attempts reached, giving up" — keep the KIND diagnosed by the earlier,
            # talkative failure ("certificate", "401") rather than downgrading to ✖.
            kind = ("auth" if any(p in low for p in _MCP_AUTH) else
                    "down" if any(p in low for p in _MCP_DOWN) else "")
            state = kind or (state if state and state != "ok" else "err")
        elif any(p in msg for p in _MCP_OK):
            state = "ok"
    return state


def _mcp_scan(cwd: str, sid: str):
    """({log-dir: state}, session-start-epoch) for the servers THIS session talked to."""
    root = os.path.join(_MCP_LOGS, re.sub(r"[^A-Za-z0-9]", "-", cwd or ""))
    try:
        dirs = [e.path for e in os.scandir(root) if e.name.startswith("mcp-logs-")]
    except OSError:
        return {}, 0.0
    newest, every = {}, []
    for d in dirs:
        try:
            fs = [(e.stat().st_mtime, e.path) for e in os.scandir(d)
                  if e.name.endswith(".jsonl")]
        except OSError:
            continue
        if fs:
            every += fs
            newest[d] = sorted(fs, reverse=True)[:4]
    # Every server in one session writes to a file named for that session's start, so
    # identify that ONE basename and then match the rest by name instead of reading
    # ~60 logs. Probe by distinct basename (= one read per candidate session), because
    # a busy repo with several panes open has other sessions' files on top.
    # Hunt over EVERY file, not the per-dir window: a long-running session slides out
    # of its own dirs' top-N as newer panes open in the same repo, and windowing the
    # hunt made the badge go silent exactly when the session had been alive longest.
    base, tried = "", set()
    for _, p in sorted(every, reverse=True):
        b = os.path.basename(p)
        if b in tried:
            continue
        tried.add(b)
        if _mcp_sid(p) == sid:
            base = b
            break
        if len(tried) >= _MCP_PROBE:
            break
    if not base:
        return {}, 0.0        # this session has no MCP logs at all → say nothing
    seen = {}
    for d, fs in newest.items():
        hit = os.path.join(d, base)
        if not os.path.exists(hit):        # a server that joined late has its own file
            hit = next((p for _, p in fs if _mcp_sid(p) == sid), "")
        v = _mcp_verdict(hit) if hit else ""
        if v:
            seen[os.path.basename(d)] = v
    return seen, _mcp_epoch(base)


def _mcp_report(cwd: str, sid: str):
    """[(label, state)] for every MCP server of this session, worst first."""
    seen, started = _mcp_scan(cwd, sid)
    if not seen:
        return []
    labels, expected, fresh = _mcp_configured(cwd, started)
    # "configured but absent" is only reportable when we can see MOST of the session.
    # A repo with several panes open can bury this session's logs under newer ones,
    # leaving us a partial view — and a partial view must never be published as
    # "these servers are missing". Under that bar we report only what we did see.
    if expected and len(expected & set(seen)) * 3 >= len(expected) * 2:
        for d in expected - set(seen):
            seen[d] = "new" if d in fresh else "?"
    def label(d):
        return labels.get(d) or _mcp_label(d)
    rank = {"auth": 0, "down": 0, "err": 0, "?": 1, "new": 2, "ok": 3}
    return sorted(((label(d), s) for d, s in seen.items()),
                  key=lambda x: (rank.get(x[1], 0), x[0]))


def _mcp_seg(cwd: str, sid: str):
    """(segment, is_alarm). Quiet dim `🔌17✓` when every server answered; a bold red
    `🔌⚠1/17 🔑gitlab` naming the casualties when one didn't. The alarm also MOVES to
    the front of the line (see main) — a broken MCP must not be the thing that gets
    truncated off the right edge of a narrow pane."""
    rep = _mcp_report(cwd, sid)
    if not rep:
        return "", False
    bad = [(n, s) for n, s in rep if s in ("auth", "down", "err")]
    soft = [(n, s) for n, s in rep if s in ("?", "new")]
    n = len(rep)
    if bad:
        names = " ".join(f"{_MCP_GLYPH[s]}{nm}" for nm, s in bad[:3])
        more = f"+{len(bad) - 3}" if len(bad) > 3 else ""
        seg = f"{_RED}{_BLD}🔌⚠{len(bad)}/{n}{_RST} {_RED}{names}{more}{_RST}"
    else:
        seg = f"{_DIM}🔌{n}{_RST}{_GRN}✓{_RST}"
    if soft:
        names = " ".join(f"{_MCP_GLYPH[s]}{nm}" for nm, s in soft[:2])
        more = f"+{len(soft) - 2}" if len(soft) > 2 else ""
        seg += f" {_YEL}{names}{more}{_RST}"
    return seg, bool(bad)      # only a real failure earns the front of the line


def _mcp_dump(argv: list) -> int:
    """`cccc-statusline.py --mcp [cwd] [session]` — the per-server table behind the
    segment, for when the badge says something is down and you want to know what."""
    cwd = argv[0] if argv else os.getcwd()
    sid = argv[1] if len(argv) > 1 else ""
    if not sid:            # no session given → report the most recent one in this cwd
        root = os.path.join(_MCP_LOGS, re.sub(r"[^A-Za-z0-9]", "-", cwd))
        try:
            files = sorted((e2.stat().st_mtime, e2.path)
                           for e in os.scandir(root) if e.name.startswith("mcp-logs-")
                           for e2 in os.scandir(e.path) if e2.name.endswith(".jsonl"))
        except OSError:
            files = []
        sid = _mcp_sid(files[-1][1]) if files else ""
    seg, _ = _mcp_seg(cwd, sid)
    print(f"{cwd}  session {sid or '?'}\n{seg or '(no MCP logs for this session)'}\n")
    for name, state in _mcp_report(cwd, sid):
        print(f"  {_MCP_GLYPH.get(state, '✓')} {name:<28} {state}")
    if "--no-plugins" not in argv:
        _plugin_resolve(cwd)                       # synchronous here: you asked
        bad = _plugin_cached(cwd)
        print(f"\nplugins: {'all load' if not bad else f'{len(bad)} FAILED TO LOAD'}")
        for name, why in bad or []:
            print(f"  🧩 {name:<28} {why}")
    return 0


def _short_cwd(cwd: str) -> str:
    if not cwd:
        return ""
    if cwd.startswith(HOME):
        cwd = "~" + cwd[len(HOME):]
    segs = [s for s in cwd.split("/") if s != ""]
    if len(segs) > 2:
        return "…/" + "/".join(segs[-2:])
    return cwd


def _host_seg() -> str:
    """WHERE this pane's `claude` runs: dim 🖥name locally, loud cyan 🔗name when the
    session is over SSH. One chip answers both 'is this remote?' and 'which box?' — a
    fixer running on pbox reads 🔗pbox, the same pane on the mac reads 🖥pmac."""
    ssh = os.environ.get("SSH_CONNECTION") or os.environ.get("SSH_TTY")
    icon, col = ("🔗", _CYN) if ssh else ("🖥", _DIM)
    return f"{col}{icon}{_machine()}{_RST}"


def _issue_of(branch: str):
    """(kind, number) if this is a fixer worktree branch (fix/issue-N, fix/epic-N,
    or any …issue-N / …epic-N), else None. No regex — plain rfind, render-cheap."""
    b = branch or ""
    for kind in ("issue", "epic"):
        i = b.rfind(f"{kind}-")
        if i != -1:
            num = b[i + len(kind) + 1:]
            if num.isdigit():
                return kind, num
    return None


def _fixer_status(num: str) -> str:
    """Latest fixer phase from the cccc progress JSONL for issue #num — the live
    'issue detail'. Matches `*-<num>.jsonl` (glob is exact on the trailing number, so
    #4 never matches #14); newest-mtime wins if two repos share a number. One small
    tail read, no network. '' when there's no fixer file (e.g. a hand-made branch)."""
    import glob
    try:
        files = glob.glob(os.path.join(_PROG_DIR, f"*-{num}.jsonl"))
        if not files:
            return ""
        f = max(files, key=os.path.getmtime)
        with open(f, encoding="utf-8") as fh:
            last = fh.readlines()[-1]
        d = json.loads(last)
    except (OSError, IndexError, ValueError):
        return ""
    phase = str(d.get("phase") or "")
    mark = {"done": "✓", "running": "…", "blocked": "✗", "error": "✗"}.get(
        str(d.get("status") or ""), "")
    return (phase + mark)[:14]


def _issue_seg(branch: str) -> str:
    """`🔧#42·push✓` — the issue this pane is fixing + its live phase. Yellow so a
    fixer pane is instantly distinct from a plain dev pane."""
    m = _issue_of(branch)
    if not m:
        return ""
    kind, num = m
    tag = f"epic#{num}" if kind == "epic" else f"#{num}"
    detail = _fixer_status(num)
    seg = f"{_YEL}🔧{tag}{_RST}"
    return seg + (f"{_DIM}·{detail}{_RST}" if detail else "")


def _git(cwd: str):
    """(branch, dirty_count) for cwd, or ('', 0) if not a repo.

    This runs SYNCHRONOUSLY on the render path (every prompt), so both git calls are
    bounded + fail-safe: a repo on a hung NFS mount, a huge tree, or a stale
    index.lock would otherwise freeze the whole line — the one thing this file forbids."""
    d = cwd or "."
    try:
        branch = subprocess.run(["git", "-C", d, "symbolic-ref", "--short", "HEAD"],
                                capture_output=True, text=True, timeout=3).stdout.strip()
        if not branch:
            return "", 0
        porc = subprocess.run(["git", "-C", d, "status", "--porcelain"],
                              capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return "", 0
    dirty = sum(1 for ln in porc.splitlines() if ln.strip())
    return branch, dirty


def _git_host(cwd: str) -> str:
    """Which forge the `origin` remote points at — 'gitlab', 'github', or a bare
    hostname for anything else ('' if no remote / not a repo). The fleet migrated
    GitHub→GitLab (gitlab.hostbun.cc), so at a glance you want to know whether the
    branch you're on actually lives on GitLab or is still a GitHub checkout.

    Cached per-cwd (300 s) — the origin URL only moves on a `remote set-url`, so we
    don't want a git spawn on every render."""
    d = cwd or "."
    try:
        with open(_HOST_CACHE) as f:
            for ln in f:
                cdir, ts, host = (ln.rstrip("\n").split("\t", 2) + ["", "", ""])[:3]
                if cdir == d and time.time() - float(ts or 0) < _HOST_TTL:
                    return host
    except (OSError, ValueError):
        pass
    try:
        url = subprocess.run(["git", "-C", d, "remote", "get-url", "origin"],
                             capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""
    low = url.lower()
    if "gitlab" in low:
        host = "gitlab"
    elif "github" in low:
        host = "github"
    elif url:
        # anything else: pull the bare hostname out of scp-style or URL-style remotes
        m = re.search(r"@([^:/]+)|https?://([^/]+)", url)
        host = (m.group(1) or m.group(2)) if m else "git"
    else:
        host = ""
    try:
        with open(_HOST_CACHE, "w") as f:
            f.write(f"{d}\t{time.time()}\t{host}")
    except OSError:
        pass
    return host


def _host_badge(host: str) -> str:
    """Small forge badge for the branch segment. GitLab is loud (magenta 🦊) because
    that's the fleet's current home; GitHub and others stay dim so they don't shout."""
    if host == "gitlab":
        return f"{_MAG}🦊gl{_RST}"
    if host == "github":
        return f"{_DIM}gh{_RST}"
    if host:
        return f"{_DIM}{host}{_RST}"
    return ""


def _issue_from_branch(branch: str) -> str:
    """Pull a GitHub issue number out of a conventional branch name — `123-fix-thing`,
    `feature/123-desc`, `fix-123`, `gh-123` — or '' if the branch names nothing. Purely
    a naming-convention guess (no gh/API call on the render path), but it's the common
    case and costs nothing."""
    m = _ISSUE_RE.search(branch or "")
    return m.group(1) if m else ""


def _issue_state_resolve(cwd: str, num: str) -> None:
    """Background pass (invoked as `--issue-refresh <cwd> <num>`): ask `gh` whether the
    issue the branch names is OPEN or CLOSED, cache the verdict. Runs in `cwd` so `gh`
    resolves the right repo with no extra flags. Best-effort — any failure just leaves
    the previous cache untouched (render falls back to whatever's cached, or no badge)."""
    if not cwd or not num:
        return
    try:
        out = subprocess.run(["gh", "issue", "view", num, "--json", "state"],
                             cwd=cwd, capture_output=True, text=True, timeout=15)
        if out.returncode != 0:
            return
        state = (json.loads(out.stdout).get("state") or "").upper()
    except Exception:  # noqa: BLE001
        return
    if state not in ("OPEN", "CLOSED"):
        return
    try:
        with open(_ISSUE_CACHE, "w") as f:
            f.write(f"{cwd}\t{num}\t{time.time()}\t{state}")
    except OSError:
        pass


def _issue_state_spawn(cwd: str, num: str) -> None:
    """Fire the background `gh` lookup, throttled to at most once every
    `_ISSUE_MINGAP` seconds (even on failure) — never more than one `gh` spawn in
    flight for the render path."""
    try:
        if time.time() - os.stat(_ISSUE_STAMP).st_mtime < _ISSUE_MINGAP:
            return
    except OSError:
        pass
    try:
        with open(_ISSUE_STAMP, "w") as f:      # stamp BEFORE spawn → throttle failures too
            f.write(str(time.time()))
        subprocess.Popen([sys.executable, os.path.abspath(__file__),
                          "--issue-refresh", cwd, num],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    except Exception:  # noqa: BLE001
        pass


def _issue_state_cached(cwd: str, num: str) -> str:
    """'OPEN'/'CLOSED' for issue #num (from cwd's repo), read from the cache — NEVER
    spawns `gh` synchronously. Kicks a throttled background refresh whenever the cached
    reading is missing, stale, or for a different cwd/issue than asked for; still
    returns the (possibly stale) cached value so the badge shows something between
    refreshes rather than flickering blank."""
    state = ""
    try:
        with open(_ISSUE_CACHE) as f:
            c_cwd, c_num, ts, st = f.read().split("\t", 3)
        if c_cwd == cwd and c_num == num:
            state = st.strip()
            if time.time() - float(ts) < _ISSUE_TTL:
                return state
    except (OSError, ValueError):
        pass
    _issue_state_spawn(cwd, num)
    return state


def _branch_seg(branch: str, dirty: int, pr: dict, host: str = "", cwd: str = "") -> str:
    """Branch segment, styled so a FEATURE branch visually jumps out from `main`:
      main/master/…   dim `⑂branch` — quiet, matches every other dim label
      feature branch  bold ORANGE `🌿branch` — loud, you can't miss you're off trunk
    A forge badge (🦊gl for GitLab, dim gh for GitHub) leads the segment so you know
    at a glance which host the branch lives on. A linked PR (from Claude Code's own
    `pr` field) or a branch-name issue number rides alongside, coloured by PR review
    state when known. The linked issue's OPEN/CLOSED state (from a cached, throttled
    `gh issue view`) rides right on the issue number — cyan `#123·open` means the branch
    still points at an open issue, dim `#123✓closed` means the issue is done (you may be
    on a stale branch); no state yet resolved just shows plain cyan `#123`."""
    is_main = branch in _MAIN_BRANCHES
    badge = _host_badge(host)
    lead = f"{badge}{_DIM}·{_RST}" if badge else ""
    seg = lead + (f"{_DIM}⑂{_RST}{branch}" if is_main else f"{_ORANGE}{_BLD}🌿{branch}{_RST}")
    if dirty:
        seg += f"{_YEL}±{dirty}{_RST}"
    pr_num = (pr or {}).get("number")
    if pr_num:
        state = (pr or {}).get("review_state") or "open"
        pcol = _GRN if state == "approved" else _RED if state == "changes_requested" else _YEL
        seg += f"{_DIM}·{_RST}{pcol}PR#{pr_num}{_RST}"
    else:
        issue = _issue_from_branch(branch)
        if issue:
            ist = _issue_state_cached(cwd, issue) if cwd else ""
            if ist == "CLOSED":
                seg += f"{_DIM}·{_RST}{_DIM}#{issue}✓closed{_RST}"
            elif ist == "OPEN":
                seg += f"{_DIM}·{_RST}{_CYN}#{issue}{_RST}{_GRN}·open{_RST}"
            else:                                # not yet resolved — plain, no assumption
                seg += f"{_DIM}·{_RST}{_CYN}#{issue}{_RST}"
    return seg


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
        with open(_cc_file(".credentials.json", f"{HOME}/.claude/.credentials.json")) as f:
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
        with open(_cc_file(".claude.json", f"{HOME}/.claude.json")) as f:
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
    try:
        sha = subprocess.run(["git", "-C", repo, "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, timeout=3).stdout.strip()
        val = ""
        if sha:
            dirty = subprocess.run(["git", "-C", repo, "status", "--porcelain", "-uno"],
                                   capture_output=True, text=True, timeout=3).stdout.strip()
            val = f"cctl:{sha}{'*' if dirty else ''}"
    except (OSError, subprocess.SubprocessError):
        return ""
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
            # feed the JSON on stdin and CLOSE it — without communicate()/close the
            # child blocks on read() forever, orphaning a hung bash every render.
            p = subprocess.Popen(["bash", feed], stdin=subprocess.PIPE,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            p.stdin.write(raw.encode())
            p.stdin.close()
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



def main() -> int:
    if "--whoami" in sys.argv:      # background self-invocation: resolve + cache, no stdin
        _whoami_resolve()
        return 0
    if "--anthropic-refresh" in sys.argv:   # background: cache the proxy's sticky account + headroom
        _anthropic_refresh()
        return 0
    if "--mcp" in sys.argv:         # human: the per-server table behind the 🔌 badge
        return _mcp_dump(sys.argv[sys.argv.index("--mcp") + 1:])
    if "--plugin-refresh" in sys.argv:  # background: ask `claude` which plugins broke
        i = sys.argv.index("--plugin-refresh")
        _plugin_resolve(sys.argv[i + 1] if len(sys.argv) > i + 1 else os.getcwd())
        return 0
    if "--issue-refresh" in sys.argv:       # background: cache linked-issue OPEN/CLOSED via `gh`
        i = sys.argv.index("--issue-refresh")
        _issue_state_resolve(sys.argv[i + 1] if len(sys.argv) > i + 1 else "",
                             sys.argv[i + 2] if len(sys.argv) > i + 2 else "")
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
    line1 = [_host_seg()]               # 🖥pmac / 🔗pbox — where + is-it-ssh, always first
    sc = _short_cwd(cwd)
    if sc:
        line1.append(f"{_DIM}📁{_RST}{sc}")
    if branch:
        # rich branch segment: forge badge (🦊gl/gh) + orange feature-branch flag +
        # linked-issue open/closed chip. See _branch_seg.
        line1.append(_branch_seg(branch, dirty, d.get("pr") or {}, _git_host(cwd), cwd))
    iss = _issue_seg(branch)            # 🔧#N·phase when this is a fixer worktree
    if iss:
        line1.append(iss)
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
        line1.append(_gauge_seg("ctx", ctx_free))       # % context FREE: 100 green → 0 red
    box = _box_free()
    if box is not None and box < 60:                    # show box only when it's LOADED —
        line1.append(_gauge_seg("box", box))            # an idle box gauge is noise (compact)
    cmx = _cmux_seg()                   # ⧉21·3h — the terminals attached to this box,
    if cmx:                             # and how long the link has been up
        line1.append(cmx)
    lsp = _lsp_seg(cwd)
    if lsp:
        line1.append(lsp)
    # MCP health. Quiet ✓ lives with the other tooling at the end of the line; the
    # moment a server is actually broken the badge jumps to slot 2, right behind the
    # host chip, so it survives a narrow pane. The position IS part of the signal.
    mcp, mcp_alarm = _mcp_seg(cwd, d.get("session_id") or "")
    if mcp:
        line1.insert(1, mcp) if mcp_alarm else line1.append(mcp)
    plg = _plugin_seg(cwd)          # a plugin that never LOADED — no MCP log to find
    if plg:
        line1.insert(1, plg)        # always an alarm; same front-of-line rule

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
    # Compact: 5h/7d ride the account tag with "/" between them instead of a full space,
    # e.g. `👤acct✓ 5h▆88%↻2h/7d▂27%↻4d` instead of the wider `… 5h▆88%↻2h 7d▂27%↻4d`.
    line2 = [acct + ((" " + "/".join(limit_segs)) if limit_segs else "")]
    if tail:
        line2[0] += f" {tail}"
    v = _version()
    if v:
        line2.append(f"{_DIM}{v}{_RST}")             # tail anchor — spot cross-machine drift

    sys.stdout.write(" · ".join(line1) + "\n" + " · ".join(line2))
    _side_effects(raw)
    _auto_sync()                          # background, throttled, non-blocking
    return 0


def _selftest_cmux():
    """The ⧉ segment's honesty rules, which are the whole reason it can be trusted:
    a count is only ever drawn from a snapshot that was actually READ and is fresh."""
    import re as _re, tempfile as _tmp
    strip = lambda s: _re.sub(r"\x1b\[[0-9;]*m", "", s)
    global _CMUX_SNAP, _link_uptime
    real_snap, real_up = _CMUX_SNAP, _link_uptime
    d = _tmp.mkdtemp()

    def put(at, rows):
        global _CMUX_SNAP
        p = os.path.join(d, "s.json")
        with open(p, "w") as fh:
            json.dump({"sections": {"workspaces": {"at": at, "data": rows}}}, fh)
        _CMUX_SNAP = p

    try:
        ok = [{"dest": "pbox", "state": "connected", "daemon": "ready"}] * 3
        _link_uptime = lambda: 4 * 3600
        put(time.time(), ok)
        assert strip(_cmux_seg()) == "⧉3·4h"
        # one workspace down is NEVER a bare count -- that reads as an all-clear
        put(time.time(), ok + [{"dest": "pbox", "state": "connecting", "daemon": ""}])
        assert strip(_cmux_seg()) == "⧉3/4·4h"
        # a stale snapshot renders `?`, never the number it happens to still hold.
        # The LINK age is a live read and stands
        put(time.time() - _CMUX_SNAP_STALE - 1, ok)
        assert strip(_cmux_seg()) == "⧉?·4h"
        # unread and empty must not look alike: no file, and no remote workspaces,
        # both draw NOTHING rather than a zero
        _CMUX_SNAP = os.path.join(d, "nope.json")
        assert _cmux_seg() == ""
        put(time.time(), [{"dest": "", "state": "", "daemon": ""}])
        assert _cmux_seg() == ""
        # and on a box that runs no cmuxd-remote (the Mac) there is nothing to say
        put(time.time(), ok)
        _link_uptime = lambda: None
        assert _cmux_seg() == ""
        assert _age(45) == "45s" and _age(700) == "11m" and _age(14400) == "4h"
        print("cmux statusline segment: selftest ok")
        return 0
    finally:
        _CMUX_SNAP, _link_uptime = real_snap, real_up


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_selftest_cmux())
    raise SystemExit(main())
