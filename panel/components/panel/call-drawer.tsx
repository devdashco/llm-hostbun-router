"use client";
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ProviderBadge, StatusBadge } from "@/components/panel/badges";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { nfmt, fmtMs, fmtTime } from "@/lib/format";

// The ONE detail view for a call — a right side-over (shadcn Sheet). Opening any call row anywhere
// sets `id` via context; the drawer then GETs /api/call?id=. Ported from admin/ui/drawer.js.
function Meta({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <div className="bg-sunken px-3 py-2">
      <div className="text-micro text-muted-foreground">{n}</div>
      <div className="mt-0.5 font-mono text-body">{children}</div>
    </div>
  );
}

function MsgBox({ children, danger }: { children: React.ReactNode; danger?: boolean }) {
  return (
    <div
      className={
        "max-h-[42vh] overflow-auto rounded-lg border bg-sunken px-3.5 py-3 font-mono text-ui leading-relaxed break-words whitespace-pre-wrap " +
        (danger ? "border-danger/35 text-danger" : "border-border")
      }
    >
      {children}
    </div>
  );
}

export function CallDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const [c, setC] = useState<any>(null);
  useEffect(() => {
    if (id == null) {
      setC(null);
      return;
    }
    setC("loading");
    (async () => {
      try {
        setC(await api("call?id=" + id));
      } catch (e: any) {
        setC({ error: e.message });
      }
    })();
  }, [id]);

  const open = id != null;
  const copy = () => {
    if (c && typeof c === "object" && !c.error)
      navigator.clipboard.writeText(JSON.stringify(c, null, 2)).then(() => notify("copied call JSON"));
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[min(720px,96vw)] sm:max-w-none gap-0 p-0">
        <SheetHeader className="flex-row items-center gap-2 border-b border-border p-4">
          <SheetTitle className="flex items-center gap-2 text-base font-semibold">
            {c && c.id ? (
              <>
                <span>Call #{c.id}</span>
                <StatusBadge status={c.status} error={c.error} />
                <ProviderBadge provider={c.provider} />
              </>
            ) : (
              "Call"
            )}
          </SheetTitle>
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={copy}>
            Copy JSON
          </Button>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-4">
          {c == null || c === "loading" ? (
            <span className="text-muted-foreground">{c === "loading" ? "loading…" : ""}</span>
          ) : c.error ? (
            <span className="text-danger">error: {c.error}</span>
          ) : (
            <>
              <div className="mb-4.5 grid grid-cols-[repeat(auto-fit,minmax(128px,1fr))] gap-px overflow-hidden rounded-lg border border-border bg-border">
                <Meta n="when">{fmtTime(c.ts)}</Meta>
                <Meta n="project">{c.project || "(none)"}</Meta>
                <Meta n="model">
                  {c.req_model || "-"}
                  {c.sent_model && c.sent_model !== c.req_model && (
                    <span className="text-muted-foreground"> → {c.sent_model}</span>
                  )}
                </Meta>
                <Meta n="key">{c.key_label || "—"}</Meta>
                <Meta n="latency">{fmtMs(c.duration_ms)}</Meta>
                <Meta n="stream">{c.stream ? "yes" : "no"}</Meta>
                <Meta n="tokens">
                  {c.prompt_tokens ?? "?"} → {c.completion_tokens ?? "?"}{" "}
                  <span className="text-muted-foreground">({c.total_tokens ?? "?"})</span>
                </Meta>
                <Meta n="effort">
                  {c.effort ? <span className="text-warn">{c.effort}</span> : "—"}
                </Meta>
                <Meta n="thinking">
                  {c.thinking_tokens == null ? (
                    "—"
                  ) : c.thinking_tokens === 0 ? (
                    "off"
                  ) : (
                    <span className="text-p-crazyrouter">{nfmt(c.thinking_tokens)} tok</span>
                  )}
                </Meta>
                <Meta n="max tokens">{c.max_tokens ? nfmt(c.max_tokens) : "—"}</Meta>
                <Meta n="temperature">{c.temperature == null ? "—" : c.temperature}</Meta>
                <Meta n="ip">{c.ip || "—"}</Meta>
              </div>
              {c.error && (
                <div className="mb-4.5">
                  <div className="mb-2 text-meta font-semibold uppercase tracking-wide text-danger">
                    error
                  </div>
                  <MsgBox danger>{c.error}</MsgBox>
                </div>
              )}
              <div className="mb-4.5">
                <div className="mb-2 text-meta font-semibold uppercase tracking-wide text-muted-foreground">
                  prompt
                </div>
                <MsgBox>{c.req_content || "(not stored)"}</MsgBox>
              </div>
              <div className="mb-4.5">
                <div className="mb-2 text-meta font-semibold uppercase tracking-wide text-muted-foreground">
                  reply
                </div>
                <MsgBox>{c.resp_content || "(not stored)"}</MsgBox>
              </div>
              {c.ua && (
                <div>
                  <div className="mb-2 text-meta font-semibold uppercase tracking-wide text-muted-foreground">
                    client · user-agent
                  </div>
                  <MsgBox>{c.ua}</MsgBox>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
