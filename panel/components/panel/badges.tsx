import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { providerCls } from "@/lib/format";

// Provider identity → token colours (ported from app.css .local/.claudecode/.crazyrouter/.blocked).
const PROVIDER_BADGE: Record<string, string> = {
  local: "text-p-local border-p-local/40",
  claudecode: "text-p-claudecode border-p-claudecode/40",
  crazyrouter: "text-p-crazyrouter border-p-crazyrouter/45",
  down: "text-danger border-danger/45",
  images: "text-violet border-violet/45",
};

export function ProviderBadge({ provider }: { provider?: string }) {
  const cls = providerCls[provider || ""] || "";
  return (
    <Badge variant="outline" className={cn("font-mono", PROVIDER_BADGE[cls])}>
      {provider || "?"}
    </Badge>
  );
}

// A JSON-enforcement refusal is a 4xx the caller provoked, not an outage — it reads amber.
export function StatusBadge({ status, error }: { status: number; error?: string }) {
  const refusal = status >= 400 && /^json_validation_failed/.test(error || "");
  if (refusal)
    return (
      <Badge
        variant="outline"
        title="JSON enforcement refusal — usually a prose answer, not a proxy fault"
        className="text-warn border-warn/40 font-mono"
      >
        {status}
      </Badge>
    );
  if (status >= 400)
    return (
      <Badge variant="outline" className="text-danger border-danger/45 font-mono">
        {status}
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-ok border-ok/40 font-mono">
      {status || "—"}
    </Badge>
  );
}

// Identity path `<consumer>[:<job>]` — consumer carries the weight, the job rides muted. Split on the
// FIRST colon only, same as the router.
export function ProjectChip({ p }: { p?: string }) {
  if (!p) return <span className="text-muted-foreground text-meta">(none)</span>;
  const s = String(p);
  const i = s.indexOf(":");
  if (i < 0)
    return (
      <Badge variant="secondary" className="font-mono text-muted-foreground">
        {s}
      </Badge>
    );
  return (
    <Badge variant="secondary" className="font-mono text-muted-foreground">
      {s.slice(0, i)}
      <span className="opacity-55 font-normal">:{s.slice(i + 1)}</span>
    </Badge>
  );
}

// Consumer kind: dev (a person's machine) / app (deployed code) / unregistered (in the log only).
export function KindBadge({ kind }: { kind: string }) {
  const cls =
    {
      dev: "text-p-crazyrouter bg-p-crazyrouter/15 border-transparent",
      app: "text-ok bg-ok/15 border-transparent",
      unregistered: "text-danger bg-danger/15 border-transparent",
    }[kind] || "text-muted-foreground";
  return (
    <Badge variant="outline" className={cn("font-mono", cls)}>
      {kind}
    </Badge>
  );
}

export function Dot({ color }: { color: string }) {
  return (
    <span className="inline-block size-1.5 rounded-full shrink-0" style={{ background: color }} />
  );
}
