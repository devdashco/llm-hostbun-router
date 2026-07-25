"use client";
import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ProviderBadge } from "@/components/panel/badges";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { clone } from "@/lib/format";
import { PROVS } from "@/components/panel/pages/rules-controls";

// The collapsed half of the Rules page: the resolve tracer, the provider base URLs, the local model
// map and the force-model override. Split out of rules.tsx (934 lines) on 2026-07-26 — it sits
// behind one disclosure, nothing else imports it, and it was a third of the file.
// Resolve/trace, model overrides, crazyrouter policy, local aliases, base URLs, JSON enforcement,
// reset. Collapsed by default.
export function RoutingAdvanced({ d, set, reload, state }: any) {
  const [openAdv, setOpenAdv] = useState(false);
  const [resIn, setResIn] = useState("");
  const [resProj, setResProj] = useState("");
  const [resolveOut, setResolveOut] = useState<string | null>(null);
  const [nr, setNr] = useState({ in: "", provider: "claudecode", model: "" });
  const [na, setNa] = useState({ alias: "", target: "" });
  const stg = state.knownLocalIds || {};

  async function doResolve() {
    setResolveOut("…");
    try {
      const r: any = await api("resolve", { method: "POST", body: JSON.stringify({ model: resIn.trim(), project: resProj.trim() }) });
      setResolveOut(
        (r.blocked
          ? `❌ BLOCKED — ${r.why}\n`
          : `✅ ${r.input || "(empty)"}${r.project ? "  [project=" + r.project + "]" : ""}  →  provider=${r.provider}  model=${r.sentModel}${r.gated ? "  🔒gated" : ""}\n`) +
          `reason: ${r.reason}\nupstream: ${r.base}`,
      );
    } catch (e: any) {
      setResolveOut("error: " + e.message);
    }
  }
  async function resetCfg() {
    if (!confirm("Reset all routing/secrets to env defaults? This deletes the saved config file.")) return;
    try {
      const r: any = await api("reset", { method: "POST" });
      reload(r.state);
      notify("reset to env defaults");
    } catch (e: any) {
      notify(e.message, true);
    }
  }

  if (!openAdv)
    return (
      <button className="flex items-center gap-2 py-2 text-body font-medium text-muted-foreground hover:text-foreground" onClick={() => setOpenAdv(true)}>
        ▸ Advanced routing and config
      </button>
    );

  return (
    <div className="space-y-4.5">
      <button className="flex items-center gap-2 py-2 text-body font-medium text-foreground" onClick={() => setOpenAdv(false)}>
        ▾ Advanced routing and config
      </button>

      <Card>
        <CardHeader>
          <CardTitle>Resolve / trace</CardTitle>
          <CardDescription>See where a model id goes, without calling it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input className="min-w-[200px] flex-[2]" placeholder="model name e.g. deepseek-v3" value={resIn} onChange={(e) => setResIn(e.target.value)} />
            <Input className="min-w-[140px] flex-1" placeholder="project (optional)" value={resProj} onChange={(e) => setResProj(e.target.value)} />
            <Button variant="outline" onClick={doResolve}>
              Trace
            </Button>
          </div>
          {resolveOut != null && (
            <pre className="max-h-[340px] overflow-auto rounded-lg border border-border bg-sunken p-3.5 font-mono text-ui leading-relaxed whitespace-pre-wrap break-words">
              {resolveOut}
            </pre>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Model overrides</CardTitle>
          <CardDescription>Force a specific incoming model id to any provider and model.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Incoming model</TableHead>
                <TableHead>→ provider</TableHead>
                <TableHead>→ sent model</TableHead>
                <TableHead className="w-9" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(d.modelRoutes || {}).map(([k, v]: any) => (
                <TableRow key={k}>
                  <TableCell className="font-mono">{k}</TableCell>
                  <TableCell>
                    <ProviderBadge provider={v.provider} />
                  </TableCell>
                  <TableCell className="font-mono">{v.model || "(unchanged)"}</TableCell>
                  <TableCell>
                    <button
                      className="text-muted-foreground hover:text-danger"
                      onClick={() => {
                        const mr = clone(d.modelRoutes);
                        delete mr[k];
                        set("modelRoutes", mr);
                      }}
                    >
                      ✕
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input className="min-w-[180px]" placeholder="incoming e.g. deepseek-v3" value={nr.in} onChange={(e) => setNr({ ...nr, in: e.target.value })} />
            <Select value={nr.provider} onValueChange={(v) => setNr({ ...nr, provider: v })}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input className="min-w-[180px]" placeholder="sent model id" value={nr.model} onChange={(e) => setNr({ ...nr, model: e.target.value })} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const k = nr.in.trim().toLowerCase();
                if (!k) return notify("incoming model required", true);
                const mr = clone(d.modelRoutes);
                mr[k] = { provider: nr.provider, model: nr.model.trim() };
                set("modelRoutes", mr);
                setNr({ in: "", provider: nr.provider, model: "" });
              }}
            >
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Crazyrouter policy</CardTitle>
          <CardDescription>The only provider that bills per token.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-4.5">
            {["open", "allowlist", "off"].map((v) => (
              <label key={v} className="flex items-center gap-2 text-body">
                <input type="radio" name="cp" checked={d.cloudPolicy === v} onChange={() => set("cloudPolicy", v)} className="accent-brand" />{" "}
                {v === "open" ? "open (forward anything)" : v === "allowlist" ? "allowlist only" : "off (block crazyrouter)"}
              </label>
            ))}
          </div>
          <div>
            <label className="mb-1.5 block text-ui text-muted-foreground">
              Crazyrouter allowlist <span className="text-muted-foreground/70">comma-separated model ids</span>
            </label>
            <Input
              placeholder="gemini-2.5-flash-lite, gpt-5.5, …"
              value={(d.cloudAllowlist || []).join(", ")}
              onChange={(e) => set("cloudAllowlist", e.target.value.split(",").map((x: string) => x.trim()).filter(Boolean))}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-ui text-muted-foreground">
              Default route <span className="text-muted-foreground/70">for unknown/empty/blocked models. Provider <span className="font-mono">none</span> rejects with 400.</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={d.defaultRoute.provider || "none"} onValueChange={(v) => set("defaultRoute", { ...d.defaultRoute, provider: v })}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["none", ...PROVS].map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input className="min-w-[200px]" placeholder="default model id (when provider ≠ none)" value={d.defaultRoute.model || ""} onChange={(e) => set("defaultRoute", { ...d.defaultRoute, model: e.target.value })} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Local model aliases</CardTitle>
          <CardDescription>
            Caller <span className="font-mono">model</span> → the exact id sent to the local llama.cpp server.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Alias</TableHead>
                <TableHead>→ Upstream id</TableHead>
                <TableHead>gated?</TableHead>
                <TableHead className="w-9" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(d.localMap || {}).map(([a, tg]: any) => (
                <TableRow key={a}>
                  <TableCell className="font-mono">{a}</TableCell>
                  <TableCell className="font-mono">{tg}</TableCell>
                  <TableCell>
                    {(d.gatedModels || []).includes(tg) && (
                      <Badge variant="outline" className="text-warn border-warn/40">
                        gated
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <button
                      className="text-muted-foreground hover:text-danger"
                      onClick={() => {
                        const lm = clone(d.localMap);
                        delete lm[a];
                        set("localMap", lm);
                      }}
                    >
                      ✕
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input className="min-w-[160px]" placeholder="alias e.g. local" value={na.alias} onChange={(e) => setNa({ ...na, alias: e.target.value })} />
            <Input className="min-w-[220px]" placeholder="upstream id e.g. gemma-4-e4b-it-obliterated" value={na.target} onChange={(e) => setNa({ ...na, target: e.target.value })} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const a = na.alias.trim().toLowerCase();
                const tg = na.target.trim();
                if (!a || !tg) return notify("alias and target required", true);
                const lm = clone(d.localMap);
                lm[a] = tg;
                set("localMap", lm);
                setNa({ alias: "", target: "" });
              }}
            >
              Add
            </Button>
          </div>
          <p className="mt-2.5 text-ui text-muted-foreground">
            Known local ids: e4b <span className="font-mono">{stg.e4b}</span> · gemma <span className="font-mono">{stg.gemma}</span> · obliterated{" "}
            <span className="font-mono">{stg.obliterated}</span>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Provider base URLs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="mb-1.5 block text-ui text-muted-foreground">local provider (llama.cpp @ pbox GPU)</label>
            <Input value={d.bases.local} onChange={(e) => set("bases", { ...d.bases, local: e.target.value })} />
          </div>
          <div>
            <label className="mb-1.5 block text-ui text-muted-foreground">crazyrouter provider</label>
            <Input value={d.bases.crazyrouter} onChange={(e) => set("bases", { ...d.bases, crazyrouter: e.target.value })} />
          </div>
          <div>
            <label className="mb-1.5 block text-ui text-muted-foreground">
              claudecode provider <span className="text-muted-foreground/70">the real Anthropic API; the account token is injected per project</span>
            </label>
            <Input value={d.bases.claudecode} onChange={(e) => set("bases", { ...d.bases, claudecode: e.target.value })} />
          </div>
          <div>
            <label className="mb-1.5 block text-ui text-muted-foreground">
              claudecode prefix <span className="text-muted-foreground/70">models starting with this route to claudecode (default <span className="font-mono">claude</span>)</span>
            </label>
            <Input value={d.claudePrefix || ""} onChange={(e) => set("claudePrefix", e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Structured / JSON output enforcement</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-body">
              <Checkbox checked={!!d.jsonEnforce} onCheckedChange={(v) => set("jsonEnforce", !!v)} /> enabled
            </label>
            <div>
              <label className="mb-1 block text-ui text-muted-foreground">max retries</label>
              <Input type="number" min={0} max={5} className="w-[90px]" value={d.jsonMaxRetries} onChange={(e) => set("jsonMaxRetries", e.target.value)} />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-ui text-muted-foreground">
              Gated upstream model ids <span className="text-muted-foreground/70">these require the obliterated gate token</span>
            </label>
            <Input value={(d.gatedModels || []).join(", ")} onChange={(e) => set("gatedModels", e.target.value.split(",").map((x: string) => x.trim()).filter(Boolean))} />
          </div>
        </CardContent>
      </Card>

      <Button variant="destructive" onClick={resetCfg}>
        Reset to env defaults
      </Button>
    </div>
  );
}
