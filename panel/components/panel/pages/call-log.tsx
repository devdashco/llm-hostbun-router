"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProviderBadge, StatusBadge, ProjectChip } from "@/components/panel/badges";
import { ParamBadges, TriSel, FacetSel } from "@/components/panel/controls";
import { PageHead } from "@/components/panel/primitives";
import { useApp } from "@/components/panel/context";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { clone, nfmt, fmtTime } from "@/lib/format";

const CALL_WINDOWS: [string, string][] = [
  ["", "any time"], ["15m", "last 15 min"], ["1h", "last hour"], ["6h", "last 6h"], ["24h", "last 24h"], ["7d", "last 7d"], ["30d", "last 30d"],
];
const WIN_MS: Record<string, number> = { "15m": 9e5, "1h": 36e5, "6h": 216e5, "24h": 864e5, "7d": 6048e5, "30d": 2592e6 };
const EMPTY_FILTERS: any = {
  q: "", model: "", project: "", provider: "", status: "", key: "", effort: "", client: "", stop: "",
  stream: "", thinking: "", tools: "", cached: "", minTok: "", minMs: "", win: "",
};

export function CallLog() {
  const { state, openCall, reload } = useApp();
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [dbReady, setDbReady] = useState(true);
  const [pageSize, setPageSize] = useState(200);
  const [offset, setOffset] = useState(0);
  const [f, setF] = useState<any>({ ...EMPTY_FILTERS });
  const [facets, setFacets] = useState<any>({});
  const [live, setLive] = useState(false);
  const [fresh, setFresh] = useState<Record<number, boolean>>({});
  const [lg, setLg] = useState<any>(() => clone(state.logging));
  const [exporting, setExporting] = useState(false);
  useEffect(() => setLg(clone(state.logging)), [state.logging]);
  useEffect(() => {
    api("calls/facets").then(setFacets).catch(() => {});
  }, []);
  const qs = useCallback(() => {
    const p = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => {
      if (k !== "win" && v && String(v).trim()) p.set(k, String(v).trim());
    });
    if (f.win && WIN_MS[f.win]) p.set("since", String(Date.now() - WIN_MS[f.win]));
    return p;
  }, [f]);
  const load = useCallback(
    async (off = 0) => {
      const p = qs();
      p.set("limit", String(pageSize));
      p.set("offset", String(off));
      try {
        const d: any = await api("calls?" + p.toString());
        setRows(d.rows || []);
        setTotal(d.total || 0);
        setDbReady(d.dbReady !== false);
        setOffset(off);
      } catch {
        /* ignore */
      }
    },
    [qs, pageSize],
  );
  useEffect(() => {
    // Every filter gotoCalls() can be handed must be read back here, or the link navigates and then
    // silently shows an unfiltered log — which reads as "these are the calls you asked for".
    const sp = new URLSearchParams(window.location.search);
    const pick = ["project", "q", "provider", "model", "key", "status"].filter((k) => sp.get(k));
    if (pick.length) setF((x: any) => ({ ...x, ...Object.fromEntries(pick.map((k) => [k, sp.get(k) || ""])) }));
  }, []);
  useEffect(() => {
    load(0);
  }, [load]);
  const topRef = useRef(0);
  useEffect(() => {
    topRef.current = rows.length ? rows[0].id : 0;
  }, [rows]);
  useEffect(() => {
    if (!live || offset !== 0) return;
    let dead = false;
    const tick = async () => {
      if (!topRef.current) {
        load(0);
        return;
      }
      const p = qs();
      p.set("afterId", String(topRef.current));
      p.set("limit", "200");
      try {
        const d: any = await api("calls?" + p.toString());
        if (dead) return;
        const nu = d.rows || [];
        if (!nu.length) return;
        if (nu.length >= 200) {
          load(0);
          return;
        }
        setRows((r) => [...nu, ...r].slice(0, pageSize));
        setTotal((t) => t + nu.length);
        const mark: Record<number, boolean> = {};
        nu.forEach((r: any) => (mark[r.id] = true));
        setFresh((x) => ({ ...x, ...mark }));
        setTimeout(() => {
          if (!dead)
            setFresh((x) => {
              const y = { ...x };
              nu.forEach((r: any) => delete y[r.id]);
              return y;
            });
        }, 4000);
      } catch {
        /* ignore */
      }
    };
    const iv = setInterval(tick, 2500);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, [live, offset, qs, pageSize, load]);
  const upd = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const activeCount = Object.entries(f).filter(([, v]) => v && String(v).trim()).length;
  const A = total ? offset + 1 : 0,
    B = Math.min(offset + rows.length, total),
    lastOff = Math.max(0, (Math.ceil(total / pageSize) - 1) * pageSize);
  const canPrev = offset > 0,
    canNext = offset + pageSize < total;
  async function saveLogging() {
    try {
      const r: any = await api("config", { method: "POST", body: JSON.stringify({ logging: { enabled: lg.enabled, content: lg.content, retain: parseInt(lg.retain || 50000, 10) } }) });
      reload(r.state);
      notify("logging settings saved");
    } catch (e: any) {
      notify(e.message, true);
    }
  }
  async function clearCalls() {
    if (!confirm("Delete ALL logged calls? This cannot be undone.")) return;
    try {
      await api("calls/clear", { method: "POST" });
      notify("call log cleared");
      load(0);
    } catch (e: any) {
      notify(e.message, true);
    }
  }
  async function exportAll() {
    if (exporting) return;
    setExporting(true);
    notify("exporting… paging full call log");
    try {
      let after = 0,
        all: any[] = [],
        guard = 0;
      for (;;) {
        const d: any = await api("export?after=" + after + "&limit=1000");
        const rs = d.rows || [];
        all.push(...rs);
        if (rs.length < 1000) break;
        after = d.maxId;
        if (++guard > 5000) break;
      }
      const blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json" });
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = "llm-hostbun-calls-full.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(u), 1000);
      notify("exported " + all.length.toLocaleString() + " calls (full content)");
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="space-y-4.5">
      <PageHead title="Call log" desc="Every request the router has served, with the prompt and reply behind each row." />
      <Card>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input className="min-w-[220px] flex-[3]" placeholder="search model / ip / ua / prompt / reply…" value={f.q} onChange={(e) => upd("q", e.target.value)} onKeyDown={(e) => e.key === "Enter" && load(0)} />
            <Select value={f.provider || "__any__"} onValueChange={(v) => upd("provider", v === "__any__" ? "" : v)}>
              <SelectTrigger className="h-8 w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__any__">any provider</SelectItem>
                {["local", "crazyrouter", "claudecode", "blocked"].map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={f.status || "__any__"} onValueChange={(v) => upd("status", v === "__any__" ? "" : v)}>
              <SelectTrigger className="h-8 w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__any__">any status</SelectItem>
                <SelectItem value="ok">ok (&lt;400)</SelectItem>
                <SelectItem value="error">error (≥400)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={f.win || "__any__"} onValueChange={(v) => upd("win", v === "__any__" ? "" : v)}>
              <SelectTrigger className="h-8 w-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CALL_WINDOWS.map(([v, l]) => (
                  <SelectItem key={v || "any"} value={v || "__any__"}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" className={live ? "text-ok border-ok/50 bg-ok/[0.14]" : ""} title="poll every 2.5s and prepend new calls (page 1 only)" onClick={() => setLive((x) => !x)}>
              {live ? "● Live" : "Live"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => load(0)}>
              Load
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <FacetSel label="project" items={facets.projects} value={f.project} onChange={(v) => upd("project", v)} extra={[["(none)", "project: (none)"]]} />
            <FacetSel label="model" items={facets.models} value={f.model} onChange={(v) => upd("model", v)} />
            <FacetSel label="account" items={facets.keys} value={f.key} onChange={(v) => upd("key", v)} />
            <FacetSel label="effort" items={facets.efforts} value={f.effort} onChange={(v) => upd("effort", v)} extra={[["(none)", "effort: (none)"]]} />
            <FacetSel label="client" items={facets.clients} value={f.client} onChange={(v) => upd("client", v)} />
            <FacetSel label="stop" items={facets.stops} value={f.stop} onChange={(v) => upd("stop", v)} />
            <TriSel label="stream" value={f.stream} onChange={(v) => upd("stream", v)} />
            <TriSel label="thinking" value={f.thinking} onChange={(v) => upd("thinking", v)} title="thinking_tokens > 0" />
            <TriSel label="tools" value={f.tools} onChange={(v) => upd("tools", v)} title="tool_count > 0" />
            <TriSel label="cached" value={f.cached} onChange={(v) => upd("cached", v)} title="cache_read > 0 — prompt cache hit" />
            <Input className="h-8 w-[90px]" placeholder="min tok" value={f.minTok} onChange={(e) => upd("minTok", e.target.value)} onKeyDown={(e) => e.key === "Enter" && load(0)} />
            <Input className="h-8 w-[90px]" placeholder="min ms" value={f.minMs} onChange={(e) => upd("minMs", e.target.value)} onKeyDown={(e) => e.key === "Enter" && load(0)} />
            {activeCount > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setF({ ...EMPTY_FILTERS })}>
                Clear {activeCount} filter{activeCount > 1 ? "s" : ""}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <small className="text-ui text-muted-foreground">
              {dbReady ? (
                <>
                  Showing <b>{A.toLocaleString()}–{B.toLocaleString()}</b> of <b>{total.toLocaleString()}</b> matching. The DB keeps the newest{" "}
                  {((state.logging && state.logging.retain) || 50000).toLocaleString()} rows; older ones are archived.
                </>
              ) : (
                "call DB unavailable"
              )}
            </small>
            <div className="flex flex-wrap items-center gap-1.5">
              <Select value={String(pageSize)} onValueChange={(v) => setPageSize(+v)}>
                <SelectTrigger className="h-8 w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[100, 200, 500].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} / page
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" disabled={!canPrev} onClick={() => load(0)}>
                First
              </Button>
              <Button variant="outline" size="sm" disabled={!canPrev} onClick={() => load(Math.max(0, offset - pageSize))}>
                Prev
              </Button>
              <Button variant="outline" size="sm" disabled={!canNext} onClick={() => load(offset + pageSize)}>
                Next
              </Button>
              <Button variant="outline" size="sm" disabled={!canNext} onClick={() => load(lastOff)}>
                Last
              </Button>
              <Button variant="outline" size="sm" disabled={exporting} onClick={exportAll} title="download every row with full prompt+reply as JSON">
                {exporting ? "Exporting…" : "Export all"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>time</TableHead>
                <TableHead>project</TableHead>
                <TableHead>model → sent</TableHead>
                <TableHead>provider</TableHead>
                <TableHead>key</TableHead>
                <TableHead>effort</TableHead>
                <TableHead>status</TableHead>
                <TableHead>ms</TableHead>
                <TableHead>in → out</TableHead>
                <TableHead>cache</TableHead>
                <TableHead>tools</TableHead>
                <TableHead>ip / ua</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className={"cursor-pointer" + (fresh[r.id] ? " bg-ok/10" : "")} onClick={() => openCall(r.id)}>
                  <TableCell className="whitespace-nowrap font-mono text-ui text-muted-foreground">{fmtTime(r.ts)}</TableCell>
                  <TableCell>
                    <ProjectChip p={r.project} />
                  </TableCell>
                  <TableCell className="font-mono text-ui">
                    {r.req_model || "-"}
                    {r.sent_model && r.sent_model !== r.req_model && <span className="text-muted-foreground"> → {r.sent_model}</span>}
                    {r.stream ? <span className="text-muted-foreground"> stream</span> : null}
                    <ParamBadges r={r} />
                  </TableCell>
                  <TableCell>
                    <ProviderBadge provider={r.provider} />
                  </TableCell>
                  <TableCell className="font-mono text-ui text-muted-foreground">{r.key_label || ""}</TableCell>
                  <TableCell className="font-mono text-ui">
                    {r.effort ? <span className="text-warn">{r.effort}</span> : <span className="text-muted-foreground">—</span>}
                    {r.thinking_tokens > 0 && (
                      <>
                        <br />
                        <span className="text-meta text-muted-foreground">{nfmt(r.thinking_tokens)} think</span>
                      </>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} error={r.error} />
                  </TableCell>
                  <TableCell className="font-mono">{r.duration_ms ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-ui">
                    {r.prompt_tokens != null || r.completion_tokens != null ? (
                      <>
                        {nfmt(r.prompt_tokens || 0)} <span className="text-muted-foreground">→</span> {nfmt(r.completion_tokens || 0)}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-ui">
                    {r.cache_read > 0 || r.cache_write > 0 ? (
                      <>
                        <span className="text-ok">{nfmt(r.cache_read || 0)}</span> <span className="text-muted-foreground">/ {nfmt(r.cache_write || 0)}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-ui">
                    {r.tool_count > 0 ? (
                      <>
                        {r.tool_count}
                        {r.tools_kb > 0 && <span className="text-muted-foreground"> · {r.tools_kb}KB</span>}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-meta text-muted-foreground">
                    {r.ip || ""}
                    <br />
                    {(r.ua || "").slice(0, 32)}
                  </TableCell>
                </TableRow>
              ))}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={12} className="text-ui text-muted-foreground">
                    No calls match these filters.{activeCount ? " Clear them to see the whole log." : ""}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Logging</CardTitle>
          <CardDescription>
            {!state.loggingDbReady
              ? "No DATABASE_URL — logging is off."
              : state.loggingWrites?.failures
                ? `${state.loggingWrites.failures.toLocaleString()} write${state.loggingWrites.failures === 1 ? " has" : "s have"} failed since boot — the log below is INCOMPLETE.`
                : "Writes are landing. They are fire-and-forget: a failed insert never fails an inference request."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* The old copy read "Postgres is reachable" off `!!pool`, which pg sets without ever
              connecting — so during an outage this card asserted the database was fine while every
              row was dropped, and the empty table below looked like a quiet hour. */}
          {!!state.loggingWrites?.failures && (
            <div className="mb-4 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-ui text-danger">
              last error: {state.loggingWrites.lastError}
              {state.loggingWrites.lastErrorAt ? ` · ${new Date(state.loggingWrites.lastErrorAt).toLocaleString()}` : ""}
            </div>
          )}
          {/* The OTHER delivery path, and the one nobody would notice failing: WARN/ERROR events go
              to HyperDX, which is where an operator sets an alert. A dead ingest or a rotated key
              drops every one of them, and the only symptom is that alerts stop arriving — which
              looks exactly like nothing being wrong. The counter exists so it does not have to. */}
          {!!state.telemetryShip?.failures && (
            <div className="mb-4 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-ui text-warn">
              {state.telemetryShip.failures.toLocaleString()} alert
              {state.telemetryShip.failures === 1 ? "" : "s"} failed to reach HyperDX since boot — WARN/ERROR
              events are not arriving where you would see them. last error: {state.telemetryShip.lastError}
              {state.telemetryShip.lastErrorAt ? ` · ${new Date(state.telemetryShip.lastErrorAt).toLocaleString()}` : ""}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-body">
              <Checkbox checked={!!lg.enabled} onCheckedChange={(v) => setLg({ ...lg, enabled: !!v })} /> log calls
            </label>
            <label className="flex items-center gap-2 text-body">
              <Checkbox checked={!!lg.content} onCheckedChange={(v) => setLg({ ...lg, content: !!v })} /> store prompt + reply content
            </label>
            <div>
              <label className="mb-1 block text-ui text-muted-foreground">retain rows</label>
              <Input type="number" min={100} step={1000} className="w-[130px]" value={lg.retain || 50000} onChange={(e) => setLg({ ...lg, retain: e.target.value })} />
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button onClick={saveLogging}>Save</Button>
            <Button variant="destructive" onClick={clearCalls}>
              Clear log
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
