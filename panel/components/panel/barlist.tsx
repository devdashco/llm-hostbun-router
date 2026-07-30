"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

// Horizontal bar list — the ranked-magnitude form. One row per entity, bars scaled to the LARGEST
// row so the rows are comparable to each other (a per-row 100% scale answers "what is this made of"
// and hides "who is biggest", which is the question every one of these cards is asking).
//
// Replaces three hand-rolled markup blocks in usage.tsx that each re-derived this geometry. Every
// number stays in text ink; the coloured mark beside it carries identity, never the label.

export type BarSeg = { name: string; value: number; color: string };

export type BarRow = {
  key: string;
  label: React.ReactNode;
  segments: BarSeg[];
  right?: React.ReactNode;
  /** indented continuation of the row above (a machine under its owner, a job under its consumer) */
  sub?: boolean;
  onClick?: () => void;
  title?: string;
};

export function BarList({
  rows,
  empty = "No traffic in this window.",
  labelWidth = 150,
  max,
}: {
  rows: BarRow[];
  empty?: React.ReactNode;
  labelWidth?: number;
  /** override the scale — pass the parent list's max to keep two lists comparable */
  max?: number;
}) {
  if (!rows.length) return <span className="text-muted-foreground text-body">{empty}</span>;
  const total = (r: BarRow) => r.segments.reduce((a, s) => a + (s.value || 0), 0);
  const top = max || Math.max(1, ...rows.map(total));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div
          key={r.key}
          title={r.title}
          onClick={r.onClick}
          className={cn("flex items-center gap-3", r.onClick && "cursor-pointer hover:bg-secondary/40 rounded-sm -mx-1 px-1")}
        >
          <span
            className={cn("shrink-0 truncate font-mono text-ui", r.sub ? "pl-4 text-muted-foreground" : "font-semibold")}
            style={{ width: labelWidth }}
          >
            {r.label}
          </span>
          <span
            className={cn(
              "flex flex-1 gap-px overflow-hidden rounded-full bg-secondary",
              r.sub ? "h-1.5" : "h-2.5",
            )}
          >
            {r.segments.map((s) =>
              s.value > 0 ? (
                <span
                  key={s.name}
                  className="block h-full"
                  style={{ width: ((s.value / top) * 100).toFixed(2) + "%", background: s.color }}
                  title={`${s.name}: ${Math.round(s.value).toLocaleString()}`}
                />
              ) : null,
            )}
          </span>
          {/* fixed width, or a row with a shorter value string gets a longer bar than the row above
              it and the bar ends stop being a readable edge */}
          <span className="w-[300px] shrink-0 whitespace-nowrap text-right font-mono text-ui tabular-nums text-muted-foreground">{r.right}</span>
        </div>
      ))}
    </div>
  );
}

// Legend for a BarList. Present whenever a row carries ≥2 segments — identity is never colour alone.
export function BarLegend({ items }: { items: { name: string; color: string; note?: string }[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted-foreground">
      {items.map((l) => (
        <span key={l.name} className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: l.color }} />
          {l.name}
          {l.note && <span className="opacity-70">{l.note}</span>}
        </span>
      ))}
    </div>
  );
}
