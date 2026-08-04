"use client";
import { useState } from "react";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import { providerCls } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  BLOCK_VAL, PROJ_MODELS, Rule, ruleToVal, valToRule, LIM_WINDOWS, LIM_HARD,
} from "@/lib/routing-helpers";

// The Rules page's own controls: the per-project pin dropdown, the allowlist popover and its
// toggle chips, and one usage-limit row. Split out of rules.tsx (934 lines) on 2026-07-26 —
// four components and their constants, none of which the page body needs to be read alongside.
// Kept as a SET-equal copy of the server's PROVIDERS (src/config-schema.js); test/panel-nav.test.mjs
// fails the build when the two drift. The panel is a separate static export and cannot import the
// server module, and a provider the panel never offers is a provider no operator can pin to.
export const PROVS = ["claudecode", "crazyrouter", "local", "openrouter", "freeaiapikey"];

// The pin cell — ONE provider-tinted select (a 3px left accent carries the provider identity the old
// standalone pill used to). `auto` and `block` get their own tint. This is the fix that started the
// whole rewrite: no redundant pill, full width, never truncated.
export const TINT: Record<string, string> = {
  claudecode: "border-l-[3px] border-l-p-claudecode",
  crazyrouter: "border-l-[3px] border-l-p-crazyrouter",
  local: "border-l-[3px] border-l-p-local",
  openrouter: "border-l-[3px] border-l-p-openrouter",
  blocked: "border-l-[3px] border-l-danger text-danger",
  auto: "border-l-[3px] border-l-border text-muted-foreground",
};
export function RuleSelect({
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
export function Chip({ on, tint, onClick, children }: { on: boolean; tint?: string; onClick: () => void; children: React.ReactNode }) {
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
export function AllowCell({
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

export function LimRow({
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


// The shape a new per-project limit starts from. Zero means "no cap on this axis", so a fresh
// row restricts nothing until someone types a number — a limit that blocks by default would be
// an outage dressed as a safety feature.
export const DEFAULT_LIMIT = { window: "24h", tokens: 0, calls: 0, warnPct: 80, slowPct: 95, slowMs: 1500, hard: "block" };
