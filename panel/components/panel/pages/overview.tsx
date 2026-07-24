"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardAction } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProviderBadge, StatusBadge, ProjectChip, Dot } from "@/components/panel/badges";
import { Stat, StatGrid, PageHead } from "@/components/panel/primitives";
import { Bar } from "@/components/panel/controls";
import { Chart } from "@/components/panel/chart";
import { Seg } from "@/components/panel/seg";
import { useApp } from "@/components/panel/context";
import { api } from "@/lib/api";
import { ago, nfmt, fmtMs, fmtTime, SLOW_MS, WARN, DANGER } from "@/lib/format";

const SEV: Record<string, string> = { down: DANGER, dry: DANGER, err: DANGER, slow: WARN, refusal: WARN, force: WARN, premium: WARN };

function Issues({ health, st, state, pool }: any) {
  const probs: [string, string][] = [];
  ["local", "claudecode", "crazyrouter"].forEach((l) => {
    const r = health[l];
    if (r && !r.up) probs.push(["down", `Provider ${l} is DOWN (status ${r.status || "—"}). Traffic to it will fail.`]);
  });
  if (pool && pool.summary && (pool.orphanPins || []).length)
    probs.push(["err", `${pool.orphanPins.length} project pin(s) name an account that is not in the pool — those calls 403.`]);
  if (st && st.byProvider) {
    st.byProvider.forEach((r: any) => {
      if (r.avg_ms > SLOW_MS) probs.push(["slow", `Provider ${r.provider} is slow — avg ${fmtMs(r.avg_ms)} over the last hour (${r.n} calls).`]);
    });
    if (st.windowJsonFails > 0)
      probs.push(["refusal", `${st.windowJsonFails} JSON-enforce failure(s) in the last hour — usually a prose refusal, surfaced as 422. Not a proxy bug.`]);
    const otherErr = st.windowErrors - (st.windowJsonFails || 0);
    const rate = st.windowCalls > 0 ? otherErr / st.windowCalls : 0;
    if (rate > 0.05 && st.windowCalls >= 20) probs.push(["err", `Non-refusal error rate ${(rate * 100).toFixed(0)}% over the last hour (${otherErr}/${st.windowCalls}).`]);
  }
  if (state.forceModel && state.forceModel.enabled)
    probs.push(["force", `Force-model is ON → every request rewritten to ${state.forceModel.provider}/${state.forceModel.model}.`]);
  // Premium-model usage: an app (deployed code) running opus/fable on the shared Max pool — ~15x haiku's
  // per-token price and the heaviest drain on the shared 5h/7d windows. Devs on opus are expected; apps are the signal.
  (st?.premiumUsage || []).filter((p: any) => p.kind === "app").forEach((p: any) => {
    probs.push(["premium", `App "${p.project}" is using ${p.model} (${p.tier}) — ${nfmt(p.calls)} call(s), ~$${(p.list_usd || 0).toFixed(2)} list. Premium model on the shared Max pool.`]);
  });
  if ((state.unpricedModels || []).length)
    probs.push(["premium", `${state.unpricedModels.length} advertised model(s) have no token cost defined: ${state.unpricedModels.join(", ")}.`]);
  if (!probs.length)
    return (
      <div className="mb-[18px] rounded-xl border border-ok/35 bg-ok/[0.07] px-4 py-3 text-[13px]">
        <b className="text-ok">All healthy</b> <span className="text-muted-foreground">— providers up, no slow providers or elevated errors in the last hour.</span>
      </div>
    );
  const worst = probs.some(([k]) => SEV[k] === DANGER);
  return (
    <div className={"mb-[18px] rounded-xl border px-4 py-3 text-[13px] " + (worst ? "border-danger/40 bg-danger/[0.07]" : "border-warn/35 bg-warn/[0.07]")}>
      <b style={{ color: worst ? "var(--danger)" : "var(--warn)" }}>
        {probs.length} thing{probs.length > 1 ? "s" : ""} to look at
      </b>
      <ul className="mt-2.5 flex flex-col gap-1.5">
        {probs.map(([k, m], i) => (
          <li key={i} className="flex items-baseline gap-2 leading-relaxed">
            <span className="mt-1.5">
              <Dot color={SEV[k] || "var(--muted-foreground)"} />
            </span>
            <span>{m}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Pool({ d }: { d: any }) {
  const { go } = useApp();
  if (!d) return null;
  const accts = d.accounts || [];
  if (!accts.length) return null;
  const bad = (d.orphanPins || []).length;
  const now = d.now || Date.now();
  const resetAt = (sec: number) => {
    if (!sec) return "";
    const dt = new Date(sec * 1000);
    const ms = sec * 1000 - now;
    if (ms <= 0) return "now";
    const t = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const day = dt.toLocaleDateString([], ms < 86400000 ? { weekday: "short" } : { month: "short", day: "numeric" });
    return `${day} ${t}`;
  };
  return (
    <Card className={bad ? "border-danger/50" : ""}>
      <CardHeader>
        <CardTitle>Claude Max pool</CardTitle>
        <CardDescription>
          {accts.length} subscription{accts.length === 1 ? "" : "s"}, {d.advertisedModels} model ids
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => go("identity", "accounts")}>
            Accounts
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>account</TableHead>
              <TableHead>projects</TableHead>
              <TableHead>5h · resets</TableHead>
              <TableHead>7d · resets</TableHead>
              <TableHead>24h</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accts.map((a: any) => (
              <TableRow key={a.name} className="cursor-pointer" onClick={() => go("identity", "accounts")}>
                <TableCell className="font-mono text-[12.5px] font-semibold">{a.name}</TableCell>
                <TableCell className="text-[11.5px] text-muted-foreground">{a.projects.length ? a.projects.join(", ") : "— unused"}</TableCell>
                <TableCell className="min-w-[78px]">
                  <Bar v={a.limits && a.limits.u5} />
                  {a.limits && a.limits.reset5 ? <div className="text-[9.5px] text-muted-foreground">↺ {resetAt(a.limits.reset5)}</div> : null}
                </TableCell>
                <TableCell className="min-w-[78px]">
                  <Bar v={a.limits && a.limits.u7} />
                  {a.limits && a.limits.reset7 ? <div className="text-[9.5px] text-muted-foreground">↺ {resetAt(a.limits.reset7)}</div> : null}
                </TableCell>
                <TableCell className="whitespace-nowrap font-mono text-[12px] text-muted-foreground">
                  {a.usage.calls24h ? nfmt(a.usage.calls24h) + " calls" : "idle"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function Overview() {
  const { state, openCall } = useApp();
  const [health, setHealth] = useState<any>(null);
  const [st1h, setSt1h] = useState<any>(null);
  const [recent, setRecent] = useState<any[] | null>(null);
  const [series, setSeries] = useState<any>(null);
  const [ovWin, setOvWin] = useState("6h");
  const [ovMetric, setOvMetric] = useState("n");
  const [pool, setPool] = useState<any>(null);
  const load = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([api("health"), api("stats?window=1h").catch(() => null)]);
      setHealth(h);
      setSt1h(s);
    } catch {
      /* ignore */
    }
    try {
      setRecent(((await api("calls?limit=18")) as any).rows || []);
    } catch {
      /* ignore */
    }
    try {
      setPool(await api("accounts"));
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    (async () => {
      try {
        setSeries(await api("series?window=" + ovWin + "&by=provider"));
      } catch {
        /* ignore */
      }
    })();
  }, [ovWin]);

  const head = (
    <PageHead
      title="Overview"
      desc="Provider health, the Claude Max pool, and the last hour of traffic."
      actions={
        <Button variant="outline" size="sm" onClick={load}>
          Refresh
        </Button>
      }
    />
  );
  if (!health)
    return (
      <>
        {head}
        <div className="text-muted-foreground">loading…</div>
      </>
    );
  const providerStat: Record<string, any> = {};
  ((st1h && st1h.byProvider) || []).forEach((r: any) => (providerStat[r.provider] = r));
  const providers: [string, string, any][] = [
    ["local", state.bases.local, health.local],
    ["claudecode", state.bases.claudecode, health.claudecode],
    ["crazyrouter", state.bases.crazyrouter, health.crazyrouter],
  ];
  const up = [health.local, health.claudecode, health.crazyrouter].filter((x: any) => x && x.up).length;
  const fm = state.forceModel || {};
  const poolN = (pool && pool.summary && pool.summary.accounts) || (state.claudecodeAccountPool || []).length;
  return (
    <>
      {head}
      <Issues health={health} st={st1h} state={state} pool={pool} />
      <StatGrid>
        <Stat label="Providers up">{up < 3 ? <span className="text-danger">{up} / 3</span> : up + " / 3"}</Stat>
        <Stat label="Pool">{poolN ? `${poolN} account${poolN === 1 ? "" : "s"}` : <span className="text-danger">none</span>}</Stat>
        <Stat label="Force model">{fm.enabled ? <span className="text-warn">{fm.provider}/{fm.model}</span> : "off"}</Stat>
        <Stat label="Cloud policy">{state.cloudPolicy || "open"}</Stat>
        <Stat label="JSON enforce">{state.jsonEnforce ? "ON" : "OFF"}</Stat>
        <Stat label="Config">{state.configPersisted ? "file-backed" : "env defaults"}</Stat>
      </StatGrid>
      <Pool d={pool} />
      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>When calls landed, stacked by provider.</CardDescription>
          <CardAction>
            <div className="flex flex-wrap gap-2">
              <Seg value={ovMetric} onChange={setOvMetric} items={[["n", "Calls"], ["tok", "Tokens"], ["err", "Errors"]]} />
              <Seg value={ovWin} onChange={setOvWin} items={[["15m", "15m"], ["1h", "1h"], ["6h", "6h"], ["24h", "24h"]]} />
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>{series ? <Chart data={series} metric={ovMetric} by="provider" H={200} /> : <span className="text-muted-foreground">loading…</span>}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent calls</CardTitle>
          <CardDescription>Newest first. Click a row to open the full request and reply.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>when</TableHead>
                <TableHead>project</TableHead>
                <TableHead>model</TableHead>
                <TableHead>provider</TableHead>
                <TableHead>status</TableHead>
                <TableHead>lat · tok</TableHead>
                <TableHead>ip</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(recent || []).length ? (
                (recent || []).map((r) => (
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => openCall(r.id)}>
                    <TableCell className="whitespace-nowrap font-mono text-[12px] text-muted-foreground" title={fmtTime(r.ts)}>
                      {ago(r.ts)} ago
                    </TableCell>
                    <TableCell>
                      <ProjectChip p={r.project} />
                    </TableCell>
                    <TableCell className="font-mono text-[12px]">{r.req_model || "-"}</TableCell>
                    <TableCell>
                      <ProviderBadge provider={r.provider} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} error={r.error} />
                    </TableCell>
                    <TableCell className="font-mono text-[12px]">
                      {fmtMs(r.duration_ms)} · {r.total_tokens ?? "—"}t
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground" title={r.ua || ""}>
                      {r.ip || "—"}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="text-[12.5px] text-muted-foreground">
                    Nothing has called the router yet. The first request through <span className="font-mono">/v1</span> shows up here.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Provider health</CardTitle>
          <CardDescription>A live probe of each upstream, next to what it actually served in the last hour.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Probe</TableHead>
                <TableHead>RTT</TableHead>
                <TableHead>Models</TableHead>
                <TableHead>Calls 1h</TableHead>
                <TableHead>Avg</TableHead>
                <TableHead>Err</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map(([provider, base, r]) => {
                const ls = providerStat[provider] || {};
                const slow = ls.avg_ms > SLOW_MS;
                const errd = ls.errors > 0;
                return (
                  <TableRow key={provider}>
                    <TableCell>
                      <ProviderBadge provider={provider} />
                    </TableCell>
                    <TableCell className="font-mono text-[12px] text-muted-foreground">{base}</TableCell>
                    <TableCell>
                      {r.up ? (
                        <Badge variant="outline" className="text-ok border-ok/40">
                          UP {r.status}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-danger border-danger/45">
                          DOWN {r.status || ""}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono">{r.ms}ms</TableCell>
                    <TableCell className="font-mono">{r.count ?? "—"}</TableCell>
                    <TableCell className="font-mono">{ls.n ?? "—"}</TableCell>
                    <TableCell className="font-mono" style={slow ? { color: "var(--warn)", fontWeight: 600 } : undefined}>
                      {fmtMs(ls.avg_ms)}
                    </TableCell>
                    <TableCell className="font-mono" style={errd ? { color: "var(--danger)", fontWeight: 600 } : undefined}>
                      {ls.errors ?? "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
