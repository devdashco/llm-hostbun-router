"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProviderBadge, KindBadge } from "@/components/panel/badges";
import { Stat, StatGrid, PageHead } from "@/components/panel/primitives";
import { Chart } from "@/components/panel/chart";
import { BarList, BarLegend, type BarRow } from "@/components/panel/barlist";
import { Seg } from "@/components/panel/seg";
import { useApp } from "@/components/panel/context";
import { api } from "@/lib/api";
import { nfmt, usd, ago, fmtMs, seriesColor, CACHED_FILL, ACCENT, OK, DANGER } from "@/lib/format";

import { ProjectTable } from "@/components/panel/pages/usage-table";

const WIN_ITEMS: [string, string][] = [
  ["15m", "Last 15 min"], ["1h", "Last hour"], ["6h", "Last 6h"], ["24h", "Last 24h"], ["7d", "Last 7d"], ["30d", "Last 30d"], ["all", "All time"],
];

const KIND_COLOR: Record<string, string> = { dev: ACCENT, app: OK, unregistered: DANGER };

// The bar every consumption card here draws: raw tokens split into the part that COST something and
// the part that was a cache read. Full bar length is the raw number, its coloured head is the burn.
// Ranking on raw tokens is how the fleet's most-cached machine reads as its biggest spender —
// measured 2026-07-29, wmac was #1 by raw tokens (78.2M) and 6x smaller than a bot at 2.8M billable.
function tokenBar(r: any, color: string) {
  const bil = Number(r.billable || 0),
    cac = Number(r.cached || 0),
    tot = bil + cac;
  const pct = tot > 0 ? Math.round((cac / tot) * 100) : 0;
  return {
    segments: [
      { name: "billable", value: bil, color },
      { name: "cache reads", value: cac, color: CACHED_FILL },
    ],
    right: (
      <>
        {nfmt(bil)} <span className="opacity-60">billable · {pct}% cached · {nfmt(r.calls)} calls</span>
      </>
    ),
    title: `${bil.toLocaleString()} billable + ${cac.toLocaleString()} cache-read = ${tot.toLocaleString()} raw tokens over ${(r.calls || 0).toLocaleString()} calls`,
  };
}

export function Usage() {
  const { gotoCalls } = useApp() as any;
  const [win, setWin] = useState("24h");
  const [s, setS] = useState<any>(null);
  const [series, setSeries] = useState<any>(null);
  const [metric, setMetric] = useState("tok");
  const [by, setBy] = useState("provider");
  const [sort, setSort] = useState({ key: "tok", dir: -1 });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [usage, setUsage] = useState<any>(null);
  const load = useCallback(async () => {
    try {
      setS(await api("stats?window=" + encodeURIComponent(win)));
    } catch {
      /* ignore */
    }
  }, [win]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    (async () => {
      try {
        setSeries(await api("series?window=" + encodeURIComponent(win) + "&by=" + by));
      } catch {
        /* ignore */
      }
    })();
  }, [win, by]);
  useEffect(() => {
    const uw = ({ "15m": "1h", "1h": "1h", "6h": "24h", "24h": "24h", "7d": "7d", "30d": "30d", all: "30d" } as any)[win] || "24h";
    (async () => {
      try {
        setUsage(await api("usage?win=" + uw));
      } catch {
        /* ignore */
      }
    })();
  }, [win]);
  return (
    <div className="space-y-4.5">
      <PageHead
        title="Usage"
        desc="Where the tokens went: by provider, project, client and model."
        actions={<Seg value={win} onChange={setWin} items={WIN_ITEMS.map(([v, l]) => [v, l.replace(/^Last /, "")]) as [string, string][]} />}
      />
      {!s ? (
        <div className="text-muted-foreground">loading…</div>
      ) : s.dbReady === false ? (
        <div className="rounded-xl border border-danger/40 bg-danger/10 p-3.5 text-body text-danger">The call DB is unavailable, so there is nothing to summarise.</div>
      ) : (
        <>
          {(() => {
            const inT = s.windowPromptTokens || 0,
              outT = s.windowCompletionTokens || 0,
              tot = s.windowTokens || 0;
            const avg = s.windowCalls > 0 ? Math.round(tot / s.windowCalls) : 0;
            const lbl = (WIN_ITEMS.find((w) => w[0] === s.window) || [])[1] || s.window;
            const cr = s.windowCacheRead || 0,
              cw = s.windowCacheWrite || 0;
            const hit = cr + inT > 0 ? Math.round((cr / (cr + inT)) * 100) : 0;
            return (
              <StatGrid>
                <Stat label={"Tokens (" + lbl + ")"}>{tot.toLocaleString()}</Stat>
                {/* What the traffic actually consumed. A cache read costs ~0.1x and barely moves a
                    Max account's 5h/7d window, so raw tokens overstate the burn by up to ~25x. */}
                <Stat label="Billable (minus cache)">{Math.max(0, tot - cr).toLocaleString()}</Stat>
                <Stat label="In → Out">
                  {nfmt(inT)} <span className="text-muted-foreground">→</span> {nfmt(outT)}
                </Stat>
                <Stat label="Cache hit">{cr || cw ? <span className="text-ok">{hit}%</span> : <span className="text-muted-foreground">—</span>}</Stat>
                <Stat label="Avg / call">{avg.toLocaleString()}</Stat>
                <Stat label="Est. cost">{usd(s.windowCost)}</Stat>
                <Stat label="Calls">{s.windowCalls.toLocaleString()}</Stat>
                <Stat label="Errors">{s.windowErrors || 0}</Stat>
                <Stat label="Total ever">{s.total.toLocaleString()}</Stat>
              </StatGrid>
            );
          })()}
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
              <CardDescription>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Seg value={metric} onChange={setMetric} items={[["tok", "Tokens"], ["bil", "Billable"], ["n", "Calls"], ["err", "Errors"]]} />
                  <Seg value={by} onChange={setBy} items={[["provider", "provider"], ["owner", "developer"], ["consumer", "consumer"], ["project", "job"], ["model", "model"]]} />
                </div>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {series ? <Chart data={series} metric={metric} by={by} H={240} /> : <span className="text-muted-foreground">loading…</span>}
              {/* by=owner charts people only. Say out loud what it left out — a chart that silently
                  drops 90% of the traffic is worse than no chart. */}
              {series && by === "owner" && series.excluded && series.excluded.calls > 0 && (
                <div className="mt-2 text-meta text-muted-foreground">
                  Excludes {series.excluded.calls.toLocaleString()} calls / {nfmt(series.excluded.tokens)} tokens from apps and
                  consumers with no owner — they belong to no person.
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>By developer</CardTitle>
              <CardDescription>
                Every machine a person owns, ranked by <b>billable</b> tokens — raw minus cache reads, which is what
                actually drains a Max account. Machines sit indented under their owner; click one for its calls.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {(() => {
                const owners = (usage && usage.byOwner) || [];
                const cons = (usage && usage.byConsumer) || [];
                const rows: BarRow[] = [];
                owners.forEach((o: any, i: number) => {
                  const c = seriesColor(o.key, i);
                  rows.push({ key: o.key, label: o.key, ...tokenBar(o, c) });
                  // A person with one machine gains nothing from repeating the same bar underneath.
                  const mine = cons.filter((x: any) => x.owner === o.key);
                  if (mine.length > 1)
                    mine.forEach((m: any) =>
                      rows.push({ key: o.key + "/" + m.key, label: m.key, sub: true, onClick: () => gotoCalls({ project: m.key }), ...tokenBar(m, c) }),
                    );
                });
                return (
                  <>
                    <BarList rows={rows} labelWidth={130} empty="No dev traffic, or no dev consumer has an owner yet." />
                    {rows.length > 0 && (
                      <BarLegend
                        items={[
                          ...owners.map((o: any, i: number) => ({ name: o.key, color: seriesColor(o.key, i) })),
                          { name: "cache reads", color: CACHED_FILL, note: "(~0.1× cost)" },
                        ]}
                      />
                    )}
                  </>
                );
              })()}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Share by provider</CardTitle>
              <CardDescription>How much of the window each provider carried. Bars are tokens; calls ride along in the text.</CardDescription>
            </CardHeader>
            <CardContent>
              {(() => {
                const providers = s.byProvider || [];
                const totT = providers.reduce((a: number, r: any) => a + r.tok, 0) || 1;
                return (
                  <BarList
                    rows={providers.map((r: any, i: number): BarRow => ({
                      key: r.provider,
                      label: r.provider,
                      segments: [{ name: r.provider + " tokens", value: r.tok, color: seriesColor(r.provider, i) }],
                      onClick: () => gotoCalls({ provider: r.provider }),
                      title: `${r.provider} — ${(r.tok || 0).toLocaleString()} tokens over ${r.n} calls`,
                      right: (
                        <>
                          {nfmt(r.tok)} tok <span className="opacity-60">({((r.tok / totT) * 100).toFixed(0)}%)</span> · {r.n.toLocaleString()} calls
                        </>
                      ),
                    }))}
                  />
                );
              })()}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>By consumer</CardTitle>
              <CardDescription>
                Jobs (<span className="font-mono">consumer:job</span>) roll up into their consumer — click ▸ to split them out. Click a row to see its calls.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <ProjectTable s={s} sort={sort} setSort={setSort} gotoCalls={gotoCalls} open={open} setOpen={setOpen} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>By client</CardTitle>
              <CardDescription>Who is calling, by user-agent. Click a row to filter the call log.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>client · user-agent</TableHead>
                    <TableHead>calls</TableHead>
                    <TableHead>tokens</TableHead>
                    <TableHead>thinkers</TableHead>
                    <TableHead>IPs</TableHead>
                    <TableHead>providers</TableHead>
                    <TableHead>last</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(s.byClient || []).map((r: any) => (
                    <TableRow key={r.ua} className="cursor-pointer" onClick={() => gotoCalls({ q: r.ua })}>
                      <TableCell className="font-mono text-ui">{r.ua}</TableCell>
                      <TableCell className="font-mono">{r.n}</TableCell>
                      <TableCell className="font-mono">{(r.tok || 0).toLocaleString()}</TableCell>
                      <TableCell className="font-mono" style={r.thinkers > 0 ? { color: "var(--warn)", fontWeight: 600 } : { color: "var(--muted-foreground)" }}>
                        {r.thinkers || 0}
                      </TableCell>
                      <TableCell className="font-mono">{r.ips}</TableCell>
                      <TableCell className="text-meta text-muted-foreground">{String(r.providers || "").split(",").join(" ")}</TableCell>
                      <TableCell className="font-mono text-meta text-muted-foreground">{ago(r.last)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>By model</CardTitle>
              <CardDescription>Estimated cost is crazyrouter only; claudecode is flat-rate.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>requested model</TableHead>
                    <TableHead>provider</TableHead>
                    <TableHead>calls</TableHead>
                    <TableHead>tokens</TableHead>
                    <TableHead>in → out</TableHead>
                    <TableHead>cache↓</TableHead>
                    <TableHead>est $</TableHead>
                    <TableHead>avg</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(s.byModel || []).map((r: any) => {
                    const hit = r.cr + r.ptok > 0 ? Math.round((r.cr / (r.cr + r.ptok)) * 100) : 0;
                    return (
                      <TableRow key={(r.req_model || "-") + r.provider}>
                        <TableCell className="font-mono text-ui">
                          {r.req_model || "-"}
                          {r.sent_models && r.sent_models !== r.req_model && (
                            <span className="text-muted-foreground"> → {r.sent_models}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <ProviderBadge provider={r.provider} />
                        </TableCell>
                        <TableCell className="font-mono">{r.n}</TableCell>
                        <TableCell className="font-mono">{(r.tok || 0).toLocaleString()}</TableCell>
                        <TableCell className="font-mono text-ui text-muted-foreground">
                          {nfmt(r.ptok)} → {nfmt(r.ctok)}
                        </TableCell>
                        <TableCell className="font-mono text-ui">
                          {r.cr > 0 ? (
                            <>
                              <span className="text-ok">{nfmt(r.cr)}</span> <span className="text-muted-foreground">{hit}%</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono">{usd(r.usd)}</TableCell>
                        <TableCell className="font-mono">{fmtMs(r.avg_ms)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>By kind</CardTitle>
              <CardDescription>
                <b>dev</b> = people&apos;s machines · <b>app</b> = deployed code · <b>unregistered</b> = seen in the log, not in the registry.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!usage ? (
                <span className="text-muted-foreground">loading…</span>
              ) : (
                <BarList
                  labelWidth={110}
                  rows={["dev", "app", "unregistered"].map((k): BarRow => {
                    const r = (usage.byKind || []).find((x: any) => x.key === k) || { calls: 0, billable: 0, cached: 0 };
                    return { key: k, label: <KindBadge kind={k} />, ...tokenBar(r, KIND_COLOR[k]) };
                  })}
                />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>By account × kind</CardTitle>
              <CardDescription>
                Is an app starving your Claude Code? One bar per Max account, split by who spent it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {(() => {
                const per = new Map<string, any[]>();
                for (const r of (usage && usage.byAccountKind) || []) {
                  if (!per.has(r.account)) per.set(r.account, []);
                  per.get(r.account)!.push(r);
                }
                const rows: BarRow[] = [...per.entries()]
                  .map(([account, list]) => {
                    const bil = list.reduce((a, x) => a + Number(x.billable || 0), 0);
                    const calls = list.reduce((a, x) => a + x.calls, 0);
                    return {
                      key: account,
                      label: account,
                      segments: ["dev", "app", "unregistered"].map((k) => ({
                        name: k,
                        value: Number((list.find((x) => x.kind === k) || {}).billable || 0),
                        color: KIND_COLOR[k],
                      })),
                      title: list.map((x) => `${x.kind}: ${Number(x.billable || 0).toLocaleString()} billable / ${x.calls} calls`).join("\n"),
                      right: (
                        <>
                          {nfmt(bil)} <span className="opacity-60">billable · {nfmt(calls)} calls</span>
                        </>
                      ),
                      _s: bil,
                    } as BarRow & { _s: number };
                  })
                  .sort((a: any, b: any) => b._s - a._s);
                return (
                  <>
                    <BarList rows={rows} labelWidth={130} empty="No attributed claudecode traffic in this window." />
                    {rows.length > 0 && <BarLegend items={["dev", "app", "unregistered"].map((k) => ({ name: k, color: KIND_COLOR[k] }))} />}
                  </>
                );
              })()}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
