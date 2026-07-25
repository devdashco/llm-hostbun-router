"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Stat, StatGrid, PageHead } from "@/components/panel/primitives";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { ago } from "@/lib/format";

// The Claude catalog — the ids the router will route to Anthropic. `source:anthropic` = reconciled
// against api.anthropic.com; `seed` = serving the hardcoded floor. A union across accounts; a 429 is
// a usage window, not a missing model. Ported from admin/ui/pages/models.js.
function ClaudeCatalog() {
  const [cat, setCat] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setCat(await api("claudecode/models"));
    } catch (e: any) {
      notify(e.message, true);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  async function refresh() {
    setBusy(true);
    try {
      setCat(await api("claudecode/models", { method: "POST" }));
      notify("catalog refreshed from Anthropic");
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  const since = (ts: number) => (ts ? ago(ts) + " ago" : "never");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Claude catalog</CardTitle>
        <CardDescription>Read from api.anthropic.com, not from config.</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" disabled={busy} onClick={refresh}>
            {busy ? "Refreshing…" : "Refresh from Anthropic"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <StatGrid>
          <Stat label="advertised on /v1/models">{cat ? cat.advertised.length : "…"} ids</Stat>
          <Stat label="source">
            {cat ? (
              <Badge variant="outline" className={cat.source === "anthropic" ? "text-ok border-ok/40" : "text-warn border-warn/40"}>
                {cat.source}
              </Badge>
            ) : (
              "…"
            )}
          </Stat>
          <Stat label="last checked">
            {cat ? since(cat.checkedAt) : "…"}
            {cat && cat.sweptAccounts && cat.sweptAccounts.length ? (
              <span className="text-ui text-muted-foreground">
                {" "}
                swept {cat.sweptAccounts.length} account{cat.sweptAccounts.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </Stat>
        </StatGrid>
        {cat && cat.source !== "anthropic" && (
          <p className="mb-2.5 text-body text-danger">
            Serving the hardcoded seed — Anthropic&apos;s catalog has not been read successfully
            {cat.error ? ": " + cat.error : ""}. Ids still route; the list may just be stale.
          </p>
        )}
        {cat && cat.failedAccounts && cat.failedAccounts.length > 0 && (
          <p className="mb-2.5 text-body text-warn">
            Could not read the catalog on {cat.failedAccounts.map((f: any) => f.account + " (" + f.error + ")").join(", ")}. Any model only those
            accounts can see is missing from this list.
          </p>
        )}
        <p className="mb-3 text-ui text-muted-foreground">
          The catalog is a <b>union</b> across every account. All ids route to the pinned subscription; a{" "}
          <span className="font-mono">429</span> at request time means that subscription&apos;s usage window is spent (and resets), not that the
          model is gone.
        </p>
        <div className="max-h-[340px] overflow-auto rounded-lg border border-border px-2.5 py-1.5 font-mono text-body">
          {cat ? (
            cat.advertised.map((id: string) => {
              const m = (cat.models || []).find((x: any) => x.id === id);
              const na = m && m.accounts ? m.accounts.length : 0;
              const tot = (cat.sweptAccounts || []).length;
              return (
                <div key={id} className="flex items-center gap-2 py-1">
                  <span>{id}</span>
                  <span className="text-muted-foreground">{m && m.display_name ? "· " + m.display_name : ""}</span>
                  {m && tot > 0 && na < tot && (
                    <Badge variant="outline" className="text-warn border-warn/40" title={"only on: " + m.accounts.join(", ")}>
                      {na}/{tot} accts
                    </Badge>
                  )}
                  {!m && (cat.aliases || []).includes(id) && (
                    <Badge variant="outline" className="text-muted-foreground" title="Anthropic serves this id but does not list it in /v1/models">
                      alias
                    </Badge>
                  )}
                  {!m && !(cat.aliases || []).includes(id) && cat.source === "anthropic" && (
                    <Badge variant="outline" className="text-muted-foreground" title="in the code seed, not in Anthropic's catalog">
                      seed only
                    </Badge>
                  )}
                </div>
              );
            })
          ) : (
            <span className="text-muted-foreground">loading…</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function Models() {
  const [models, setModels] = useState<any>(null);
  const [filter, setFilter] = useState("");
  const [tm, setTm] = useState("");
  const [tp, setTp] = useState("In one short sentence, what model are you?");
  const [out, setOut] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        setModels(await api("models"));
      } catch {
        /* ignore */
      }
    })();
  }, []);
  async function runTest() {
    const model = tm.trim();
    if (!model) return notify("enter a model", true);
    setOut("running…");
    try {
      const r: any = await api("test", { method: "POST", body: JSON.stringify({ model, prompt: tp }) });
      setOut(
        `provider=${r.provider} sent=${r.sentModel} status=${r.status} ${r.ms}ms\n` +
          (r.content != null ? "\n" + r.content : "\n[no content]\n" + (r.error || r.raw || "")),
      );
    } catch (e: any) {
      setOut("error: " + e.message);
    }
  }
  const all = models ? [...models.local, ...models.claudecode, ...models.crazyrouter] : [];
  const Section = ({ title, cls, arr }: { title: string; cls: string; arr: any[] }) => {
    const items = (arr || []).filter((m) => !filter || m.id.toLowerCase().includes(filter.toLowerCase()));
    if (!items.length) return null;
    const badge: Record<string, string> = {
      local: "text-p-local border-p-local/40",
      claudecode: "text-p-claudecode border-p-claudecode/40",
      crazyrouter: "text-p-crazyrouter border-p-crazyrouter/45",
    };
    return (
      <div>
        <div className="mb-1.5 mt-3.5 flex items-center gap-2">
          <Badge variant="outline" className={badge[cls]}>
            {title}
          </Badge>
          <span className="text-muted-foreground">{items.length}</span>
        </div>
        {items.map((m) => (
          <div key={m.id} className="py-0.5">
            {m.id} <span className="text-muted-foreground">· {m.owned_by || ""}</span>
          </div>
        ))}
      </div>
    );
  };
  return (
    <div className="space-y-4.5">
      <PageHead title="Models & test" desc="What each provider advertises, and what the pinned subscription will actually serve." />
      <ClaudeCatalog />
      <Card>
        <CardHeader>
          <CardTitle>Test a model</CardTitle>
          <CardDescription>Runs a real chat completion through the current routing.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              list="modellist"
              className="min-w-[220px] flex-[2]"
              placeholder="model e.g. local / claude-sonnet-4-6 / gemini-2.5-pro"
              value={tm}
              onChange={(e) => setTm(e.target.value)}
            />
            <Button onClick={runTest}>Run</Button>
          </div>
          <datalist id="modellist">
            {all.map((m) => (
              <option key={m.id} value={m.id} />
            ))}
          </datalist>
          <Input placeholder="prompt" value={tp} onChange={(e) => setTp(e.target.value)} />
          {out != null && (
            <pre className="max-h-[340px] overflow-auto rounded-lg border border-border bg-sunken p-3.5 font-mono text-ui leading-relaxed whitespace-pre-wrap break-words">
              {out}
            </pre>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Available models</CardTitle>
          <CardDescription>
            {models ? `local ${models.local.length} · claudecode ${models.claudecode.length} · crazyrouter ${models.crazyrouter.length}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Input placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="mt-2.5 max-h-[420px] overflow-auto font-mono text-body">
            {models ? (
              <>
                <Section title="local" cls="local" arr={models.local} />
                <Section title="claudecode" cls="claudecode" arr={models.claudecode} />
                <Section title="crazyrouter" cls="crazyrouter" arr={models.crazyrouter} />
              </>
            ) : (
              <span className="text-muted-foreground">loading…</span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
