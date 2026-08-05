"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Bar } from "@/components/panel/controls";
import { PageHead } from "@/components/panel/primitives";
import { useApp } from "@/components/panel/context";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { nfmt, ago } from "@/lib/format";

// Account mapping (projectAccounts) — one project → one account, forever. Single-pin merge via
// POST /api/pins (never the whole map). Ported from accounts.js Pins.
export function ProjectPins() {
  const { state, reload } = useApp();
  const pins: Record<string, string> = state.projectAccounts || state.consumerAccounts || {};
  const accounts: string[] = (state.claudecodeAccountPool || []).map((a: any) => a.name);
  const [np, setNp] = useState("");
  const [na, setNa] = useState(accounts[0] || "");
  const [busy, setBusy] = useState("");
  async function setPin(project: string, account: string | null) {
    setBusy(project);
    try {
      await api("pins", { method: "POST", body: JSON.stringify({ project, account }) });
      notify(account ? `${project} → ${account}` : `${project} unpinned`);
      reload();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy("");
    }
  }
  async function add() {
    const p = np.trim().toLowerCase();
    if (!p) return notify("project slug required", true);
    if (!na) return notify("pick an account", true);
    await setPin(p, na);
    setNp("");
  }
  const names = Object.keys(pins).sort();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account mapping</CardTitle>
        <CardDescription>Which Max subscription each project is billed to — set it here.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="mb-3.5 text-ui text-muted-foreground">
          <b>This is where a project is bound to an account.</b> One project → one account (no request header can change it); a project
          that is not mapped gets <span className="font-mono">403 no_account_for_project</span> — the gateway never guesses whose Max plan
          to bill.{" "}
          {state.defaultAccount ? (
            <b className="text-danger">
              defaultAccount is set to &quot;{state.defaultAccount}&quot;, so every unmapped or misspelled project silently bills it instead of
              403&apos;ing.
            </b>
          ) : (
            <>
              <span className="font-mono">defaultAccount</span> is empty, which is what keeps the 403 honest.
            </>
          )}
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>project</TableHead>
              <TableHead>→ account</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {names.length ? (
              names.map((p) => (
                <TableRow key={p}>
                  <TableCell className="font-mono font-semibold">{p}</TableCell>
                  <TableCell className="max-w-[220px]">
                    <Select value={pins[p]} onValueChange={(v) => setPin(p, v)} disabled={busy === p}>
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {accounts.map((a) => (
                          <SelectItem key={a} value={a}>
                            {a}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" disabled={busy === p} onClick={() => setPin(p, null)}>
                      Unpin
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={3} className="text-ui text-muted-foreground">
                  Nothing is mapped — every claudecode call is 403&apos;ing.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <Input
            className="min-w-[180px] flex-[2]"
            placeholder="map a project, e.g. promopilot"
            value={np}
            onChange={(e) => setNp(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <Select value={na} onValueChange={setNa}>
            <SelectTrigger className="min-w-[140px] flex-1">
              <SelectValue placeholder="account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={!!busy} onClick={add}>
            Map
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function Accounts() {
  const { state } = useApp();
  const [d, setD] = useState<any>(null);
  const [now, setNow] = useState(0);
  const [off, setOff] = useState(0);
  const [err, setErr] = useState("");
  const [fresh, setFresh] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState("");
  const [confirmRm, setConfirmRm] = useState("");
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newToken, setNewToken] = useState("");
  const load = useCallback(async () => {
    try {
      const r: any = await api("accounts");
      setD(r);
      if (r.now) setOff(r.now - Date.now());
      setErr("");
    } catch (e: any) {
      setErr(e.message || "load failed");
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    setNow(Date.now() + off);
    const t = setInterval(() => setNow(Date.now() + off), 1000);
    return () => clearInterval(t);
  }, [off]);

  async function refreshLimits(name: string | null) {
    setBusy(name || "all");
    try {
      const r: any = await api("claudecode/limits", { method: "POST", body: JSON.stringify(name ? { account: name } : { all: true }) });
      const list = name ? [r] : r.accounts || [];
      const m = { ...fresh };
      list.forEach((x: any) => (m[x.account] = x));
      setFresh(m);
      const nr = list.filter((x: any) => !x.reading).length;
      notify(`live limits: ${list.length - nr}/${list.length} read` + (nr ? ` · ${nr} no reading` : ""), nr > 0 && nr === list.length);
      load();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy("");
    }
  }
  async function addAccount() {
    const name = newName.trim();
    const token = newToken.replace(/\s+/g, ""); // paste often line-wraps the token; it has no spaces
    if (!name) return notify("account name required", true);
    if (!/^sk-ant-oat/.test(token)) return notify("expected a Max setup-token (sk-ant-oat…)", true);
    setBusy("__add");
    try {
      const r: any = await api("accounts/token", { method: "POST", body: JSON.stringify({ account: name, email: newEmail.trim(), token }) });
      notify(r.created ? `added ${r.account}` : `rotated token for ${r.account}`);
      setNewName("");
      setNewEmail("");
      setNewToken("");
      load();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy("");
    }
  }
  async function removeAccount(name: string) {
    setBusy(name);
    setConfirmRm("");
    try {
      const r: any = await api("accounts/remove", { method: "POST", body: JSON.stringify({ name }) });
      notify(`removed ${r.removed}` + (r.droppedPins && r.droppedPins.length ? ` · dropped pins: ${r.droppedPins.join(", ")}` : ""));
      load();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy("");
    }
  }
  const since = (ts: number) => (ts ? ago(ts, now) + " ago" : "never");
  const resetAt = (sec: number) => {
    if (!sec) return "—";
    const dt = new Date(sec * 1000);
    const ms = sec * 1000 - now;
    if (ms <= 0) return "now";
    const time = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const day = dt.toLocaleDateString([], ms < 86400000 ? { weekday: "short" } : { month: "short", day: "numeric" });
    return `${day} ${time}`;
  };
  const resetFull = (sec: number) =>
    sec ? new Date(sec * 1000).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  const countdown = (sec: number) => {
    if (!sec) return "";
    let s = Math.floor(sec - now / 1000);
    if (s <= 0) return "now";
    const dd = Math.floor(s / 86400);
    s -= dd * 86400;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    const p = (n: number) => String(n).padStart(2, "0");
    if (dd > 0) return `${dd}d ${h}h ${p(m)}m`;
    if (h > 0) return `${h}h ${p(m)}m ${p(s)}s`;
    return `${m}m ${p(s)}s`;
  };
  const statusLabel = (st: string) => {
    if (!st || st === "allowed") return null;
    if (st === "allowed_warning") return { t: "warning", c: "var(--warn)" };
    if (st === "rejected" || st === "blocked") return { t: st, c: "var(--danger)" };
    return { t: st, c: "var(--muted-foreground)" };
  };
  const WindowCell = ({ u, resetSec, st }: { u: number; resetSec: number; st: string }) => {
    const sl = statusLabel(st);
    return (
      <>
        <div className="flex items-baseline gap-1.5">
          <div className="min-w-[52px] flex-1">
            <Bar v={u} />
          </div>
          {sl && (
            <span className="text-micro font-semibold" style={{ color: sl.c }}>
              {sl.t}
            </span>
          )}
        </div>
        {resetSec ? (
          <>
            <div className="text-micro text-muted-foreground" title={"resets " + resetFull(resetSec)}>
              ↺ {resetAt(resetSec)}
            </div>
            <div className="font-mono text-micro font-semibold text-p-crazyrouter" title={"resets " + resetFull(resetSec)}>
              in {countdown(resetSec)}
            </div>
          </>
        ) : null}
      </>
    );
  };
  const accts = (d && d.accounts) || [];
  const s = (d && d.summary) || {};
  return (
    <div className="space-y-4.5">
      <PageHead
        title="Accounts"
        desc="The Claude Max pool: how much usage-window headroom is left, and which project spends which subscription."
        actions={
          <Button variant="outline" size="sm" onClick={load}>
            Refresh
          </Button>
        }
      />
      {d && d.orphanPins && d.orphanPins.length ? (
        <div className="rounded-xl border border-danger/40 bg-danger/10 p-3.5 text-body">
          <b className="text-danger">{d.orphanPins.length} pin(s) name an account that is not in the pool</b>
          <div className="mt-1.5 text-muted-foreground">
            Those projects <span className="font-mono">403</span> on every call:{" "}
            {d.orphanPins.map((o: any) => (
              <span key={o.project} className="font-mono">
                {o.project} → {o.account}{" "}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <ProjectPins />
      <Card>
        <CardHeader>
          <CardTitle>Pool</CardTitle>
          <CardDescription>
            {d ? `${s.accounts} subscription${s.accounts === 1 ? "" : "s"} · ${d.advertisedModels} model ids · usage windows + who spends each` : "the Claude Max subscriptions"}
          </CardDescription>
          {/* The pins below are not the whole story when the auto strategy is on: an APP consumer is
              served by whichever usable account resets soonest, so the account a project is pinned to
              is not the account its traffic hits. That state lived only in /api/state and was rendered
              nowhere — an operator reading the pins would have drawn the wrong conclusion about where
              the spend went, which is the one thing this page is for. Devs keep their pins either way. */}
          {state.accountStrategy === "soonest-weekly-reset" ? (
            <div className="mt-1 text-meta text-warn">
              auto account is ON — <b>app</b> consumers are served by the usable subscription whose weekly window
              resets soonest{state.autoAccount ? <> (currently <b className="font-mono">{state.autoAccount}</b>)</> : ", but no weekly reading is available yet, so each pin decides"}.
              Developer pins are never auto-hopped.
            </div>
          ) : null}
          <CardAction>
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => refreshLimits(null)} title="ping each subscription once and read its live 5h/7d usage window">
              {busy === "all" ? "Refreshing…" : "↻ Refresh limits (live)"}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <p className="mb-1.5 text-ui text-muted-foreground">
            The <b>5h</b>/<b>7d</b> bars are the Claude Max usage windows, <b className="text-warn">harvested off real traffic — a floor, not live</b>:
            an idle account keeps its last reading until it serves a call. Hit <b>↻ Refresh limits (live)</b> to read the real windows now.
          </p>
          {err && <p className="text-danger">{err}</p>}
          {!d && <p className="text-ui text-muted-foreground">loading…</p>}
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>account</TableHead>
                  <TableHead>pinned projects</TableHead>
                  <TableHead>5h window</TableHead>
                  <TableHead>7d window</TableHead>
                  <TableHead>usage</TableHead>
                  <TableHead>last 24h</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {accts.map((a: any) => {
                  const fr = fresh[a.name];
                  const l = fr && fr.reading ? { ...fr.reading, status: fr.reading.unified, ts: fr.checkedAt } : a.limits;
                  const live = !!(fr && fr.reading);
                  const liveNo = !!(fr && !fr.reading);
                  return (
                    <TableRow key={a.name} className={live ? "bg-ok/[0.06]" : ""}>
                      <TableCell className="font-mono align-top">
                        <b>{a.name}</b>
                        {/* An account the router will NEVER serve. `disabled` is persistent (set by
                            an operator, or automatically on a 403 permission_error — a cancelled or
                            refunded subscription); `dead` is the runtime ACCT_DEAD set. Both were
                            returned by /api/accounts and rendered nowhere, so a subscription the
                            pool has stopped using looked exactly like an idle one — and a project
                            pinned to it gets 403 no_account_for_project until it is re-pinned. The
                            pool card only warns when EVERY account is out, so a partial outage was
                            invisible on both screens. */}
                        {a.disabled ? (
                          <div className="text-micro text-danger" title="never served — flip with POST /api/accounts/disable after rotating a fresh token; projects pinned here 403 until re-pinned">
                            ✕ disabled
                          </div>
                        ) : a.dead ? (
                          <div className="text-micro text-danger" title="marked dead at runtime after an auth failure — projects pinned here 403 until re-pinned">
                            ✕ dead
                          </div>
                        ) : null}
                        {a.email ? <div className="text-micro text-muted-foreground">{a.email}</div> : null}
                        {/* When the SUBSCRIPTION itself stops — a cancelled or refunded Max plan.
                            Nothing on api.anthropic.com carries a billing date, so this is hand-set
                            (POST /api/accounts/meta) and an account with none is auto-renewing:
                            absent must render as NOTHING here, never as "0 days", or every healthy
                            account joins the row this exists to make findable. Unlike the 5h/7d
                            bars beside it, no reset undoes this — the login is gone on that day. */}
                        {a.endsAt ? (
                          <div
                            className={(a.endsInDays ?? 0) < 0 ? "text-micro text-danger" : (a.endsInDays ?? 99) <= 14 ? "text-micro text-warn" : "text-micro text-muted-foreground"}
                            title="the day this subscription's access stops — no reset brings it back"
                          >
                            {(a.endsInDays ?? 0) < 0 ? `⌛ ended ${a.endsAt}` : `⌛ ends ${a.endsAt} (${a.endsInDays}d)`}
                          </div>
                        ) : null}
                        {a.org ? (
                          <div className="text-micro text-muted-foreground" title={a.org}>
                            {a.org.slice(0, 12)}…
                          </div>
                        ) : (
                          <div className="text-micro text-muted-foreground">org unknown</div>
                        )}
                        {live ? (
                          <div className="text-micro text-ok">● live · {since(fr.checkedAt)}</div>
                        ) : l && l.ts ? (
                          <div className="text-micro text-muted-foreground" title="last reading harvested off real traffic — click ↻ for a live read">
                            as of {since(l.ts)}
                          </div>
                        ) : null}
                        {liveNo && (
                          <div
                            className="text-micro"
                            style={{ color: fr.status === 403 ? "var(--danger)" : "var(--warn)" }}
                            title={fr.errMsg || fr.error || "the account answered but sent no rate-limit headers — usually a 429"}
                          >
                            {fr.status === 403 ? "✕ OAuth disabled" : `live: no reading${fr.status ? ` (${fr.status})` : ""}`}
                            {fr.error ? ` (${fr.error})` : ""}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        {a.projects.length ? (
                          a.projects.map((pr: string) => (
                            <Badge key={pr} variant="outline" className="mr-1 text-ok bg-ok/15 border-transparent">
                              {pr}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-meta text-muted-foreground">— unused</span>
                        )}
                      </TableCell>
                      <TableCell className="min-w-[132px] align-top">
                        {l ? <WindowCell u={l.u5} resetSec={l.reset5} st={l.s5} /> : <span className="text-meta text-muted-foreground">no reading</span>}
                      </TableCell>
                      {/* "no reading", not a blank cell. The 5h column beside this one already says
                          it, but a reader scanning the 7d column alone sees an empty cell among
                          full bars and reads it as nothing-used — and 7d is usually the BINDING
                          window. A null reading must never render like a zero one. */}
                      <TableCell className="min-w-[132px] align-top">
                        {l ? <WindowCell u={l.u7} resetSec={l.reset7} st={l.s7} /> : <span className="text-meta text-muted-foreground">no reading</span>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-ui align-top">
                        {nfmt(a.usage.calls)} calls
                        <br />
                        {/* BILLABLE (total - cache_read) — what actually draws down the Max window.
                            The raw number is ~6x larger on a well-cached consumer and points at the
                            wrong account, right beside the 5h/7d bars that are correct. */}
                        <span className="text-muted-foreground" title={`billable (total − cache reads); raw total ${nfmt(a.usage.tokensRaw || 0)}`}>
                          {nfmt(a.usage.tokens)} tok billable
                        </span>
                        {a.usage.rateLimited > 0 && (
                          <>
                            <br />
                            <span className="text-meta text-danger" title="429s served to callers">
                              {nfmt(a.usage.rateLimited)}× 429
                            </span>
                          </>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-ui align-top">
                        {a.usage.calls24h ? (
                          <>
                            {nfmt(a.usage.calls24h)} calls
                            <br />
                            <span className="text-muted-foreground" title={`billable (total − cache reads); raw total ${nfmt(a.usage.tokensRaw24h || 0)}`}>
                              {nfmt(a.usage.tokens24h)} tok billable
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">idle</span>
                        )}
                        <div className="text-micro text-muted-foreground">{since(a.usage.lastTs)}</div>
                      </TableCell>
                      <TableCell className="w-px whitespace-nowrap align-top">
                        <Button variant="ghost" size="sm" disabled={!!busy} title="refresh this account's live window" onClick={() => refreshLimits(a.name)}>
                          {busy === a.name ? "…" : "↻"}
                        </Button>
                        {confirmRm === a.name ? (
                          <Button variant="ghost" size="sm" disabled={!!busy} className="font-semibold text-danger" onClick={() => removeAccount(a.name)}>
                            Remove?
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" disabled={!!busy} title="remove this account from the pool" onClick={() => setConfirmRm(a.name)}>
                            ✕
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {d && !accts.length ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-ui text-muted-foreground">
                      The account pool is empty — <span className="font-mono">claudecodeAccountPool</span> in <span className="font-mono">/data/config.json</span> holds the tokens.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          <div className="mt-4 border-t pt-4">
            <p className="mb-2 text-ui text-muted-foreground">
              <b>Add a Max subscription.</b> Paste its setup-token (<span className="font-mono">sk-ant-oat…</span>) — same field rotates an
              existing account&apos;s token if the name matches. This token is the <b>only copy</b>; it lands in{" "}
              <span className="font-mono">/data/config.json</span> and is never shown again.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-[130px] flex-1"
                placeholder="account name, e.g. kontaktEmphyx"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <Input
                className="min-w-[150px] flex-1"
                type="email"
                placeholder="email (optional)"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
              <Input
                className="min-w-[240px] flex-[2] font-mono"
                type="password"
                placeholder="sk-ant-oat01-…"
                value={newToken}
                onChange={(e) => setNewToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addAccount()}
              />
              <Button disabled={!!busy} onClick={addAccount}>
                {busy === "__add" ? "Adding…" : "Add account"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
