#!/usr/bin/env python3
"""claudectl — the ONE local MCP, served over loopback HTTP by ONE daemon per box.

Consolidation: the plugin used to ship TWO servers — a remote HTTP `claudectl`
(account/limit/proxy tools, deployed container) and a local stdio `ccc-terminals`
(terminals + plugin/marketplace mgmt). This merges both into a SINGLE local
server named `claudectl` that installs on your machine and provides the whole SDK:

  * account / limit / proxy tools  — reused verbatim from `server/claudectl_server.py`
    (httpx → llm.hostbun.cc ONLY: the account tools now drive the router's
    /api/* control plane — the claude.hostbun.cc wrapper is retired. Your
    laptop can reach the router directly, so they don't need the deployed
    container anymore).
  * terminals + plugin/marketplace tools — reused from `ccc_terminals_mcp.py`
    (local cmux + ssh→tmux; a remote container could never reach these).

Same FastMCP instance, one `tools/list`.

⚠ IT IS NOT stdio ANY MORE, AND IT MUST NOT GO BACK. Claude Code forks a stdio
server once per open session, and this one is a `mcp` + `httpx` python: measured
on pbox 2026-07-30 at **50 live processes, 0.65 GB PSS**, before a single tool
call — the biggest per-session MCP on the box. It is now ONE daemon
(`claudectl-mcp.service` / the launchd twin, installed by install.sh) that every
session shares over `http://127.0.0.1:9150/mcp`.

⚠ AND IT CANNOT BE HOSTED like the other fleet MCPs (mcp-rules §1 wants a real
URL, not loopback). Two thirds of these tools read and write THIS box —
`~/.claude` plugin/marketplace/mcp state, the local cmux and tmux panes — so a
container on hostbun would answer about the wrong machine. Loopback is the
correct address here; the rule it must still honour is "one process per box, not
one per session". The daemon is `Restart=always`, so a dead one is a visible ✘ in
`claude mcp list` rather than a silent leak.

Deps: `mcp` + `httpx` (installed by install.sh). If they're missing we fall back
to the pure-stdlib terminals-only server so the plugin never hard-fails.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# plugin layout: <repo>/plugins/claudectl/mcp/ → repo root is three up
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
# The plugin ships as a git-subdir of ONLY plugins/claudectl/ — so `server/` is
# NOT in the plugin cache. `claudectl_server.py` is therefore BUNDLED next to this
# file (a copy of server/claudectl_server.py; keep in sync — deploy.sh refreshes
# it). In a full dev/install.sh checkout the canonical server/ copy takes priority.
sys.path.insert(0, HERE)                          # bundled claudectl_server + ccc_terminals_mcp
sys.path.insert(0, os.path.join(REPO, "server"))  # dev: canonical server/ wins if present

# Default the router admin password the same way the deployed server does, so
# the account/proxy tools authenticate to llm.hostbun.cc without extra config.
os.environ.setdefault("ADMIN_PASSWORD", "ddash")

try:
    from claudectl_server import mcp  # FastMCP("claudectl") + all account/proxy tools
    import ccc_terminals_mcp as T
    _MERGED = True
except Exception as exc:  # noqa: BLE001 — mcp/httpx not installed → degrade gracefully
    sys.stderr.write(
        f"[claudectl] account tools unavailable ({exc}); "
        "serving terminals-only. Run install.sh to add the `mcp`+`httpx` deps.\n")
    _MERGED = False


def _register_terminal_tools() -> None:
    """Add the local terminals + plugin/marketplace tools onto the FastMCP
    instance. Thin sync wrappers → the op_* functions already in ccc_terminals_mcp
    (FastMCP derives the schema from these signatures + docstrings)."""
    from typing import Optional

    @mcp.tool()
    def terminals_list(machine: Optional[str] = None,
                       kind: Optional[str] = None) -> str:
        """List EVERY terminal on every box (this mac's cmux surfaces + ssh→tmux
        panes on the Linux boxes), normalized to one shape. machine filters to one
        box ('pbox', 'local'); kind filters (e.g. 'claude'). JSON."""
        return T.op_panes(machine, kind)

    @mcp.tool()
    def terminals_peek(machine: str, target: str, lines: int = 14) -> str:
        """Read the last `lines` of one pane's screen. target is the box-native
        address from terminals_list (cmux 'surface:N' or tmux 'session:win.pane')."""
        return T.op_peek(machine, target, lines)

    @mcp.tool()
    def terminals_send(machine: str, target: str, text: str) -> str:
        """Type text into a pane (no Enter — follow with terminals_key 'enter')."""
        return T.op_send(machine, target, text)

    @mcp.tool()
    def terminals_key(machine: str, target: str, key: str) -> str:
        """Send a key/chord to a pane (e.g. 'enter', 'C-c', 'escape')."""
        return T.op_key(machine, target, key)

    @mcp.tool()
    def terminals_restart(machine: str, target: str) -> str:
        """Respawn a pane, resuming the SAME claude session on the current account.
        cmux replays the resume-binding; tmux reopens via `claude --continue`.
        Refuses to respawn the pane running THIS server (would kill it mid-call)."""
        return T.op_restart(machine, target)

    @mcp.tool()
    def ccc_selftest() -> str:
        """Trivial side-effect-free probe that a fresh session wired up this MCP."""
        return T.op_selftest()

    # ---- plugin / marketplace / MCP management (LOCAL cmux only) ----
    @mcp.tool()
    def marketplace_update(name: Optional[str] = None) -> str:
        """Update one marketplace (or all if omitted) on THIS box."""
        return T.op_marketplace_update(name)

    @mcp.tool()
    def marketplace_list() -> str:
        """List marketplaces registered on this box."""
        return T.op_marketplace_list()

    @mcp.tool()
    def marketplace_add(source: str) -> str:
        """Add a marketplace by source (git url / path)."""
        return T.op_marketplace_add(source)

    @mcp.tool()
    def marketplace_remove(name: str) -> str:
        """Remove a marketplace by name."""
        return T.op_marketplace_remove(name)

    @mcp.tool()
    def plugins_list() -> str:
        """List installed plugins on this box."""
        return T.op_plugins_list()

    @mcp.tool()
    def plugins_available(query: Optional[str] = None,
                          marketplace: Optional[str] = None,
                          limit: int = 200) -> str:
        """Browse the CATALOG of every plugin installable from the configured
        marketplaces, grouped by marketplace, each marked ✓ installed or +
        installable. Filter with `query` (substring over name/description/id) or
        `marketplace`, then plugin_install to add one. Plugin-bundled MCP servers
        show up here too — this is the discovery surface for both."""
        return T.op_plugins_available(query, marketplace, limit)

    @mcp.tool()
    def plugin_install(plugin: str, scope: Optional[str] = None) -> str:
        """Install a plugin (name@marketplace)."""
        return T.op_plugin_install(plugin, scope)

    @mcp.tool()
    def plugin_update(plugin: str) -> str:
        """Update an installed plugin."""
        return T.op_plugin_update(plugin)

    @mcp.tool()
    def plugin_toggle(plugin: str, enable: bool) -> str:
        """Enable/disable a plugin."""
        return T.op_plugin_toggle(plugin, enable)

    @mcp.tool()
    def plugin_uninstall(plugin: str) -> str:
        """Uninstall a plugin."""
        return T.op_plugin_uninstall(plugin)

    @mcp.tool()
    def mcp_list() -> str:
        """List MCP servers configured on this box."""
        return T.op_mcp_list()

    @mcp.tool()
    def mcp_add(name: str, command_or_url: str,
                args: Optional[list] = None,
                transport: Optional[str] = None,
                scope: Optional[str] = None) -> str:
        """Add an MCP server (loaded at next session start)."""
        return T.op_mcp_add(name, command_or_url, args, transport, scope)

    @mcp.tool()
    def mcp_remove(name: str, scope: Optional[str] = None) -> str:
        """Remove an MCP server by name."""
        return T.op_mcp_remove(name, scope)

    @mcp.tool()
    def reload_apply(surface: str = "self", method: str = "respawn",
                     text: Optional[str] = None, delay: float = 2.0) -> str:
        """Relaunch a pane so on-disk plugin/MCP changes take effect."""
        return T.op_reload_apply(surface, method, text, delay)

    @mcp.tool()
    def reload(scope: str = "marketplaces", apply: bool = True,
               surface: str = "self", delay: float = 2.0) -> str:
        """One-shot: pull latest marketplaces/plugins, then relaunch the pane."""
        return T.op_reload(scope, apply, surface, delay)


def _serve_http() -> None:
    """One daemon per box, loopback only. See the module docstring for why this
    is http-on-127.0.0.1 rather than either stdio or a hosted URL."""
    import uvicorn
    from _auth import BearerMiddleware

    host = os.environ.get("CLAUDECTL_LOCAL_HOST", "127.0.0.1")
    port = int(os.environ.get("CLAUDECTL_LOCAL_PORT", "9150"))
    # ⚠ Bind loopback, and STILL require the bearer. These tools install plugins,
    # rewrite ~/.claude and type into terminals — "only local processes can reach
    # it" is not an access decision on a box that runs dozens of agents.
    os.environ.setdefault("STATIC_BEARER", "ddash")
    sys.stderr.write(f"[claudectl] serving http://{host}:{port}/mcp\n")
    uvicorn.run(BearerMiddleware(mcp.streamable_http_app()), host=host, port=port)


if __name__ == "__main__":
    if not _MERGED:
        # Deps missing — run the self-contained stdlib terminals server so the
        # plugin still provides terminal control (account tools just absent).
        # stdio only: that fallback has no HTTP app to serve.
        import ccc_terminals_mcp as T
        raise SystemExit(T.main())

    _register_terminal_tools()
    # `stdio` stays reachable for a one-off debug run (`--stdio`), but it is NOT
    # what the plugin launches any more — see the docstring.
    if "--stdio" in sys.argv or os.environ.get("CLAUDECTL_LOCAL_TRANSPORT") == "stdio":
        mcp.run(transport="stdio")
    else:
        _serve_http()
