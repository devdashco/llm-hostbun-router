#!/usr/bin/env python3
"""plugin_profiles — resolve + apply per-project Claude Code plugin sets.

The token problem: every enabled plugin's MCP tool schemas ride in the system
prompt of EVERY request. ~350K tokens of tool defs re-read (cached, 10%) every
turn. The fix: a lean GLOBAL set, and each repo pins its own full set in
`<repo>/.claude/settings.json` (git-tracked → syncs to every box; versionless
plugin keys → survive updates).

Gotcha (verified): Claude Code does NOT merge `enabledPlugins` across scopes — a
project file REPLACES the user-global map. So each repo's file must carry the
COMPLETE set = core + that project's packs. This module builds that set from
`plugin-profiles.json` (repo root) and writes it, preserving every other key in
the target settings.json.

Pure stdlib — imported by claudectl_tui.py's Plugins tab; no deps.
"""
from __future__ import annotations

import json
import os

HOME = os.path.expanduser("~")
_HERE = os.path.dirname(os.path.abspath(__file__))


def _cc_config_dir() -> str:
    """Claude Code's config dir — honors CLAUDE_CONFIG_DIR (else ~/.claude), so the
    Plugins tab reads the SAME settings `claude` uses, not a stale default."""
    d = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return os.path.expanduser(d) if d else os.path.join(HOME, ".claude")


def _claude_json() -> str:
    """`.claude.json` — inside CLAUDE_CONFIG_DIR when relocated (undocumented but that's
    where the whole config moves), else the legacy ~/.claude.json."""
    cand = os.path.join(_cc_config_dir(), ".claude.json")
    return cand if os.path.exists(cand) else os.path.join(HOME, ".claude.json")


# plugin-profiles.json lives at the repo root, one level up from tui/
CONFIG_PATH = os.path.abspath(os.path.join(_HERE, os.pardir, "plugin-profiles.json"))
GLOBAL_SETTINGS = os.path.join(_cc_config_dir(), "settings.json")
GITHUB_ROOT = os.path.join(HOME, "Documents", "GitHub")


# ---------------------------------------------------------------- config
def load(path: str = CONFIG_PATH) -> dict:
    """Read plugin-profiles.json. Returns {} on any error (caller shows a hint)."""
    try:
        with open(path) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _full(name: str, mkt: dict) -> str:
    """name -> 'name@marketplace' (default @devdash, overrides in _marketplace)."""
    return f"{name}@{mkt.get(name, 'devdash')}"


def resolve(cfg: dict, project: str) -> list[str]:
    """Full plugin id list for a project = core + its packs, de-duped + sorted.
    Unmapped project -> core only."""
    mkt = cfg.get("_marketplace") or {}
    packs = cfg.get("packs") or {}
    names = list(cfg.get("core") or [])
    for pk in (cfg.get("projects") or {}).get(project, []):
        names += packs.get(pk, [])
    return sorted({_full(n, mkt) for n in names})


def project_packs(cfg: dict, project: str) -> list[str]:
    return list((cfg.get("projects") or {}).get(project, []))


def projects(cfg: dict) -> list[str]:
    """Mapped project names, sorted (core-only projects included if listed)."""
    return sorted((cfg.get("projects") or {}).keys())


def core_ids(cfg: dict) -> list[str]:
    mkt = cfg.get("_marketplace") or {}
    return sorted({_full(n, mkt) for n in (cfg.get("core") or [])})


# ---------------------------------------------------------------- repo paths
_PATH_INDEX: dict[str, str] | None = None


def _index() -> dict[str, str]:
    """basename -> absolute repo path. Built once from the GitHub root plus the
    project keys Claude Code already knows (~/.claude.json)."""
    global _PATH_INDEX
    if _PATH_INDEX is not None:
        return _PATH_INDEX
    idx: dict[str, str] = {}
    # 1) GitHub root (the common case)
    try:
        for name in os.listdir(GITHUB_ROOT):
            p = os.path.join(GITHUB_ROOT, name)
            if os.path.isdir(p):
                idx.setdefault(name, p)
    except OSError:
        pass
    # 2) anything Claude Code has opened (covers nested/odd locations)
    try:
        with open(_claude_json()) as f:
            projs = (json.load(f).get("projects") or {})
        for path in projs:
            if os.path.isdir(path):
                idx.setdefault(os.path.basename(path.rstrip("/")), path)
    except Exception:
        pass
    _PATH_INDEX = idx
    return idx


def repo_path(project: str) -> str | None:
    """Absolute path for a project basename, or None if not found on this box."""
    return _index().get(project)


# ---------------------------------------------------------------- read/write
def _read_json(path: str) -> dict:
    try:
        with open(path) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _enabled_true(settings: dict) -> set[str]:
    """The set of plugin ids currently switched ON in a settings dict."""
    ep = settings.get("enabledPlugins") or {}
    return {k for k, v in ep.items() if v is True}


def repo_enabled(path: str) -> set[str] | None:
    """Plugin ids ON in <repo>/.claude/settings.json. None = no such file
    (repo inherits the global set)."""
    sp = os.path.join(path, ".claude", "settings.json")
    if not os.path.exists(sp):
        return None
    return _enabled_true(_read_json(sp))


def status(cfg: dict, project: str) -> str:
    """'applied' (repo file matches resolved) | 'drift' (differs) | 'inherit'
    (no repo file yet) | 'no-repo' (project dir not on this box)."""
    path = repo_path(project)
    if not path:
        return "no-repo"
    cur = repo_enabled(path)
    if cur is None:
        return "inherit"
    return "applied" if cur == set(resolve(cfg, project)) else "drift"


def _write_settings(sp: str, plugins: list[str]) -> dict:
    """Set enabledPlugins = {p: true} in the settings.json at `sp`, preserving
    every OTHER key. Atomic (tmp + replace). Returns {ok, error?}."""
    try:
        os.makedirs(os.path.dirname(sp), exist_ok=True)
        settings = _read_json(sp)
        settings["enabledPlugins"] = {p: True for p in plugins}
        tmp = sp + ".tmp"
        with open(tmp, "w") as f:
            json.dump(settings, f, indent=2)
            f.write("\n")
        os.replace(tmp, sp)
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"[:160]}


def apply_project(cfg: dict, project: str) -> dict:
    """Write the resolved full set into <repo>/.claude/settings.json.
    Returns {ok, path?, count?, error?}."""
    path = repo_path(project)
    if not path:
        return {"ok": False, "error": f"repo '{project}' not found on this machine"}
    plugins = resolve(cfg, project)
    sp = os.path.join(path, ".claude", "settings.json")
    r = _write_settings(sp, plugins)
    if r.get("ok"):
        r.update(path=sp, count=len(plugins))
    return r


def apply_global_lean(cfg: dict) -> dict:
    """Set the GLOBAL ~/.claude/settings.json enabledPlugins to core only, so any
    repo WITHOUT its own file loads just the lean core. Preserves other keys.
    (Note: the ~5 bare mcpServers in ~/.claude.json load regardless — this only
    trims plugin-provided servers, which is where the token weight is.)"""
    core = core_ids(cfg)
    if not core:
        return {"ok": False, "error": "no core defined in plugin-profiles.json"}
    r = _write_settings(GLOBAL_SETTINGS, core)
    if r.get("ok"):
        r.update(path=GLOBAL_SETTINGS, count=len(core))
    return r
