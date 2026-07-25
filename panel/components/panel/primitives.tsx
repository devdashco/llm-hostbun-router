import * as React from "react";
import { cn } from "@/lib/utils";

// KV stat tile (ported from app.css .kv). Label over a large tabular-nums value.
export function Stat({
  label,
  children,
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("bg-card px-4 py-3", className)}>
      <div className="text-meta text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold tabular-nums tracking-tight">
        {children}
      </div>
    </div>
  );
}

// A hairline grid of Stats (ported from app.css .grid) — 1px gaps show the border between cells.
export function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4.5 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-px overflow-hidden rounded-xl border border-border bg-border">
      {children}
    </div>
  );
}

// The one place a page names itself: title, one line of why-it-matters, right-aligned actions.
export function PageHead({
  title,
  desc,
  actions,
}: {
  title: React.ReactNode;
  desc?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {desc && <p className="mt-1 max-w-[72ch] text-body text-muted-foreground">{desc}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
