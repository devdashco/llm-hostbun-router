"use client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { nfmt } from "@/lib/format";

// Headroom bar. `null` is NOT 0% — it means nothing has been harvested (drawing empty would read as
// "plenty left"). Ported from accounts.js Bar.
export function Bar({ v }: { v: number | null | undefined }) {
  if (v == null) return <div className="text-meta text-muted-foreground">no reading</div>;
  const p = Math.max(0, Math.min(100, Math.round(v * 100)));
  const c = p >= 90 ? "var(--danger)" : p >= 70 ? "var(--warn)" : "var(--ok)";
  return (
    <div title={p + "% used"}>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-secondary">
        <span className="block h-full rounded-full" style={{ width: p + "%", background: c }} />
      </div>
      <div className="mt-[3px] font-mono text-meta" style={{ color: c }}>
        {p}%
      </div>
    </div>
  );
}

// Per-call request param chips. Labelled, not pictographic. Ported from core.js ParamBadges.
export function ParamBadges({ r }: { r: any }) {
  const b: React.ReactNode[] = [];
  const chip = (key: string, cls: string, title: string, node: React.ReactNode) => (
    <Badge key={key} variant="outline" className={cls} title={title}>
      {node}
    </Badge>
  );
  if (r.effort) b.push(chip("eff", "text-warn border-warn/40", "reasoning effort", <>effort {r.effort}</>));
  if (r.thinking_tokens > 0)
    b.push(chip("th", "text-p-crazyrouter border-p-crazyrouter/45", "extended thinking budget (tokens)", <>think {nfmt(r.thinking_tokens)}</>));
  else if (r.thinking_tokens === 0) b.push(chip("tho", "text-muted-foreground", "thinking explicitly disabled", <>think off</>));
  if (r.tool_count > 0)
    b.push(
      chip("tools", "text-muted-foreground", (r.tool_servers || "") + " · " + (r.tools_kb || 0) + "KB of tool schema", (
        <>
          tools {r.tool_count}
          {r.mcp_tools > 0 ? ` (${r.mcp_tools} mcp)` : ""}
        </>
      )),
    );
  if (r.cache_read > 0) b.push(chip("cr", "text-ok border-ok/40", "prompt-cache read (tokens) — billed at 10%", <>cache↓ {nfmt(r.cache_read)}</>));
  if (r.cache_write > 0) b.push(chip("cw", "text-muted-foreground", "prompt-cache write (tokens) — billed at 125%", <>cache↑ {nfmt(r.cache_write)}</>));
  if (r.max_tokens > 0) b.push(chip("mt", "text-muted-foreground", "max_tokens", <>≤{nfmt(r.max_tokens)}</>));
  if (r.temperature != null) b.push(chip("t", "text-muted-foreground", "temperature", <>t={r.temperature}</>));
  if (r.stop_reason && r.stop_reason !== "end_turn" && r.stop_reason !== "stop")
    b.push(chip("sr", "text-warn border-warn/40", "stop reason", <>{r.stop_reason}</>));
  if (!b.length) return null;
  return <span className="ml-1.5 inline-flex flex-wrap gap-1">{b}</span>;
}

// Tri-state facet select: '' = any, '1' = yes, '0' = no.
export function TriSel({ label, value, onChange, title }: { label: string; value: string; onChange: (v: string) => void; title?: string }) {
  return (
    <Select value={value || "__any__"} onValueChange={(v) => onChange(v === "__any__" ? "" : v)}>
      <SelectTrigger className="h-8 w-auto" title={title || label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__any__">{label}: any</SelectItem>
        <SelectItem value="1">{label}: yes</SelectItem>
        <SelectItem value="0">{label}: no</SelectItem>
      </SelectContent>
    </Select>
  );
}

// Dropdown seeded from /calls/facets — each option carries its row count.
export function FacetSel({
  label,
  items,
  value,
  onChange,
  extra,
}: {
  label: string;
  items?: { v: string; n: number }[];
  value: string;
  onChange: (v: string) => void;
  extra?: [string, string][];
}) {
  return (
    <Select value={value || "__any__"} onValueChange={(v) => onChange(v === "__any__" ? "" : v)}>
      <SelectTrigger className="h-8 w-auto max-w-[190px]" title={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__any__">{label}: any</SelectItem>
        {(extra || []).map(([v, l]) => (
          <SelectItem key={v} value={v}>
            {l}
          </SelectItem>
        ))}
        {(items || []).map((f) => (
          <SelectItem key={f.v} value={f.v}>
            {f.v} ({nfmt(f.n)})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
