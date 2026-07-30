"use client";
import { useMemo } from "react";
import { nfmt, fmtTime, seriesColor, GRID, AXIS, DANGER } from "@/lib/format";

// Stacked-bar time chart — a faithful port of admin/ui/core.js buildChart. Builds an SVG string and
// renders it via dangerouslySetInnerHTML (same as the old panel); pure math, no charting dep.
const METRIC_LABEL: Record<string, string> = { tok: "tokens", bil: "billable tokens", n: "calls", err: "errors" };

function buildChart(d: any, metric: string, opts: { by?: string; H?: number }) {
  const pts = d.points || [];
  const series = d.series || [];
  const H = opts.H || 240;
  const bm = d.bucketMs;
  const bl = bm >= 86400000 ? bm / 86400000 + "d" : bm >= 3600000 ? bm / 3600000 + "h" : bm / 60000 + "min";
  const hint = `— ${METRIC_LABEL[metric]} per ${bl} bucket${opts.by ? ", " + opts.by : ""}`;
  if (!pts.length) return { svg: '<span style="color:var(--muted-foreground)">no data in window</span>', hint, legend: [] as any[] };
  const W = Math.max(560, pts.length * 16 + 60);
  const padL = 52,
    padB = 22,
    padT = 10,
    plotH = H - padB - padT,
    plotW = W - padL - 10;
  const field = metric === "tok" ? "tok" : metric === "bil" ? "bil" : "n";
  const stackVal = (p: any, name: string) => (metric === "err" ? (name === "__err" ? p.totalErr : 0) : p[field][name] || 0);
  const useSeries = metric === "err" ? ["__err"] : series;
  const totals = pts.map((p: any) => useSeries.reduce((a: number, nm: string) => a + stackVal(p, nm), 0));
  const maxV = Math.max(1, ...totals);
  const bw = Math.max(4, Math.min(26, plotW / pts.length - 3));
  const x = (i: number) => padL + i * (plotW / pts.length) + (plotW / pts.length - bw) / 2;
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const yy = padT + plotH - (i / 4) * plotH;
    const vv = (maxV * i) / 4;
    g += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - 10}" y2="${yy.toFixed(1)}" stroke="${GRID}"/><text x="${padL - 6}" y="${(yy + 3).toFixed(1)}" fill="${AXIS}" font-size="10" text-anchor="end">${nfmt(vv)}</text>`;
  }
  let bars = "";
  pts.forEach((p: any, i: number) => {
    let yacc = padT + plotH;
    useSeries.forEach((nm: string) => {
      const v = stackVal(p, nm);
      if (v <= 0) return;
      const hh = (v / maxV) * plotH;
      yacc -= hh;
      const c = metric === "err" ? DANGER : seriesColor(nm, series.indexOf(nm));
      bars += `<rect x="${x(i).toFixed(1)}" y="${yacc.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" fill="${c}" rx="2"><title>${fmtTime(p.t)}\n${nm === "__err" ? "errors" : nm}: ${v.toLocaleString()}</title></rect>`;
    });
  });
  let xl = "";
  const step = Math.max(1, Math.ceil(pts.length / 6));
  pts.forEach((p: any, i: number) => {
    if (i % step) return;
    const t = new Date(p.t);
    const lab = bm < 3600000 ? t.toISOString().slice(11, 16) : t.toISOString().slice(5, 16).replace("T", " ");
    xl += `<text x="${(x(i) + bw / 2).toFixed(1)}" y="${H - 6}" fill="${AXIS}" font-size="10" text-anchor="middle">${lab}</text>`;
  });
  const svg = `<svg width="${W}" height="${H}" style="max-width:none">${g}${bars}${xl}</svg>`;
  const legend =
    metric === "err"
      ? [{ name: "errors", color: DANGER }]
      : series.map((nm: string, i: number) => ({ name: nm, color: seriesColor(nm, i) }));
  return { svg, hint, legend };
}

export function Chart({ data, metric, by, H }: { data: any; metric: string; by?: string; H?: number }) {
  const { svg, hint, legend } = useMemo(() => buildChart(data, metric, { by, H }), [data, metric, by, H]);
  return (
    <div>
      <div className="overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {legend.map((l: any) => (
          <span key={l.name} className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: l.color }} />
            {l.name}
          </span>
        ))}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}
