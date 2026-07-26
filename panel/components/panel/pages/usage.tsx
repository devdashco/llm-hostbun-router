"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProviderBadge, KindBadge } from "@/components/panel/badges";
import { Stat, StatGrid, PageHead } from "@/components/panel/primitives";
import { Chart } from "@/components/panel/chart";
import { Seg } from "@/components/panel/seg";
import { useApp } from "@/components/panel/context";
import { api } from "@/lib/api";
import { nfmt, usd, ago, fmtMs, seriesColor } from "@/lib/format";

import { ProjectTable } from "@/components/panel/pages/usage-table";

const WIN_ITEMS: [string, string][] = [
  ["15m", "Last 15 min"], ["1h", "Last hour"], ["6h", "Last 6h"], ["24h", "Last 24h"], ["7d", "Last 7d"], ["30d", "Last 30d"], ["all", "All time"],
];

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
                  <Seg value={metric} onChange={setMetric} items={[["tok", "Tokens"], ["n", "Calls"], ["err", "Errors"]]} />
                  <Seg value={by} onChange={setBy} items={[["provider", "provider"], ["consumer", "consumer"], ["project", "job"], ["model", "model"]]} />
                </div>
              </CardDescription>
            </CardHeader>
            <CardContent>{series ? <Chart data={series} metric={metric} by={by} H={240} /> : <span className="text-muted-foreground">loading…</span>}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Share by provider</CardTitle>
              <CardDescription>What fraction of calls, and of tokens, each provider carried.</CardDescription>
            </CardHeader>
            <CardContent>
              {(() => {
                const providers = s.byProvider || [];
                const totN = providers.reduce((a: number, r: any) => a + r.n, 0) || 1,
                  totT = providers.reduce((a: number, r: any) => a + r.tok, 0) || 1;
                return providers.length ? (
                  providers.map((r: any, i: number) => {
                    const c = seriesColor(r.provider, i),
                      cp = (r.n / totN) * 100,
                      tp = (r.tok / totT) * 100;
                    return (
                      <div key={r.provider} className="my-2.5 flex items-center gap-3">
                        <span className="flex w-[150px] shrink-0 items-center gap-1.5 truncate font-mono text-body">
                          <span className="inline-block size-2.5 rounded-sm" style={{ background: c }} />
                          {r.provider}
                        </span>
                        <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                          <span className="block h-full rounded-full" style={{ width: cp.toFixed(1) + "%", background: c }} />
                        </span>
                        <span className="min-w-[170px] text-right font-mono text-ui text-muted-foreground">
                          {r.n} calls ({cp.toFixed(0)}%) · {nfmt(r.tok)} tok ({tp.toFixed(0)}%)
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <span className="text-muted-foreground">No traffic in this window.</span>
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
              {usage && usage.dbReady !== false ? (
                <StatGrid>
                  {["dev", "app", "unregistered"].map((k) => {
                    const r = (usage.byKind || []).find((x: any) => x.key === k) || { calls: 0, tokens: 0 };
                    return (
                      <Stat key={k} label={<KindBadge kind={k} />}>
                        {nfmt(r.tokens)}
                        <span className="text-ui font-normal text-muted-foreground"> tok</span>
                        <div className="mt-0.5 font-mono text-meta font-normal text-muted-foreground">{nfmt(r.calls)} calls</div>
                      </Stat>
                    );
                  })}
                </StatGrid>
              ) : (
                <span className="text-muted-foreground">loading…</span>
              )}
            </CardContent>
          </Card>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4.5">
            <Card>
              <CardHeader>
                <CardTitle>By developer</CardTitle>
                <CardDescription>Every machine a person owns, summed.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>owner</TableHead>
                      <TableHead>calls</TableHead>
                      <TableHead>tokens</TableHead>
                      <TableHead>err</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {((usage && usage.byOwner) || []).length ? (
                      usage.byOwner.map((o: any) => (
                        <TableRow key={o.key}>
                          <TableCell className="font-mono font-semibold">{o.key}</TableCell>
                          <TableCell className="font-mono">{nfmt(o.calls)}</TableCell>
                          <TableCell className="font-mono">{nfmt(o.tokens)}</TableCell>
                          <TableCell className={"font-mono " + (o.errors ? "text-danger" : "text-muted-foreground")}>{o.errors}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={4} className="text-ui text-muted-foreground">
                          No dev traffic, or no dev consumer has an owner yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>By account × kind</CardTitle>
                <CardDescription>Is an app starving your Claude Code?</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>account</TableHead>
                      <TableHead>kind</TableHead>
                      <TableHead>calls</TableHead>
                      <TableHead>tokens</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {((usage && usage.byAccountKind) || []).length ? (
                      usage.byAccountKind.map((r: any) => (
                        <TableRow key={r.account + r.kind}>
                          <TableCell className="font-mono font-semibold">{r.account}</TableCell>
                          <TableCell>
                            <KindBadge kind={r.kind} />
                          </TableCell>
                          <TableCell className="font-mono">{nfmt(r.calls)}</TableCell>
                          <TableCell className="font-mono">{nfmt(r.tokens)}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={4} className="text-ui text-muted-foreground">
                          No attributed claudecode traffic in this window.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
