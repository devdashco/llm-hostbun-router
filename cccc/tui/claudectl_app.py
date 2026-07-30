#!/usr/bin/env python3
"""claudectl_app — a TEXTUAL port of claudectl_tui.py (the curses dashboard for the
Claude Max account pool behind the llm.hostbun.cc router).

Same four tabs (Accounts · Windows · Plugins · Setup), same actions, same
navigation intent (←/→ switch tab, ↑/↓ move within it, ↵ opens/runs, q quits).
Only the RENDERING + input loop are new — every piece of data/logic (router
urllib calls, `security` keychain access, `ps`/process scan, `cmux` broadcast,
git sync, account/limit parsing, the action handlers) is imported VERBATIM from
`claudectl_tui` as `core`, and the per-project plugin logic from
`plugin_profiles` as `pp`. Nothing about the endpoints/params/env/defaults
changes — see claudectl_tui.py for that.

Run:
  python3 claudectl_app.py      (self-bootstraps textual via uv if missing)

Env: identical to claudectl_tui.py (CCTL_LLM_ADMIN, CCTL_LLM_PW, CLAUDECTL_MCP, …).
"""
from __future__ import annotations

# --- self-bootstrap: re-exec under `uv run --with textual` if textual is absent -----
try:
    import textual  # noqa: F401
except ImportError:
    import os as _os
    import shutil as _shutil
    import sys as _sys
    _uv = _shutil.which("uv")
    if _uv:
        _os.execvp(_uv, [_uv, "run", "--with", "textual", "python3", __file__, *_sys.argv[1:]])
    _sys.exit("claudectl: need textual (install uv or pip install textual)")

import asyncio
import os
import sys
import threading
import time

# import the ENTIRE curses module for its logic — it does no work at import time
# (curses only runs inside curses.wrapper(run), which we never call). All router /
# keychain / ps / cmux / git / parsing functions come straight from here, unchanged.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import claudectl_tui as core   # noqa: E402
import plugin_profiles as pp   # noqa: E402

from rich.text import Text                                    # noqa: E402
from textual import work                                     # noqa: E402
from textual.app import App, ComposeResult                   # noqa: E402
from textual.containers import Vertical, VerticalScroll       # noqa: E402
from textual.screen import ModalScreen                        # noqa: E402
from textual.widgets import (                                 # noqa: E402
    DataTable, Footer, Input, OptionList, Static, TabbedContent, TabPane)

REFRESH_MS = core.REFRESH_MS


# ----------------------------------------------------------------- modal screens
class MenuScreen(ModalScreen):
    """Arrow-selectable action menu (curses `_menu` equivalent). items =
    [(label, value, desc), …]. ↑/↓ move, ↵ picks (dismisses with value), Esc
    cancels (dismisses None). The highlighted action's blurb shows below."""
    BINDINGS = [("escape", "cancel", "Cancel")]

    def __init__(self, title: str, items):
        super().__init__()
        self._title = title
        self._items = [(it[0], it[1], (it[2] if len(it) > 2 else "")) for it in items]

    def compose(self) -> ComposeResult:
        with Vertical(id="menu_box"):
            yield Static(Text(f" {self._title} ", style="bold"), id="menu_title")
            ol = OptionList(*[it[0] for it in self._items], id="menu_list")
            yield ol
            yield Static("", id="menu_desc")
            yield Static(Text("[↑↓] move   [↵] pick   [esc] back", style="dim"), id="menu_hint")

    def on_mount(self) -> None:
        self.query_one("#menu_list", OptionList).focus()

    def on_option_list_option_highlighted(self, event: OptionList.OptionHighlighted) -> None:
        self.query_one("#menu_desc", Static).update(
            Text(self._items[event.option_index][2], style="cyan"))

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        event.stop()
        self.dismiss(self._items[event.option_index][1])

    def action_cancel(self) -> None:
        self.dismiss(None)


class ConfirmScreen(ModalScreen):
    """y/N confirm (curses `_confirm`). Returns True/False."""
    BINDINGS = [("y", "yes", "Yes"), ("n", "no", "No"), ("escape", "no", "No")]

    def __init__(self, msg: str):
        super().__init__()
        self._msg = msg

    def compose(self) -> ComposeResult:
        with Vertical(id="confirm_box"):
            yield Static(Text(self._msg, style="bold"))
            ol = OptionList("Yes", "No", id="confirm_list")
            yield ol
            yield Static(Text("[y] yes   [n/esc] no", style="dim"))

    def on_mount(self) -> None:
        self.query_one("#confirm_list", OptionList).focus()

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        event.stop()
        self.dismiss(event.option_index == 0)

    def action_yes(self) -> None:
        self.dismiss(True)

    def action_no(self) -> None:
        self.dismiss(False)


class PromptScreen(ModalScreen):
    """One-line text entry (curses `_prompt`). Returns the trimmed string, or
    None if cancelled (Esc)."""
    BINDINGS = [("escape", "cancel", "Cancel")]

    def __init__(self, label: str, secret: bool = False):
        super().__init__()
        self._label = label
        self._secret = secret

    def compose(self) -> ComposeResult:
        with Vertical(id="prompt_box"):
            yield Static(Text(self._label, style="bold"))
            yield Input(password=self._secret, id="prompt_input")

    def on_mount(self) -> None:
        self.query_one("#prompt_input", Input).focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        event.stop()
        self.dismiss((event.value or "").strip())

    def action_cancel(self) -> None:
        self.dismiss(None)


class InfoScreen(ModalScreen):
    """Read-only popup (curses `_popup`). Esc/Enter to close."""
    BINDINGS = [("escape", "close", "Close"), ("enter", "close", "Close")]

    def __init__(self, title: str, text: str):
        super().__init__()
        self._title = title
        self._text = text

    def compose(self) -> ComposeResult:
        with Vertical(id="info_box"):
            yield Static(Text(f" {self._title} ", style="bold"))
            with VerticalScroll():
                yield Static(self._text or "")
            yield Static(Text("[esc] close", style="dim"))

    def action_close(self) -> None:
        self.dismiss(None)


# ----------------------------------------------------------------- helpers
def _bar_split(u, width=6):
    """(#filled, #empty) for a usage bar — mirrors curses bar_split."""
    if not isinstance(u, (int, float)):
        return 0, width
    n = int(round(max(0.0, min(1.0, u / 100.0)) * width))
    if u > 0 and n == 0:
        n = 1
    if u < 100 and n >= width:
        n = width - 1
    return n, width - n


def _usage_cell(u, width=6) -> Text:
    """Rich cell for a USED% gauge — same colour law as curses draw_used_bar:
    green plenty → yellow busy (>=70) → red almost gone (>=90)."""
    if not isinstance(u, (int, float)):
        return Text("─" * width + "  —", style="dim")
    nf, ne = _bar_split(u, width)
    col = "red" if u >= 90 else "yellow" if u >= 70 else "green"
    t = Text()
    t.append("█" * nf, style=col)
    t.append("░" * ne, style="dim")
    t.append(f" {u:>3.0f}%", style=col)
    return t


# ----------------------------------------------------------------- the app
class ClaudectlApp(App):
    CSS = """
    #brand { dock: top; height: 1; background: $primary; color: $text; }
    #status { dock: bottom; height: 1; }
    #accounts_summary, #accounts_pinned, #accounts_err { height: 1; }
    DataTable { height: 1fr; }
    #menu_box, #confirm_box, #prompt_box, #info_box {
        width: 80%; max-width: 100; height: auto; max-height: 80%;
        margin: 2 4; padding: 1 2; border: round $accent; background: $panel;
    }
    #info_box VerticalScroll { height: auto; max-height: 20; }
    .desc { color: $text-muted; height: auto; }
    """

    BINDINGS = [
        ("q", "quit", "Quit"),
        ("escape", "quit", "Quit"),
        ("left", "prev_tab", "◀ Tab"),
        ("right", "next_tab", "Tab ▶"),
    ]

    def __init__(self, start_background: bool = True):
        super().__init__()
        self._start_background = start_background
        self._rows: list[dict] = []
        self._err = ""
        self._status = ("ready", "info")
        self._pl_cfg = pp.load()
        self._pl_projects = pp.projects(self._pl_cfg)

    # ---- layout --------------------------------------------------------------
    def compose(self) -> ComposeResult:
        yield Static(id="brand")
        with TabbedContent(initial=self._initial_tab(), id="tabs"):
            with TabPane("Accounts", id="accounts"):
                yield Static(id="accounts_summary")
                yield Static(id="accounts_pinned")
                yield Static(
                    Text("  bars = % USED (green ok · yellow busy · red almost gone)  ·  "
                         "WEEKLY is binding  ·  ★ pinned  ● gateway active", style="dim"))
                yield Static(id="accounts_err")
                yield DataTable(id="accounts_table", cursor_type="row")
                yield Static(Text("─ manage ─", style="dim"))
                yield OptionList(*[it[0] for it in core._POOL_ITEMS], id="pool_actions")
                yield Static("", id="pool_desc", classes="desc")
            with TabPane("Windows", id="windows"):
                yield Static(Text("  Windows — every action hits ALL your running "
                                  "claude/ccc windows", style="dim"))
                yield OptionList(*[it[0] for it in core._WINDOWS_ITEMS], id="windows_actions")
                yield Static("", id="windows_desc", classes="desc")
            with TabPane("Plugins", id="plugins"):
                yield Static(Text("  per-project plugin sets — cut the tool-schema tax",
                                  style="dim"))
                yield Static(id="plugins_note")
                yield DataTable(id="plugins_table", cursor_type="row")
                yield OptionList(*[it[0] for it in core._PLUGIN_POOL], id="plugin_actions")
                yield Static("", id="plugin_desc", classes="desc")
            with TabPane("Setup", id="setup"):
                yield Static(Text("  Setup — maintain the cccc tool on this machine",
                                  style="dim"))
                yield Static(id="setup_status")
                yield OptionList(id="setup_actions")
                yield Static("", id="setup_desc", classes="desc")
        yield Static(id="status")
        yield Footer()

    def _initial_tab(self) -> str:
        want = os.environ.get("CCCC_TAB", "")
        return want if want in ("accounts", "windows", "plugins", "setup") else "accounts"

    def on_mount(self) -> None:
        at = self.query_one("#accounts_table", DataTable)
        at.add_columns("", "ACCOUNT", "ORG", "STATE", "WEEKLY", "WK RESET",
                       "DATE", "5-HOUR", "5H RESET", "BOX")
        pt = self.query_one("#plugins_table", DataTable)
        pt.add_columns("", "PROJECT", "STATE", "#", "PACKS")
        self._rebuild_setup_options()
        self._apply_plugins()
        self.set_status("loading accounts from the router (llm.hostbun.cc)…", "busy")
        self.refresh_data()                                   # worker thread
        self.set_interval(REFRESH_MS / 1000.0, self.refresh_data)
        self.set_interval(1.0, self._refresh_header)
        if self._start_background:
            # reuse the curses module's background workers VERBATIM — they only
            # mutate core globals (_LIVE/_PRES/_VER/_DOC); the header timer reads them.
            threading.Thread(target=core._live_worker, daemon=True).start()
            self._bg_version()
            self._bg_doctor()
        self._refresh_header()

    # ---- background one-shots via Textual worker threads --------------------
    @work(thread=True, group="version")
    def _bg_version(self) -> None:
        core._version_check()
        self.call_from_thread(self._refresh_header)

    @work(thread=True, group="doctor")
    def _bg_doctor(self) -> None:
        core._doctor_check()
        self.call_from_thread(self._refresh_header)

    # ---- data fetch (worker thread) -----------------------------------------
    @work(thread=True, exclusive=True, group="fetch")
    def refresh_data(self) -> None:
        data = core.fetch()
        self.call_from_thread(self._apply_data, data)

    def _apply_data(self, data: dict) -> None:
        self._rows = data.get("rows", [])
        self._err = data.get("err", "")
        table = self.query_one("#accounts_table", DataTable)
        prev = table.cursor_row
        table.clear()
        for r in self._rows:
            name = r["name"]
            lv = core._LIVE.get(name, {})                     # live overlay, same as curses
            usable = lv.get("usable", None)
            u7 = lv["u7"] if lv.get("u7") is not None else r["u7"]
            u5 = lv["u5"] if lv.get("u5") is not None else r["u5"]
            dead = usable is False
            mark = "★" if r.get("local") else ("●" if r["active"] else " ")
            if dead:
                state, scol = "USED UP", "red"
            elif (r["status"] or "") == "error":
                state, scol = "error", "red"
            elif r.get("local"):
                state, scol = "in use", "green"
            elif r["active"]:
                state, scol = "active", "green"
            else:
                state, scol = "ready", "dim"
            o4 = (r.get("org") or "")[:4]
            r7 = (r.get("r7") or "").replace(" ", "") or "—"
            r5 = (r.get("r5") or "").replace(" ", "") or "—"
            machs = r.get("machines") or []
            box = ("⌂" + ",".join(machs)) if machs else ""
            table.add_row(
                Text(mark, style=("red" if dead else "green bold" if r.get("local") else "")),
                Text(name, style=("red" if dead else "green bold" if r.get("local") else "")),
                Text(o4, style="dim"),
                Text(state, style=scol),
                _usage_cell(u7),
                Text(r7, style="dim"),
                Text(r.get("d7") or "", style="dim"),
                _usage_cell(u5),
                Text(r5, style="dim"),
                Text(box, style="cyan"),
            )
        if self._rows:
            try:
                table.move_cursor(row=min(prev, len(self._rows) - 1))
            except Exception:
                pass
        # summary + pinned + error lines
        ok_cap, summ = self._live_summary()
        self.query_one("#accounts_summary", Static).update(
            Text(summ, style=("green" if ok_cap else "red") if core._LIVE else "dim"))
        loc = next((r["name"] for r in self._rows if r.get("local")), None)
        self.query_one("#accounts_pinned", Static).update(
            Text(f"★ PINNED: {loc}   (what `claude`/`ccc` launches as)" if loc
                 else "★ PINNED: (none — ↵ on an account → switch to pin it)",
                 style="green bold" if loc else "yellow"))
        self.query_one("#accounts_err", Static).update(
            Text(f"! {self._err}", style="red") if self._err else "")

    def _live_summary(self):
        """Ground-truth capacity string — mirrors curses live_summary."""
        if not core._LIVE:
            return None, "probing live limits… (Accounts → ⚡ LIVE limit check to force now)"
        uz = [n for n, v in core._LIVE.items() if v.get("usable")]
        dead = [n for n, v in core._LIVE.items() if not v.get("usable")]
        s = f"✅ {len(uz)}/{len(core._LIVE)} usable"
        if dead:
            s += f"  ·  ❌ dead: {', '.join(dead)}"
        return bool(uz), s

    def _apply_plugins(self) -> None:
        note = self.query_one("#plugins_note", Static)
        table = self.query_one("#plugins_table", DataTable)
        table.clear()
        if not self._pl_cfg:
            note.update(Text(f"  plugin-profiles.json not found: {pp.CONFIG_PATH}", style="red"))
            return
        core_n = len(pp.core_ids(self._pl_cfg))
        note.update(Text(f"  core = {core_n} plugins   ● applied  ~ drift  ○ inherits  · not on box",
                         style="dim"))
        for proj in self._pl_projects:
            st = pp.status(self._pl_cfg, proj)
            glyph, col = {"applied": ("●", "green"), "drift": ("~", "yellow"),
                          "inherit": ("○", "dim"), "no-repo": ("·", "dim")}.get(st, ("?", "dim"))
            cnt = len(pp.resolve(self._pl_cfg, proj))
            packs = " ".join(pp.project_packs(self._pl_cfg, proj)) or "core only"
            table.add_row(Text(glyph, style=col), Text(proj, style=col),
                          Text(st, style=col), str(cnt), packs)

    # ---- header + status -----------------------------------------------------
    def _refresh_header(self) -> None:
        host = core.LLM_ADMIN.split("://")[-1]
        t = Text()
        t.append(" claudectl ", style="bold")
        t.append(f"cccc · {host}  ")
        vst = core._VER.get("state", "")
        if vst == "latest":
            t.append(f"✓{core._VER.get('sha', '')} ", style="dim")
        elif vst == "updated":
            t.append("⬆ updated — restart cccc ", style="yellow bold")
        elif vst == "behind":
            t.append(f"⬆ {core._VER.get('behind', '?')} behind — Setup→sync ", style="yellow")
        elif vst == "err":
            t.append("ver? ", style="dim")
        if core._DOC:
            t.append("· doctor✓ " if core._DOC.get("ok")
                     else f"· doctor {core._DOC.get('n') or '?'}✗→Setup ",
                     style="dim" if core._DOC.get("ok") else "yellow")
        rs = core._route_state()
        t.append(f"· {rs[1]} ", style={"ok": "", "warn": "yellow bold",
                                        "err": "red bold", "dim": "dim"}[rs[2]])
        age = f"live {int(time.time() - core._LIVE_AT)}s ago" if core._LIVE_AT else "probing…"
        t.append(("● " if core._LIVE else "◌ ") + age, style="bold" if core._LIVE else "dim")
        try:
            self.query_one("#brand", Static).update(t)
        except Exception:
            pass
        # Setup tab live line
        try:
            v = core._VER.get("state", "checking…")
            dline = ("doctor: checking…" if not core._DOC else
                     "doctor: ✓ all good" if core._DOC.get("ok") else
                     f"doctor: {core._DOC.get('n')}✗ · {core._DOC.get('first', '')}")
            self.query_one("#setup_status", Static).update(
                Text(f"  version: {core._VER.get('sha', '?')} ({v})   ·   {dline}", style="dim"))
        except Exception:
            pass

    def set_status(self, msg: str, kind: str = "info") -> None:
        self._status = (msg, kind)
        icon = {"info": "· ", "busy": "⏳ ", "ok": "✓ ", "err": "✗ "}.get(kind, "")
        color = {"ok": "green bold", "err": "red bold", "busy": "cyan bold", "info": "blue"}.get(kind, "")
        try:
            self.query_one("#status", Static).update(Text(" " + icon + msg, style=color))
        except Exception:
            pass

    def _rebuild_setup_options(self) -> None:
        rs = core._route_state()
        tlabel = ("route: ⚡ DIRECT (bypassing router) — ↵ to route via gateway" if rs[0] == "direct"
                  else "route: ▸ ROUTER (llm.hostbun.cc) — ↵ to force DIRECT bypass")
        self._setup_items = [((tlabel, v, d) if v == "toggle_direct" else (l, v, d))
                             for (l, v, d) in core._SETUP_ITEMS]
        ol = self.query_one("#setup_actions", OptionList)
        ol.clear_options()
        ol.add_options([it[0] for it in self._setup_items])

    # ---- tab navigation ------------------------------------------------------
    def _tab_ids(self):
        return ["accounts", "windows", "plugins", "setup"]

    def action_prev_tab(self) -> None:
        tc = self.query_one("#tabs", TabbedContent)
        ids = self._tab_ids()
        i = ids.index(tc.active) if tc.active in ids else 0
        tc.active = ids[(i - 1) % len(ids)]

    def action_next_tab(self) -> None:
        tc = self.query_one("#tabs", TabbedContent)
        ids = self._tab_ids()
        i = ids.index(tc.active) if tc.active in ids else 0
        tc.active = ids[(i + 1) % len(ids)]

    # ---- description panels on highlight ------------------------------------
    def on_option_list_option_highlighted(self, event: OptionList.OptionHighlighted) -> None:
        oid = event.option_list.id
        i = event.option_index
        mapping = {
            "pool_actions": (core._POOL_ITEMS, "#pool_desc"),
            "windows_actions": (core._WINDOWS_ITEMS, "#windows_desc"),
            "plugin_actions": (core._PLUGIN_POOL, "#plugin_desc"),
        }
        if oid in mapping:
            items, sel = mapping[oid]
            if 0 <= i < len(items):
                self.query_one(sel, Static).update(Text("  " + items[i][2], style="cyan"))
        elif oid == "setup_actions" and 0 <= i < len(self._setup_items):
            self.query_one("#setup_desc", Static).update(
                Text("  " + self._setup_items[i][2], style="cyan"))

    # ---- Enter dispatch: DataTable rows + OptionList selections --------------
    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        if event.data_table.id == "accounts_table":
            i = event.cursor_row
            if 0 <= i < len(self._rows):
                self._enter_account(self._rows[i])
        elif event.data_table.id == "plugins_table":
            i = event.cursor_row
            if 0 <= i < len(self._pl_projects):
                self._enter_plugin(self._pl_projects[i])

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        oid = event.option_list.id
        i = event.option_index
        if oid == "pool_actions":
            self._run(core._POOL_ITEMS[i][1], None)
        elif oid == "windows_actions":
            self._run(core._WINDOWS_ITEMS[i][1], None)
        elif oid == "plugin_actions":
            self._run_plugin_pool(core._PLUGIN_POOL[i][1])
        elif oid == "setup_actions":
            self._run(self._setup_items[i][1], None)

    # ---- worker entry points (async workers so push_screen_wait is allowed) --
    @work
    async def _enter_account(self, cur: dict) -> None:
        action = await self.push_screen_wait(
            MenuScreen(f"account · {cur['name']}", core._ACCOUNT_ITEMS))
        if action:
            await self._do(action, cur)

    @work
    async def _run(self, action: str, cur) -> None:
        await self._do(action, cur)

    @work
    async def _run_plugin_pool(self, act: str) -> None:
        await self._do_plugin_pool(act)

    @work
    async def _enter_plugin(self, proj: str) -> None:
        picked = await self.push_screen_wait(MenuScreen(f"plugins · {proj}", [
            ("apply → write .claude/settings.json", "apply",
             f"Write the full set ({len(pp.resolve(self._pl_cfg, proj))} plugins) into "
             f"{proj}/.claude/settings.json (replaces enabledPlugins, keeps other keys)."),
            ("show full plugin list", "show",
             "List every plugin id this project would enable (core + its packs)."),
        ]))
        if picked == "apply":
            self.set_status(f"writing {proj}/.claude/settings.json…", "busy")
            r = await asyncio.to_thread(pp.apply_project, self._pl_cfg, proj)
            if r.get("ok"):
                self.set_status(f"{proj}: wrote {r.get('count')} plugins → restart claude there", "ok")
            else:
                self.set_status(f"{proj}: {r.get('error')}", "err")
            self._apply_plugins()
        elif picked == "show":
            await self.push_screen_wait(InfoScreen(
                f"{proj} · {len(pp.resolve(self._pl_cfg, proj))} plugins",
                "\n".join(pp.resolve(self._pl_cfg, proj))))

    # ---- modal helpers -------------------------------------------------------
    async def _confirm(self, msg: str) -> bool:
        return bool(await self.push_screen_wait(ConfirmScreen(msg)))

    async def _prompt(self, label: str, secret: bool = False):
        return await self.push_screen_wait(PromptScreen(label, secret))

    async def _external(self, argv) -> None:
        """Suspend the TUI, run a blocking full-screen command, wait for Enter,
        resume — the Textual equivalent of curses _run_external."""
        with self.suspend():
            import subprocess
            try:
                subprocess.run(argv)
                try:
                    input("\n[done] press Enter to return to cccc… ")
                except Exception:
                    pass
            except Exception as e:  # noqa: BLE001
                print(f"command failed: {e}")

    async def _reload_accounts(self) -> None:
        data = await asyncio.to_thread(core.fetch)
        self._apply_data(data)

    # ---- THE action table (mirrors curses dispatch, verbatim logic via core) -
    async def _do(self, action: str, cur) -> None:
        if action == "switch" and cur:
            name = cur["name"]
            self.set_status(f"pinning {name} on the router · all panes, live…", "busy")
            gl = await asyncio.to_thread(core.gateway_set_lock, name)
            if gl.get("ok"):
                was_direct = os.path.exists(core._FORCE_DIRECT_FLAG)
                await asyncio.to_thread(core._set_force_direct, False)
                core._write_local_selected(name)
                await asyncio.to_thread(core.set_consumer_headers, name)
                self.set_status(
                    f"now on {name} via router ✓ live on every gateway pane"
                    + (" · direct-connect turned OFF" if was_direct else " — no restart"), "ok")
            else:
                self.set_status(f"pin FAILED: {gl.get('error', '?')} (is the box routing "
                                f"through the gateway? Setup tab → gateway on)", "err")
            await self._reload_accounts()
        elif action == "switch_direct" and cur:
            name = cur["name"]
            self.set_status(f"switching login to {name} + forcing direct-connect…", "busy")
            r = await asyncio.to_thread(core.switch_direct_local, name)
            if r.get("ok"):
                self.set_status(f"now on {name} DIRECT · login swapped, router bypassed — "
                                f"open a new pane", "ok")
            else:
                self.set_status(f"direct switch failed: {r.get('error', '?')}", "err")
            await self._reload_accounts()
        elif action == "test" and cur:
            name = cur["name"]
            self.set_status(f"live-testing {name} via the router (1 token)…", "busy")
            r = core._asdict(await asyncio.to_thread(
                core._llm_post, "claudecode/limits", {"account": name}, 45))
            rd = core._asdict(r.get("reading"))
            if rd:
                def _used(v):
                    return f"{round(v * 100)}%" if isinstance(v, (int, float)) else "?"
                self.set_status(f"{name}: 5h {_used(rd.get('u5'))} / "
                                f"7d {_used(rd.get('u7'))} used · live ✓", "ok")
                await asyncio.to_thread(core._live_refresh)
            else:
                why = r.get("reason") or r.get("error") or "no reading"
                self.set_status(f"{name}: {why}", "err")
        elif action in ("reveal", "rename", "add"):
            self.set_status("router-managed pool — add / rename accounts (and their tokens) "
                            "in the llm.hostbun.cc panel; cccc pins, it doesn't own them", "info")
        elif action == "delete" and cur:
            name = cur["name"]
            if not await self._confirm(f"delete account '{name}' from the router pool? "
                                       f"IRREVERSIBLE — needs a fresh setup-token to re-add"):
                self.set_status("delete cancelled", "info")
            else:
                self.set_status(f"removing {name} from the pool…", "busy")
                r = await asyncio.to_thread(core._llm_post, "accounts/remove", {"account": name})
                if isinstance(r, dict) and r.get("ok"):
                    self.set_status(f"{name} removed from the pool", "ok")
                else:
                    self.set_status(f"remove failed: {(r or {}).get('error', '?')}", "err")
                await self._reload_accounts()
        elif action == "live_probe":
            n = len(self._rows)
            self.set_status(f"live limit check · router pings every subscription (1 token × {n})…", "busy")
            r = await asyncio.to_thread(core._llm_post, "claudecode/limits", {"all": True}, 120)
            accts = (r or {}).get("accounts") if isinstance(r, dict) else None
            if accts is not None:
                got = sum(1 for a in accts if isinstance(a, dict) and a.get("reading"))
                await asyncio.to_thread(core._live_refresh)
                await self._reload_accounts()
                self.set_status(f"live limits refreshed · fresh reading on {got}/{len(accts)} accounts", "ok")
            else:
                self.set_status(f"live probe failed: {(r or {}).get('error', '?')}", "err")
        elif action == "refresh":
            self.set_status("refreshing accounts from the router…", "busy")
            await self._reload_accounts()
            self.set_status(f"refreshed · {len(self._rows)} accounts", "ok")
        elif action == "version_check":
            self.set_status("checking against origin/master…", "busy")
            res = await asyncio.to_thread(core._version_check, False)
            if res.get("state") == "behind" and await self._confirm(
                    f"{res.get('behind')} commit(s) behind origin — sync now?"):
                self.set_status("syncing (git pull + re-vendor)…", "busy")
                await self._external(["python3", core._SYNC_SCRIPT])
                res = await asyncio.to_thread(core._version_check, False)
            self.set_status("verifying install (install.sh self-check)…", "busy")
            await self._external(["sh", os.path.join(os.path.dirname(core._HERE), "install.sh")])
            self.set_status(f"version {res.get('sha')} · {res.get('state')}"
                            + (" — restart cccc to load it" if res.get("state") == "updated" else ""), "ok")
        elif action == "doctor":
            self.set_status("running doctor…", "busy")
            await self._external(["python3", core._DOCTOR_SCRIPT])
            await asyncio.to_thread(core._doctor_check)
            self._refresh_header()
            self.set_status("doctor done", "ok")
        elif action == "doctor_fix":
            self.set_status("doctor --fix (enabling missing LSP plugins)…", "busy")
            await self._external(["python3", core._DOCTOR_SCRIPT, "--fix"])
            await asyncio.to_thread(core._doctor_check)
            self._refresh_header()
            self.set_status("doctor --fix done"
                            + ("" if core._DOC.get("ok") else f" · {core._DOC.get('n')} issue(s) remain"), "ok")
        elif action == "dock":
            await self._external(["python3", core._DOCK_SCRIPT])
        elif action == "panes":
            await self._external(["python3", core._PANES_SCRIPT])
        elif action == "toggle_direct":
            if os.path.exists(core._FORCE_DIRECT_FLAG):
                await asyncio.to_thread(core._set_force_direct, False)
                self.set_status("route: GATEWAY — direct-connect off · new panes route through llm.hostbun.cc", "ok")
            else:
                await asyncio.to_thread(core._set_force_direct, True)
                self.set_status("route: DIRECT — bypassing router · new panes hit api.anthropic.com", "ok")
            self._rebuild_setup_options()
            self._refresh_header()
        elif action == "sync":
            restart = await self._confirm("sync: git-pull this checkout. also restart ccc panes onto new code?")
            self.set_status("syncing (git pull + re-vendor)…", "busy")
            await self._external(["python3", core._SYNC_SCRIPT] + (["--restart"] if restart else []))
            self.set_status("sync done", "ok")
        elif action == "fleet_restart":
            n = len(await asyncio.to_thread(core._claude_surfaces))
            if await self._confirm(f"restart ALL {n} ccc sessions? kill+resume each → reloads "
                                   f"plugins & current account, interrupts in-flight work"):
                self.set_status(f"restarting {n} pane(s) · reloading plugins + current account…", "busy")
                await self._external(["python3", core._REFRESH_SCRIPT, "--go"])
                self.set_status(f"restarted {n} pane(s) · each resumed on the current account", "ok")
        elif action == "fleet_model":
            mdl = await self._prompt("set model on ALL sessions → ")
            if mdl:
                self.set_status(f"broadcasting /model {mdl} to all running panes…", "busy")
                n = await asyncio.to_thread(core._broadcast, f"/model {mdl}", True)
                self.set_status(f"/model {mdl} sent to {n} pane(s)", "ok")
        elif action == "fleet_effort":
            ef = await self._prompt("set effort on ALL sessions (low/medium/high) → ")
            if ef:
                self.set_status(f"broadcasting /effort {ef} to all running panes…", "busy")
                n = await asyncio.to_thread(core._broadcast, f"/effort {ef}")
                self.set_status(f"/effort {ef} sent to {n} pane(s)", "ok")
        elif action == "fleet_broadcast":
            cmd = await self._prompt("broadcast to ALL sessions → ")
            if cmd:
                self.set_status("broadcasting to all running panes…", "busy")
                n = await asyncio.to_thread(core._broadcast, cmd)
                self.set_status(f"sent to {n} pane(s)", "ok")
        elif action == "fleet_reload_plugins":
            self.set_status("broadcasting /reload-plugins --force to all running panes…", "busy")
            n = await asyncio.to_thread(core._broadcast, "/reload-plugins --force", True)
            self.set_status(f"/reload-plugins --force sent to {n} pane(s)", "ok")
        elif action == "fleet_kill_one":
            self.set_status("finding running claude windows…", "busy")
            wins = await asyncio.to_thread(core._claude_windows)
            if not wins:
                self.set_status("no other running claude windows to kill", "info")
            else:
                items = [(w["label"], w["pid"],
                          f"Stop this claude agent now (pid {w['pid']}, {w['surface'][:8]}). "
                          f"Pane drops to a shell — no resume.") for w in wins]
                pidsel = await self.push_screen_wait(MenuScreen("kill which window?", items))
                if pidsel:
                    w = next(x for x in wins if x["pid"] == pidsel)
                    if await self._confirm(f"kill {w['label']}?  (stops the agent, no resume)"):
                        self.set_status(f"killing pid {pidsel}…", "busy")
                        killed = await asyncio.to_thread(core._kill_window, pidsel)
                        self.set_status(f"killed {w['label']}" if killed
                                        else f"kill failed for pid {pidsel}", "ok" if killed else "err")
        elif action == "fleet_kill_all":
            self.set_status("finding running claude windows…", "busy")
            wins = await asyncio.to_thread(core._claude_windows)
            if not wins:
                self.set_status("no other running claude windows to kill", "info")
            elif await self._confirm(f"KILL all {len(wins)} running claude windows?  "
                                     f"(stops them now, no resume — your own is untouched)"):
                self.set_status(f"killing {len(wins)} window(s)…", "busy")
                n = 0
                for w in wins:
                    n += 1 if await asyncio.to_thread(core._kill_window, w["pid"]) else 0
                self.set_status(f"killed {n}/{len(wins)} window(s) · panes dropped to a shell", "ok")

    async def _do_plugin_pool(self, act: str) -> None:
        if act == "plugin_global":
            if await self._confirm(f"write lean global? (~/.claude/settings.json = "
                                   f"{len(pp.core_ids(self._pl_cfg))} core plugins)"):
                self.set_status("writing lean global settings…", "busy")
                r = await asyncio.to_thread(pp.apply_global_lean, self._pl_cfg)
                self.set_status(f"lean global applied: {r.get('count')} core plugins · restart claude"
                                if r.get("ok") else f"failed: {r.get('error')}",
                                "ok" if r.get("ok") else "err")
        elif act == "plugin_apply_all":
            on_box = [p for p in self._pl_projects if pp.repo_path(p)]
            if await self._confirm(f"write .claude/settings.json into {len(on_box)} repos on this box?"):
                self.set_status(f"applying {len(on_box)} repos…", "busy")
                done = 0
                for p in on_box:
                    r = await asyncio.to_thread(pp.apply_project, self._pl_cfg, p)
                    done += 1 if r.get("ok") else 0
                self.set_status(f"applied {done}/{len(on_box)} repos · restart claude in each", "ok")
            self._apply_plugins()
        elif act == "plugin_reload":
            self._pl_cfg = pp.load()
            self._pl_projects = pp.projects(self._pl_cfg)
            self._apply_plugins()
            self.set_status(f"config reloaded · {len(self._pl_projects)} projects", "ok")


def main() -> int:
    # keep the exact headless subcommand surface of the curses tool: `cccc <sub>`
    # still dispatches through claudectl_tui.main (guard/sync/refresh/doctor/…).
    argv = sys.argv[1:]
    if argv and (argv[0] in ("guard",) or argv[0] in core._SUBCMDS or argv[0] in ("-h", "--help")):
        return core.main()
    ClaudectlApp().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
