"use client";
import { useEffect, useState } from "react";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { clone, providerCls } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  BLOCK_VAL, PROJ_MODELS, Rule, ruleToVal, valToRule, LIM_WINDOWS, LIM_HARD,
} from "@/lib/routing-helpers";

const PROVS = ["claudecode", "crazyrouter", "local"];

// The pin cell — ONE provider-tinted select (a 3px left accent carries the provider identity the old
// standalone pill used to). `auto` and `block` get their own tint. This is the fix that started the
// whole rewrite: no redundant pill, full width, never truncated.
const TINT: Record<string, string> = {
  claudecode: "border-l-[3px] border-l-p-claudecode",
  crazyrouter: "border-l-[3px] border-l-p-crazyrouter",
  local: "border-l-[3px] border-l-p-local",
  blocked: "border-l-[3px] border-l-danger text-danger",
  auto: "border-l-[3px] border-l-border text-muted-foreground",
};
function RuleSelect({
  cur,
  onChange,
  opts,
}: {
  cur: Rule | null;
  onChange: (r: Rule | null) => void;
  opts: { provider: string; model: string }[];
}) {
  const list = opts && opts.length ? opts : PROJ_MODELS;
  const sel = ruleToVal(cur);
  const byProv: Record<string, string[]> = {};
  list.forEach((p) => (byProv[p.provider] || (byProv[p.provider] = [])).push(p.model));
  const extra = cur && !cur.block && !list.some((p) => p.provider === cur.provider && p.model === cur.model);
  const tint = cur?.block ? "blocked" : cur?.provider ? providerCls[cur.provider] || "" : "auto";
  return (
    <Select value={sel || "__auto__"} onValueChange={(v) => onChange(valToRule(v === "__auto__" ? "" : v))}>
      <SelectTrigger className={cn("w-full font-sans", TINT[tint])}>
        <SelectValue placeholder="auto — normal routing" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__auto__">auto — normal routing</SelectItem>
        <SelectItem value={BLOCK_VAL}>block — reject, 0 tokens</SelectItem>
        {extra && cur && (
          <SelectItem value={sel}>
            {cur.provider}: {cur.model || "(keep caller's)"}
          </SelectItem>
        )}
        {Object.keys(byProv).map((prov) => (
          <SelectGroup key={prov}>
            <SelectLabel className={cn("font-mono text-meta uppercase", TINT[providerCls[prov] || ""])}>
              {prov}
            </SelectLabel>
            {byProv[prov].map((m) => (
              <SelectItem key={prov + "|" + m} value={`${prov}|${m}`} className="font-mono">
                {m}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

// A clickable chip (provider / model) for the allowlist picker.
function Chip({ on, tint, onClick, children }: { on: boolean; tint?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] font-mono text-meta transition-colors",
        on
          ? cn("border-p-crazyrouter bg-p-crazyrouter/15 text-foreground", tint)
          : "border-border bg-sunken text-muted-foreground hover:border-border/80 hover:text-foreground",
      )}
    >
      {on && <span className="text-p-crazyrouter">✓</span>}
      {children}
    </button>
  );
}

// Allowlist editor — independent of the pin (the pin rewrites, the allowlist only refuses). Empty =
// no restriction. Popover of provider + per-provider model toggle chips. Ported from AllowCell.
function AllowCell({
  cur,
  catalog,
  onChange,
}: {
  cur: Rule | undefined;
  catalog: Record<string, string[]>;
  onChange: (r: Rule | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ap = cur?.allowProviders || [];
  const am = cur?.allowModels || [];
  const blocked = cur?.block;
  const emit = (patch: Partial<Rule>) => {
    const next: Rule = { ...(cur || {}), ...patch };
    (["allowProviders", "allowModels"] as const).forEach((k) => {
      if (!next[k] || !next[k]!.length) delete next[k];
    });
    onChange(next.provider || next.block || next.allowProviders || next.allowModels ? next : null);
  };
  const toggleP = (p: string) => emit({ allowProviders: ap.includes(p) ? ap.filter((x) => x !== p) : [...ap, p] });
  const toggleM = (m: string) => emit({ allowModels: am.includes(m) ? am.filter((x) => x !== m) : [...am, m] });
  const setMany = (add: string[], rm: string[]) =>
    emit({ allowModels: [...am.filter((m) => !rm.includes(m)), ...add.filter((m) => !am.includes(m))] });

  if (blocked) return <span className="text-ui text-muted-foreground">blocked — nothing runs</span>;

  const summary =
    !ap.length && !am.length
      ? "any"
      : [
          ap.length && `${ap.length} provider${ap.length > 1 ? "s" : ""}`,
          am.length && `${am.length} model${am.length > 1 ? "s" : ""}`,
        ]
          .filter(Boolean)
          .join(" · ");
  const known = new Set(PROVS.flatMap((p) => catalog[p] || []));
  const extras = am.filter((m) => !known.has(m));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="font-mono">
          {open ? "▾" : "▸"} {summary}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(440px,90vw)] max-h-[60vh] overflow-auto">
        <div>
          <div className="mb-2 font-mono text-meta uppercase tracking-wide text-muted-foreground">
            Providers
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PROVS.map((p) => (
              <Chip key={p} on={ap.includes(p)} tint={TINT[providerCls[p] || ""]} onClick={() => toggleP(p)}>
                {p}
              </Chip>
            ))}
          </div>
        </div>
        {PROVS.map((prov) => {
          const ms = catalog[prov] || [];
          if (!ms.length) return null;
          const on = ms.filter((m) => am.includes(m)).length;
          return (
            <div key={prov} className="mt-3.5">
              <div className="mb-1.5 flex items-center gap-2 font-mono text-meta uppercase tracking-wide text-muted-foreground">
                <span className={TINT[providerCls[prov] || ""]}>{prov}</span> models
                <span className="flex-1" />
                <button className="rounded-full border border-border px-2 py-px hover:text-foreground" onClick={() => setMany(ms, [])}>
                  all
                </button>
                <button
                  className="rounded-full border border-border px-2 py-px hover:text-foreground disabled:opacity-40"
                  disabled={!on}
                  onClick={() => setMany([], ms)}
                >
                  clear
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {ms.map((m) => (
                  <Chip key={m} on={am.includes(m)} onClick={() => toggleM(m)}>
                    {m}
                  </Chip>
                ))}
              </div>
            </div>
          );
        })}
        {extras.length > 0 && (
          <div className="mt-3.5">
            <div className="mb-1.5 font-mono text-meta uppercase tracking-wide text-muted-foreground">
              other (not in catalog)
            </div>
            <div className="flex flex-wrap gap-1.5">
              {extras.map((m) => (
                <Chip key={m} on onClick={() => toggleM(m)}>
                  {m}
                </Chip>
              ))}
            </div>
          </div>
        )}
        <p className="mt-3 text-ui text-muted-foreground">
          Nothing selected = no restriction. A call that resolves outside the picked set is rejected,
          never rewritten.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function LimRow({
  name,
  l,
  isDef,
  onChg,
  onRm,
}: {
  name: string;
  l: any;
  isDef: boolean;
  onChg: (v: any) => void;
  onRm?: () => void;
}) {
  const g = (f: string, v: any) => onChg({ ...l, [f]: v });
  const num = (f: string, w: string) => (
    <Input
      type="number"
      min={0}
      className={cn("h-8", w)}
      value={l[f] ?? 0}
      onChange={(e) => g(f, +e.target.value || 0)}
    />
  );
  return (
    <TableRow>
      <TableCell>
        {isDef ? (
          <>
            <b>Default</b>
            <div className="text-meta text-muted-foreground">all attributed projects</div>
          </>
        ) : (
          <span className="font-mono">{name}</span>
        )}
      </TableCell>
      <TableCell>
        <Select value={l.window || "24h"} onValueChange={(v) => g("window", v)}>
          <SelectTrigger className="h-8 w-[84px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIM_WINDOWS.map((w) => (
              <SelectItem key={w} value={w}>
                {w}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>{num("tokens", "w-[100px]")}</TableCell>
      <TableCell>{num("calls", "w-[80px]")}</TableCell>
      <TableCell>
        <Input type="number" min={0} max={100} className="h-8 w-[54px]" value={l.warnPct ?? 80} onChange={(e) => g("warnPct", +e.target.value || 0)} />
      </TableCell>
      <TableCell>
        <Input type="number" min={0} max={100} className="h-8 w-[54px]" value={l.slowPct ?? 95} onChange={(e) => g("slowPct", +e.target.value || 0)} />
      </TableCell>
      <TableCell>{num("slowMs", "w-[68px]")}</TableCell>
      <TableCell>
        <Select value={l.hard || "block"} onValueChange={(v) => g("hard", v)}>
          <SelectTrigger className="h-8 w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIM_HARD.map(([v, lb]) => (
              <SelectItem key={v} value={v}>
                {lb}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        {isDef ? null : (
          <button className="text-muted-foreground hover:text-danger" onClick={onRm}>
            ✕
          </button>
        )}
      </TableCell>
    </TableRow>
  );
}

const DEFAULT_LIMIT = { window: "24h", tokens: 0, calls: 0, warnPct: 80, slowPct: 95, slowMs: 1500, hard: "block" };

export function Rules() {
  const { state, reload } = useApp() as any;
  const [d, setD] = useState<any>(() => seed(state));
  const [known, setKnown] = useState<string[]>([]);
  const [nl, setNl] = useState("");
  useEffect(() => setD(seed(state)), [state]);
  useEffect(() => {
    (async () => {
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
  const catalog: Record<string, string[]> = {
    claudecode: uniq([...(state.claudecodeModels || []), ...PROJ_MODELS.filter((p) => p.provider === "claudecode").map((p) => p.model)]),
    crazyrouter: uniq([...(state.cloudAllowlist || []), ...PROJ_MODELS.filter((p) => p.provider === "crazyrouter").map((p) => p.model)]),
    local: uniq([...Object.keys(state.localMap || {}), ...PROJ_MODELS.filter((p) => p.provider === "local").map((p) => p.model)]),
  };
  const catalogOpts = PROVS.flatMap((p) => catalog[p].map((model) => ({ provider: p, model })));

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

// The Advanced section — resolve/trace, model overrides, crazyrouter policy, local aliases, base
// URLs, JSON enforcement, reset. Collapsed by default.
function RoutingAdvanced({ d, set, reload, state }: any) {
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
