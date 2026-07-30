"use client";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ago, nfmt, usd, fmtMs } from "@/lib/format";

// The per-consumer table on the Usage tab, and the fold that feeds it: `promopilot:generatetext` and
// `promopilot:l2_metadata` are ONE consumer with two jobs, not two consumers, so the rows are folded
// on the first colon before anything is sorted or totalled. Split out of usage.tsx (511 lines) on
// 2026-07-26 — the page around it renders seven unrelated cards and this is the only part of it with
// logic of its own.
export function foldConsumers(rows: any[]) {
  const map = new Map<string, any>();
  for (const r of rows) {
    const p = r.project || "(none)";
    const i = p.indexOf(":");
    const consumer = i < 0 ? p : p.slice(0, i);
    let g = map.get(consumer);
    if (!g) {
      g = { project: consumer, n: 0, tok: 0, ptok: 0, ctok: 0, cr: 0, cw: 0, usd: 0, errors: 0, last: 0, msSum: 0, prov: new Set<string>(), models: new Map<string, number>(), jobs: [], self: null };
      map.set(consumer, g);
    }
    g.n += r.n || 0; g.tok += r.tok || 0; g.ptok += r.ptok || 0; g.ctok += r.ctok || 0; g.cr += r.cr || 0; g.cw += r.cw || 0;
    g.usd += r.usd || 0; g.errors += r.errors || 0; g.last = Math.max(g.last, r.last || 0); g.msSum += (r.avg_ms || 0) * (r.n || 0);
    String(r.providers || "").split(",").filter(Boolean).forEach((x: string) => g.prov.add(x));
    // `topModels` is per ROW (a consumer and each of its jobs), so it has to be summed the same way
    // the tokens are — a consumer's answer is its jobs' models folded together, not the first row's.
    for (const m of r.topModels || []) if (m && m.m) g.models.set(m.m, (g.models.get(m.m) || 0) + (m.tok || 0));
    if (i < 0) g.self = r;
    else g.jobs.push(r);
  }
  return [...map.values()].map((g) => ({
    ...g,
    // BILLABLE: total minus cache reads — what actually drew down the Max window or the crazyrouter
    // bill. A cached read costs about a tenth, so on a well-cached consumer the raw total overstates
    // spend several-fold. Measured on the pool the same day: 4.6x, 9.5x and 27x on three accounts.
    // The raw number stays, one column over, because it is the right answer to a different question
    // (how much did this consumer PUSH through) — and `cache↓` beside it explains the gap.
    billable: Math.max(0, (g.tok || 0) - (g.cr || 0)),
    avg_ms: g.n ? g.msSum / g.n : null,
    providers: [...g.prov].join(","),
    models: [...g.models.entries()].sort((a, b) => b[1] - a[1]),
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

export function ProjectTable({ s, sort, setSort, gotoCalls, open, setOpen }: any) {
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
    ["project", "consumer"], ["n", "calls"], ["tok", "tokens"], ["billable", "billable"], ["io", "in → out"], ["cr", "cache↓"], ["usd", "est $"], ["avg_ms", "avg"], ["errors", "err%"], [null, "models"], [null, "providers"], ["last", "last seen"], [null, "share"],
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
        <TableCell className="font-mono" title="total minus cache reads — what actually drew down the window">
          {(r.billable || 0).toLocaleString()}
        </TableCell>
        <TableCell className="font-mono text-ui text-muted-foreground">
          {nfmt(r.ptok)} → {nfmt(r.ctok)}
        </TableCell>
        <TableCell className="font-mono text-ui">
          {r.cr > 0 ? <span className="text-ok" title={"cache read " + (r.cr || 0).toLocaleString() + " · write " + (r.cw || 0).toLocaleString() + " tokens"}>{nfmt(r.cr)}</span> : <span className="text-muted-foreground">—</span>}
        </TableCell>
        <TableCell className="font-mono">{usd(r.usd)}</TableCell>
        <TableCell className="font-mono">{fmtMs(r.avg_ms)}</TableCell>
        <TableCell className="font-mono" style={r.errors > 0 ? { color: "var(--danger)", fontWeight: 700 } : { color: "var(--muted-foreground)" }}>
          {errPct.toFixed(errPct && errPct < 10 ? 1 : 0)}%
        </TableCell>
        {/* WHICH models, not how many. `byProject.topModels` has been on /api/stats since it was
            added to answer "is this app on opus" and nothing rendered it — the row said "8 models"
            and an operator still had to open the call log to find out whether any of them was a
            premium one. Token-weighted, so the first name is where the spend actually went. */}
        <TableCell className="text-meta text-muted-foreground">
          {(r.models || []).slice(0, 3).map(([m, tok]: [string, number], i: number) => (
            <span key={m} className={i === 0 ? "text-foreground" : ""} title={`${nfmt(tok)} tokens`}>
              {i ? " · " : ""}{m}
            </span>
          ))}
          {(r.models || []).length > 3 ? <span> +{(r.models || []).length - 3}</span> : null}
        </TableCell>
        <TableCell className="text-meta">{String(r.providers || "").split(",").join(" ")}</TableCell>
        <TableCell className="font-mono text-meta text-muted-foreground">{ago(r.last)}</TableCell>
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
                <TableCell className="whitespace-nowrap font-mono text-ui">
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
                  {expandable && <span className="text-micro text-muted-foreground"> {r.jobs.length} job{r.jobs.length > 1 ? "s" : ""}</span>}
                  <LimitBadge r={r} />
                </TableCell>
                <Cells r={r} share={share} />
              </TableRow>
              {isOpen &&
                r.jobs.map((j: any) => (
                  <TableRow key={j.project} className="cursor-pointer bg-secondary/40" onClick={() => gotoCalls({ project: j.project })}>
                    <TableCell className="whitespace-nowrap pl-8 font-mono text-meta text-muted-foreground">
                      └ {String(j.project).slice(r.project.length + 1)}
                      <LimitBadge r={j} />
                    </TableCell>
                    <Cells r={j} share={null} />
                  </TableRow>
                ))}
              {isOpen && r.self && r.jobs.length ? (
                <TableRow key={r.project + "__self"} className="cursor-pointer bg-secondary/40" onClick={() => gotoCalls({ project: r.self.project + ":" })}>
                  <TableCell className="pl-8 font-mono text-meta text-muted-foreground">└ (no job)</TableCell>
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

