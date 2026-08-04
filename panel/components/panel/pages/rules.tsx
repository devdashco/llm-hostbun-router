"use client";
import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription, CardAction,
} from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ProviderBadge } from "@/components/panel/badges";
import { PageHead } from "@/components/panel/primitives";
import { useApp } from "@/components/panel/context";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { clone } from "@/lib/format";
import { Rule, PROJ_MODELS } from "@/lib/routing-helpers";
import {
  PROVS, RuleSelect, AllowCell, LimRow, DEFAULT_LIMIT,
} from "@/components/panel/pages/rules-controls";
import { RoutingAdvanced } from "@/components/panel/pages/rules-advanced";

export function Rules() {
  const { state, reload } = useApp() as any;
  const [d, setD] = useState<any>(() => seed(state));
  const [known, setKnown] = useState<string[]>([]);
  // What each provider ACTUALLY serves right now, from /api/models (claudecode reconciled against
  // Anthropic every 6h, crazyrouter fetched live). Without it this page offered `cloudAllowlist` as
  // the crazyrouter menu — which is empty whenever the policy is "open", i.e. in prod — so the ids
  // the router really routes (glm-5.2, gemini-3.1-flash-lite) could not be picked at all and got
  // hand-typed into rules instead. A hand-typed allowlist is how a rule ends up naming a model no
  // upstream serves. Empty until it lands; PROJ_MODELS is the offline fallback.
  const [live, setLive] = useState<Record<string, string[]>>({});
  const [nl, setNl] = useState("");
  useEffect(() => setD(seed(state)), [state]);
  useEffect(() => {
    (async () => {
      try {
        const m: any = await api("models");
        const ids = (v: any) => (Array.isArray(v) ? v.map((x: any) => x.id).filter(Boolean) : []);
        setLive({
          claudecode: ids(m.claudecode),
          crazyrouter: ids(m.crazyrouter),
          local: ids(m.local),
          openrouter: ids(m.openrouter),
        });
      } catch {
        /* upstream catalog unreachable — fall back to what state + PROJ_MODELS know */
      }
      try {
        const s: any = await api("stats?window=all");
        setKnown((s.byProject || []).map((r: any) => r.project).filter(Boolean));
      } catch {
        /* ignore */
      }
    })();
  }, []);
  function seed(s: any) {
    return {
      bases: clone(s.bases),
      claudePrefix: s.claudePrefix,
      jsonEnforce: !!s.jsonEnforce,
      jsonMaxRetries: s.jsonMaxRetries,
      gatedModels: (s.gatedModels || []).slice(),
      localMap: clone(s.localMap),
      modelRoutes: clone(s.modelRoutes),
      projectRoutes: clone(s.projectRoutes),
      projectLimits: clone(s.projectLimits),
      projectLimitDefault: clone(s.projectLimitDefault || DEFAULT_LIMIT),
      forceModel: clone(s.forceModel),
      cloudPolicy: s.cloudPolicy || "open",
      cloudAllowlist: (s.cloudAllowlist || []).slice(),
      defaultRoute: clone(s.defaultRoute),
    };
  }
  const set = (k: string, v: any) => setD((x: any) => ({ ...x, [k]: v }));

  const registered = Object.keys(state.consumers || {});
  const projNames = [
    ...new Set(
      [...registered, ...known.map((p) => String(p).split(":")[0]), ...Object.keys(d.projectRoutes || {})].filter(
        (p) => p && p !== "(none)",
      ),
    ),
  ].sort();
  const seenSet = new Set(known.map((p) => String(p).split(":")[0]));
  const uniq = (a: string[]) => [...new Set(a.filter(Boolean))].sort();
  const fallback = (prov: string) => PROJ_MODELS.filter((p) => p.provider === prov).map((p) => p.model);
  const catalog: Record<string, string[]> = {
    claudecode: uniq([...(live.claudecode || []), ...(state.claudecodeModels || []), ...fallback("claudecode")]),
    crazyrouter: uniq([...(live.crazyrouter || []), ...(state.cloudAllowlist || []), ...fallback("crazyrouter")]),
    local: uniq([...(live.local || []), ...Object.keys(state.localMap || {}), ...fallback("local")]),
    // /api/models already applies the free-only guard, so this offers what would actually resolve.
    openrouter: uniq([...(live.openrouter || []), ...(state.openrouterModels || []), ...fallback("openrouter")]),
  };
  // `catalog[p] || []`, not `catalog[p]`: PROVS is pinned to the server's PROVIDERS, so it gains a
  // provider the moment one is added server-side — and the bare index crashed the whole page on the
  // render right after that, before anyone could add the key here.
  const catalogOpts = PROVS.flatMap((p) => (catalog[p] || []).map((model) => ({ provider: p, model })));

  async function save() {
    const patch = {
      bases: d.bases,
      localMap: d.localMap,
      modelRoutes: d.modelRoutes,
      projectRoutes: d.projectRoutes,
      forceModel: { enabled: d.forceModel.enabled, provider: d.forceModel.provider || "claudecode", model: (d.forceModel.model || "").trim() },
      cloudPolicy: d.cloudPolicy,
      cloudAllowlist: d.cloudAllowlist,
      defaultRoute: { provider: d.defaultRoute.provider || "none", model: (d.defaultRoute.model || "").trim() },
      claudePrefix: (d.claudePrefix || "").trim() || "claude",
      jsonEnforce: d.jsonEnforce,
      jsonMaxRetries: parseInt(d.jsonMaxRetries || 2, 10),
      gatedModels: d.gatedModels,
    };
    if (patch.forceModel.enabled && !patch.forceModel.model) {
      notify("force model is on but no model id set", true);
      return;
    }
    try {
      const r: any = await api("config", { method: "POST", body: JSON.stringify(patch) });
      reload(r.state);
      notify("saved" + (r.persisted ? " & persisted" : " (NOT persisted!)"), !r.persisted);
    } catch (e: any) {
      notify(e.message, true);
    }
  }
  async function saveLimits() {
    const projectLimits: Record<string, any> = {};
    Object.entries(d.projectLimits || {}).forEach(([k, v]) => {
      if (k.trim()) projectLimits[k.trim().toLowerCase()] = v;
    });
    try {
      const r: any = await api("config", { method: "POST", body: JSON.stringify({ projectLimits, projectLimitDefault: d.projectLimitDefault }) });
      reload(r.state);
      notify("usage limits saved" + (r.persisted ? " & persisted" : " (NOT persisted!)"), !r.persisted);
    } catch (e: any) {
      notify(e.message, true);
    }
  }

  const setRule = (k: string, rule: Rule | null) => {
    const pr = clone(d.projectRoutes);
    if (!rule) delete pr[k];
    else pr[k] = rule;
    set("projectRoutes", pr);
  };

  return (
    <div className="space-y-4.5">
      <PageHead
        title="Rules"
        desc="Where a request goes, and what it is allowed to reach. A per-project rule (exact path, then consumer) beats the defaults."
      />
      <Card className="border-p-crazyrouter/40">
        <CardHeader>
          <CardTitle>Per-project model</CardTitle>
          <CardDescription>
            <b>Model</b> pins the request and rewrites it. <b>Allowed</b> only restricts, and refuses on
            a mismatch — it never substitutes. A rule also covers that consumer&apos;s jobs (
            <span className="font-mono">name:job</span>).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28%]">Project</TableHead>
                <TableHead className="w-[40%]">Model (pin)</TableHead>
                <TableHead>Allowed (providers / models)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projNames.length ? (
                projNames.map((k) => {
                  const cur: Rule | undefined = d.projectRoutes[k];
                  const pinCur = cur && (cur.provider || cur.block) ? cur : null;
                  return (
                    <TableRow key={k}>
                      <TableCell className="font-mono align-middle">
                        {k}
                        {!state.consumers?.[k] && (
                          <Badge variant="outline" className="ml-1.5 text-danger border-danger/45" title="seen in the call log but not in the consumer registry">
                            unregistered
                          </Badge>
                        )}
                        {!seenSet.has(k) && state.consumers?.[k] && (
                          <Badge variant="secondary" className="ml-1.5 text-muted-foreground" title="registered, no traffic yet">
                            idle
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <RuleSelect
                          cur={pinCur}
                          opts={catalogOpts}
                          onChange={(rule) => {
                            const keep = cur
                              ? {
                                  ...(cur.allowProviders ? { allowProviders: cur.allowProviders } : {}),
                                  ...(cur.allowModels ? { allowModels: cur.allowModels } : {}),
                                }
                              : {};
                            const next = rule
                              ? { ...rule, ...(rule.block ? {} : keep) }
                              : Object.keys(keep).length
                                ? keep
                                : null;
                            setRule(k, next as Rule | null);
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <AllowCell cur={cur} catalog={catalog} onChange={(r) => setRule(k, r)} />
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={3} className="text-ui text-muted-foreground">
                    No projects seen yet. They appear once an app calls the router with a key or an{" "}
                    <span className="font-mono">X-Project</span> header.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="border-warn/40">
        <CardHeader>
          <CardTitle>Usage limits</CardTitle>
          <CardDescription>
            Cap tokens or calls per project over a rolling window: <span className="text-warn font-semibold">warn</span>, then{" "}
            <span className="text-warn font-semibold">slow</span>, then <span className="text-danger font-semibold">block</span>. Zero means no cap.
          </CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={saveLimits}>
              Save usage limits
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[150px]">Project</TableHead>
                <TableHead>Window</TableHead>
                <TableHead>Token cap</TableHead>
                <TableHead>Call cap</TableHead>
                <TableHead>Warn%</TableHead>
                <TableHead>Slow%</TableHead>
                <TableHead>Slow ms</TableHead>
                <TableHead>At 100%</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <LimRow name="default" l={d.projectLimitDefault} isDef onChg={(v) => set("projectLimitDefault", v)} />
              {Object.keys(d.projectLimits || {})
                .sort()
                .map((k) => (
                  <LimRow
                    key={k}
                    name={k}
                    l={d.projectLimits[k]}
                    isDef={false}
                    onChg={(v) => {
                      const pl = clone(d.projectLimits);
                      pl[k] = v;
                      set("projectLimits", pl);
                    }}
                    onRm={() => {
                      const pl = clone(d.projectLimits);
                      delete pl[k];
                      set("projectLimits", pl);
                    }}
                  />
                ))}
            </TableBody>
          </Table>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              placeholder="project slug (exact, e.g. fb-bot)"
              className="min-w-[200px] flex-1"
              value={nl}
              onChange={(e) => setNl(e.target.value)}
            />
            <Button
              variant="outline"
              onClick={() => {
                const name = nl.trim().toLowerCase();
                if (!name) return notify("enter a project slug", true);
                if ((d.projectLimits || {})[name]) return notify("that project already has a row", true);
                const pl = clone(d.projectLimits);
                pl[name] = { ...DEFAULT_LIMIT };
                set("projectLimits", pl);
                setNl("");
              }}
            >
              Add project limit
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className={d.forceModel.enabled ? "border-warn/40" : ""}>
        <CardHeader>
          <CardTitle>Force model</CardTitle>
          <CardDescription>Override every request and ignore what the caller asked for.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-body">
              <Checkbox checked={!!d.forceModel.enabled} onCheckedChange={(v) => set("forceModel", { ...d.forceModel, enabled: !!v })} /> force enabled
            </label>
            <Select value={d.forceModel.provider || "claudecode"} onValueChange={(v) => set("forceModel", { ...d.forceModel, provider: v })}>
              <SelectTrigger className="w-[150px]">
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
            <Input
              className="min-w-[200px] flex-[2]"
              placeholder="model id sent to that provider"
              value={d.forceModel.model || ""}
              onChange={(e) => set("forceModel", { ...d.forceModel, model: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>No fallback</CardTitle>
          <CardDescription>By design, not by omission.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-body text-muted-foreground">
            A 429 means the project&apos;s pinned account is out of quota; a 5xx means the upstream
            failed. Both reach the caller unchanged. The gateway never re-answers on a different account
            or provider: doing so blows the per-org prompt cache (~12× cost) and hides who spent what.
            Re-pin the project instead.
          </p>
        </CardContent>
      </Card>

      <div>
        <Button onClick={save}>Save routing</Button>
      </div>

      <RoutingAdvanced d={d} set={set} reload={reload} state={state} />
    </div>
  );
}
