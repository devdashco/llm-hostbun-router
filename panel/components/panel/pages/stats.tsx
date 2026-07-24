"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProviderBadge, KindBadge } from "@/components/panel/badges";
import { Stat, StatGrid, PageHead } from "@/components/panel/primitives";
import { Chart } from "@/components/panel/chart";
import { Seg } from "@/components/panel/seg";
import { useApp } from "@/components/panel/context";
import { api } from "@/lib/api";
import { nfmt, usd, ago, fmtMs, seriesColor } from "@/lib/format";

const WIN_ITEMS: [string, string][] = [
  ["15m", "Last 15 min"], ["1h", "Last hour"], ["6h", "Last 6h"], ["24h", "Last 24h"], ["7d", "Last 7d"], ["30d", "Last 30d"], ["all", "All time"],
];

function foldConsumers(rows: any[]) {
  const map = new Map<string, any>();
  for (const r of rows) {
    const p = r.project || "(none)";
    const i = p.indexOf(":");
    const consumer = i < 0 ? p : p.slice(0, i);
    let g = map.get(consumer);
    if (!g) {
      g = { project: consumer, n: 0, tok: 0, ptok: 0, ctok: 0, cr: 0, cw: 0, usd: 0, errors: 0, last: 0, msSum: 0, prov: new Set<string>(), jobs: [], self: null };
      map.set(consumer, g);
    }
    g.n += r.n || 0; g.tok += r.tok || 0; g.ptok += r.ptok || 0; g.ctok += r.ctok || 0; g.cr += r.cr || 0; g.cw += r.cw || 0;
    g.usd += r.usd || 0; g.errors += r.errors || 0; g.last = Math.max(g.last, r.last || 0); g.msSum += (r.avg_ms || 0) * (r.n || 0);
    String(r.providers || "").split(",").filter(Boolean).forEach((x: string) => g.prov.add(x));
    if (i < 0) g.self = r;
    else g.jobs.push(r);
  }
  return [...map.values()].map((g) => ({
    ...g,
    avg_ms: g.n ? g.msSum / g.n : null,
    providers: [...g.prov].join(","),
    limit: g.self && g.self.limit,
    limitPct: g.self && g.self.limitPct,
    jobs: g.jobs.sort((a: any, b: any) => (b.tok || 0) - (a.tok || 0)),
  }));
}

function LimitBadge({ r }: { r: any }) {
  if (!(r.limit && r.limitPct != null)) return null;
  const sp = r.limit.slowPct || 95;
  const col = r.limitPct >= 100 ? "var(--danger)" : r.limitPct >= sp ? "var(--warn)" : "var(--ok)";
  const cap = r.limit.tokens > 0 ? nfmt(r.limit.tokens) + " tok" : r.limit.calls > 0 ? r.limit.calls + " calls" : "";
  return (
    <Badge variant="outline" className="ml-1" style={{ color: col, borderColor: col }} title={r.limitPct + "% of " + cap + "/" + r.limit.window + " · at 100%: " + r.limit.hard}>
      {r.limitPct}% {r.limit.hard}
    </Badge>
  );
}

function ProjectTable({ s, sort, setSort, gotoCalls, open, setOpen }: any) {
  const rows = foldConsumers(s.byProject || []);
  const maxT = Math.max(1, ...rows.map((r) => r.tok || 0));
  const k = sort.key,
    dir = sort.dir;
  rows.sort((a, b) => {
    let x: any, y: any;
    if (k === "project") return dir * String(a.project || "").localeCompare(String(b.project || ""));
    if (k === "io") {
      x = a.ptok || 0;
      y = b.ptok || 0;
    } else if (k === "errors") {
      x = a.n ? a.errors / a.n : 0;
      y = b.n ? b.errors / b.n : 0;
    } else {
      x = a[k] || 0;
      y = b[k] || 0;
    }
    return dir * (x > y ? 1 : x < y ? -1 : 0);
  });
  const cols: [string | null, string][] = [
    ["project", "consumer"], ["n", "calls"], ["tok", "tokens"], ["io", "in → out"], ["cr", "cache↓"], ["usd", "est $"], ["avg_ms", "avg"], ["errors", "err%"], [null, "providers"], ["last", "last seen"], [null, "share"],
  ];
  const onSort = (key: string | null) => {
    if (!key) return;
    setSort(sort.key === key ? { key, dir: -sort.dir } : { key, dir: key === "project" ? 1 : -1 });
  };
  const Cells = ({ r, share }: { r: any; share: number | null }) => {
    const errPct = r.n > 0 ? (r.errors / r.n) * 100 : 0;
    return (
      <>
        <TableCell className="font-mono">{r.n}</TableCell>
        <TableCell className="font-mono">{(r.tok || 0).toLocaleString()}</TableCell>
        <TableCell className="font-mono text-[12px] text-muted-foreground">
          {nfmt(r.ptok)} → {nfmt(r.ctok)}
        </TableCell>
        <TableCell className="font-mono text-[12px]">
          {r.cr > 0 ? <span className="text-ok" title={"cache read " + (r.cr || 0).toLocaleString() + " · write " + (r.cw || 0).toLocaleString() + " tokens"}>{nfmt(r.cr)}</span> : <span className="text-muted-foreground">—</span>}
        </TableCell>
        <TableCell className="font-mono">{usd(r.usd)}</TableCell>
        <TableCell className="font-mono">{fmtMs(r.avg_ms)}</TableCell>
        <TableCell className="font-mono" style={r.errors > 0 ? { color: "var(--danger)", fontWeight: 700 } : { color: "var(--muted-foreground)" }}>
          {errPct.toFixed(errPct && errPct < 10 ? 1 : 0)}%
        </TableCell>
        <TableCell className="text-[11px]">{String(r.providers || "").split(",").join(" ")}</TableCell>
        <TableCell className="font-mono text-[11px] text-muted-foreground">{ago(r.last)}</TableCell>
        <TableCell>
          {share == null ? null : (
            <span className="flex h-1.5 overflow-hidden rounded-full bg-secondary">
              <span className="block h-full rounded-full bg-p-crazyrouter" style={{ width: share.toFixed(1) + "%" }} />
            </span>
          )}
        </TableCell>
      </>
    );
  };
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {cols.map(([key, lbl]) => (
            <TableHead key={lbl} className={key ? "cursor-pointer select-none" + (key === k ? " text-foreground" : "") : ""} onClick={() => onSort(key)}>
              {lbl}
              {key === k ? (dir < 0 ? " ▾" : " ▴") : ""}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const share = (r.tok / maxT) * 100;
          const isOpen = !!open[r.project];
          const expandable = r.jobs.length > 0;
          return (
            <>
              <TableRow key={r.project} className="cursor-pointer" onClick={() => gotoCalls({ project: r.project && r.project !== "(none)" ? r.project : "" })}>
                <TableCell className="whitespace-nowrap font-mono text-[12px]">
                  {expandable ? (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen((o: any) => ({ ...o, [r.project]: !o[r.project] }));
                      }}
                      className="inline-block w-4 cursor-pointer text-muted-foreground"
                      title={(isOpen ? "hide" : "show") + " " + r.jobs.length + " job" + (r.jobs.length > 1 ? "s" : "")}
                    >
                      {isOpen ? "▾" : "▸"}
                    </span>
                  ) : (
                    <span className="inline-block w-4" />
                  )}
                  <b>{r.project || "(none)"}</b>
                  {expandable && <span className="text-[10.5px] text-muted-foreground"> {r.jobs.length} job{r.jobs.length > 1 ? "s" : ""}</span>}
                  <LimitBadge r={r} />
                </TableCell>
                <Cells r={r} share={share} />
              </TableRow>
              {isOpen &&
                r.jobs.map((j: any) => (
                  <TableRow key={j.project} className="cursor-pointer bg-secondary/40" onClick={() => gotoCalls({ project: j.project })}>
                    <TableCell className="whitespace-nowrap pl-8 font-mono text-[11.5px] text-muted-foreground">
                      └ {String(j.project).slice(r.project.length + 1)}
                      <LimitBadge r={j} />
                    </TableCell>
                    <Cells r={j} share={null} />
                  </TableRow>
                ))}
              {isOpen && r.self && r.jobs.length ? (
                <TableRow key={r.project + "__self"} className="cursor-pointer bg-secondary/40" onClick={() => gotoCalls({ project: r.self.project + ":" })}>
                  <TableCell className="pl-8 font-mono text-[11.5px] text-muted-foreground">└ (no job)</TableCell>
                  <Cells r={{ ...r.self, cr: r.self.cr || 0, cw: r.self.cw || 0 }} share={null} />
                </TableRow>
              ) : null}
            </>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function Stats() {
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
    <div className="space-y-[18px]">
      <PageHead
        title="Usage"
        desc="Where the tokens went: by provider, project, client and model."
        actions={<Seg value={win} onChange={setWin} items={WIN_ITEMS.map(([v, l]) => [v, l.replace(/^Last /, "")]) as [string, string][]} />}
      />
      {!s ? (
        <div className="text-muted-foreground">loading…</div>
      ) : s.dbReady === false ? (
        <div className="rounded-xl border border-danger/40 bg-danger/10 p-3.5 text-[13px] text-danger">The call DB is unavailable, so there is nothing to summarise.</div>
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
                        <span className="flex w-[150px] shrink-0 items-center gap-1.5 truncate font-mono text-[13px]">
                          <span className="inline-block size-2.5 rounded-sm" style={{ background: c }} />
                          {r.provider}
                        </span>
                        <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                          <span className="block h-full rounded-full" style={{ width: cp.toFixed(1) + "%", background: c }} />
                        </span>
                        <span className="min-w-[170px] text-right font-mono text-[12px] text-muted-foreground">
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
                      <TableCell className="font-mono text-[12px]">{r.ua}</TableCell>
                      <TableCell className="font-mono">{r.n}</TableCell>
                      <TableCell className="font-mono">{(r.tok || 0).toLocaleString()}</TableCell>
                      <TableCell className="font-mono" style={r.thinkers > 0 ? { color: "var(--warn)", fontWeight: 600 } : { color: "var(--muted-foreground)" }}>
                        {r.thinkers || 0}
                      </TableCell>
                      <TableCell className="font-mono">{r.ips}</TableCell>
                      <TableCell className="text-[11.5px] text-muted-foreground">{String(r.providers || "").split(",").join(" ")}</TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">{ago(r.last)}</TableCell>
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
                        <TableCell className="font-mono text-[12px]">
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
                        <TableCell className="font-mono text-[12px] text-muted-foreground">
                          {nfmt(r.ptok)} → {nfmt(r.ctok)}
                        </TableCell>
                        <TableCell className="font-mono text-[12px]">
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
                        <span className="text-[12px] font-normal text-muted-foreground"> tok</span>
                        <div className="mt-0.5 font-mono text-[11.5px] font-normal text-muted-foreground">{nfmt(r.calls)} calls</div>
                      </Stat>
                    );
                  })}
                </StatGrid>
              ) : (
                <span className="text-muted-foreground">loading…</span>
              )}
            </CardContent>
          </Card>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-[18px]">
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
                        <TableCell colSpan={4} className="text-[12.5px] text-muted-foreground">
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
                        <TableCell colSpan={4} className="text-[12.5px] text-muted-foreground">
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
