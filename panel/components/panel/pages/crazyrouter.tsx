"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Stat, StatGrid, PageHead } from "@/components/panel/primitives";
import { useApp } from "@/components/panel/context";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";

// The cloud relay's key + spend. An upstream we call, so it lives under Upstreams next to the
// claudecode account pool — not under a generic "settings" page.
export function Crazyrouter() {
  const { reload } = useApp();
  const [c, setC] = useState<any>(null);
  const [nk, setNk] = useState("");
  const [test, setTest] = useState<string | null>(null);
  const load = useCallback(async () => {
    setC("loading");
    try {
      setC(await api("crazyrouter"));
    } catch {
      setC(null);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  async function testKey() {
    const key = nk.trim();
    if (!key) return notify("paste a key", true);
    setTest("testing…");
    try {
      const r: any = await api("crazyrouter/test", { method: "POST", body: JSON.stringify({ key }) });
      setTest(JSON.stringify(r, null, 2));
      notify(r.keyValid ? "key is VALID — click Save key" : "key is INVALID", !r.keyValid);
    } catch (e: any) {
      setTest("error: " + e.message);
    }
  }
  async function saveKey() {
    const key = nk.trim();
    if (!key) return notify("paste a key", true);
    try {
      const r: any = await api("config", { method: "POST", body: JSON.stringify({ crazyrouterKey: key }) });
      reload(r.state);
      setNk("");
      notify("key saved (live)");
      load();
    } catch (e: any) {
      notify(e.message, true);
    }
  }
  return (
    <div className="space-y-4.5">
      <PageHead
        title="Crazyrouter"
        desc="The cloud relay, and the only provider that bills per token."
        actions={
          <Button variant="outline" size="sm" onClick={load}>
            Refresh
          </Button>
        }
      />
      {c === "loading" || c == null ? (
        <div className="rounded-xl border border-border p-3.5 text-body">{c == null ? "Crazyrouter is unreachable." : "Checking…"}</div>
      ) : (
        <>
          <StatGrid>
            <Stat label="Key">{c.keySet ? c.keyValid ? <span className="text-ok">valid</span> : <span className="text-danger">INVALID</span> : <span className="text-danger">not set</span>}</Stat>
            <Stat label="Limit">{c.hardLimitUsd != null ? "$" + c.hardLimitUsd : "—"}</Stat>
            <Stat label="Used">{c.totalUsageUsd != null ? "$" + c.totalUsageUsd.toFixed(2) : "—"}</Stat>
            <Stat label="Remaining">{c.remainingUsd != null ? "$" + c.remainingUsd.toFixed(2) : "—"}</Stat>
            <Stat label="Models">{c.modelCount ?? "—"}</Stat>
            <Stat label="Key id">{c.keyMasked || "(none)"}</Stat>
          </StatGrid>
          {(c.message || !c.keyValid) && (
            <div className="rounded-xl border border-warn/35 bg-warn/[0.07] p-3.5 text-body">
              {(c.message || "key check failed") + (c.statuses ? " · statuses " + JSON.stringify(c.statuses) : "")}
            </div>
          )}
        </>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Update key</CardTitle>
          <CardDescription>
            Paste a new <span className="font-mono">sk-</span> key and test it before saving. Saving takes effect immediately, with no redeploy.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Input placeholder="sk-…" value={nk} onChange={(e) => setNk(e.target.value)} />
          <div className="mt-3 flex gap-2">
            <Button variant="outline" onClick={testKey}>
              Test key
            </Button>
            <Button onClick={saveKey}>Save key</Button>
          </div>
          {test != null && (
            <pre className="mt-3 max-h-[340px] overflow-auto rounded-lg border border-border bg-sunken p-3.5 font-mono text-ui leading-relaxed whitespace-pre-wrap break-words">{test}</pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

