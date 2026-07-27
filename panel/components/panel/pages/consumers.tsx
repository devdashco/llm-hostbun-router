"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { KindBadge } from "@/components/panel/badges";
import { PageHead } from "@/components/panel/primitives";
import { Seg } from "@/components/panel/seg";
import { useApp } from "@/components/panel/context";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { nfmt, ago } from "@/lib/format";

export function Consumers() {
  const { reload, go } = useApp();
  const [reg, setReg] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [nn, setNn] = useState("");
  const [nk, setNk] = useState("app");
  const [no, setNo] = useState("");
  const [issued, setIssued] = useState<any>(null);
  const load = useCallback(async () => {
    try {
      setReg(await api("consumers"));
      setErr("");
    } catch (e: any) {
      setErr(e.message || "load failed");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const mode = (reg && reg.authMode) || "optional";
  const keyless = (reg && reg.keyless) || [];
  async function issueKey(name: string, kind?: string, owner?: string) {
    setBusy(name);
    try {
      const r = await api("consumers/keys", { method: "POST", body: JSON.stringify({ name, kind, owner: kind === "dev" ? owner : undefined }) });
      setIssued(r);
      await load();
      reload();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy("");
    }
  }
  async function revokeKey(name: string, id: string) {
    if (!confirm(`Revoke key ${id} for "${name}"? Any caller using it starts getting 401 immediately.`)) return;
    setBusy(name);
    try {
      await api("consumers/keys/revoke", { method: "POST", body: JSON.stringify({ name, id }) });
      notify(`key ${id} revoked`);
      await load();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy("");
    }
  }
  async function setMode(m: string) {
    if (m === "required" && keyless.length && !confirm(`${keyless.length} registered consumer(s) hold NO key:\n\n${keyless.map((x: string) => "  " + x).join("\n")}\n\nIn "required" mode every one of them gets 401 on the next call. Issue their keys first.\n\nSwitch anyway?`)) return;
    setBusy("mode");
    try {
      await api("auth", { method: "POST", body: JSON.stringify({ mode: m }) });
      notify(m === "required" ? "auth required — un-keyed callers now 401" : `auth mode: ${m}`);
      await load();
      reload();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy("");
    }
  }
  async function save(name: string, kind: string, owner: string, note: string) {
    setBusy(name);
    try {
      await api("consumers", { method: "POST", body: JSON.stringify({ name, kind, owner: kind === "dev" ? owner : undefined, note }) });
      notify(`${name} registered as ${kind}`);
      await load();
      reload();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy("");
    }
  }
  async function remove(name: string) {
    if (!confirm(`Unregister "${name}"? If enforcement is on, its calls start failing with 403 unknown_consumer.`)) return;
    setBusy(name);
    try {
      await api("consumers", { method: "POST", body: JSON.stringify({ name, remove: true }) });
      notify(`${name} unregistered`);
      await load();
      reload();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy("");
    }
  }
  async function enforce(on: boolean) {
    const unreg = (reg && reg.unregistered) || [];
    if (on && unreg.length && !confirm(`${unreg.length} consumer(s) in the log are NOT registered:\n\n${unreg.map((x: any) => "  " + x.name + " (" + x.calls + " calls)").join("\n")}\n\nTurning enforcement on makes every one of them fail with 403. Continue?`)) return;
    setBusy("enforce");
    try {
      await api("consumers/enforce", { method: "POST", body: JSON.stringify({ enabled: on }) });
      notify(on ? "enforcing — unregistered consumers now 403" : "enforcement off");
      await load();
      reload();
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy("");
    }
  }
  async function add() {
    const n = nn.trim().toLowerCase();
    if (!n) return notify("name required", true);
    if (n.includes(":")) return notify('a key belongs to the consumer, not the job — drop the ":" part', true);
    if (nk === "dev" && !no.trim()) return notify("a dev is someone's machine — owner required", true);
    await issueKey(n, nk, no.trim());
    setNn("");
    setNo("");
  }
  const since = (ts: number) => (ts ? ago(ts) : "never");
  const unreg = (reg && reg.unregistered) || [];
  const regd = (reg && reg.registered) || [];
  return (
    <div className="space-y-4.5">
      <PageHead
        title="Callers"
        desc="Register who may call the router and issue their keys. A caller is a consumer everywhere else — the API, the registry, the call log.Spend lives on the Usage tab."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load}>
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => go("overview", "usage")} title="per-consumer spend, cost and history">
              Usage →
            </Button>
          </>
        }
      />
      {err && <div className="rounded-xl border border-danger/40 bg-danger/10 p-3.5 text-body text-danger">{err}</div>}

      {issued && (
        <Card className="border-ok/45">
          <CardHeader>
            <CardTitle>
              Key issued for <span className="font-mono">{issued.consumer}</span>
            </CardTitle>
            <CardDescription>This is the only time it is shown. Only its sha256 is stored. Put it in keyvault now.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="select-all break-all rounded-lg border border-border bg-sunken p-3 font-mono text-body">{issued.key}</div>
            <div className="mt-3 flex gap-2">
              <Button
                onClick={() => {
                  navigator.clipboard.writeText(issued.key);
                  notify("key copied");
                }}
              >
                Copy
              </Button>
              <Button variant="outline" onClick={() => setIssued(null)}>
                I have stored it
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Register a consumer</CardTitle>
          <CardDescription>
            One step registers <b>and</b> issues the key. A <b>dev</b> is a person&apos;s machine (needs an owner); an <b>app</b> is deployed code
            (no owner). Only the sha256 is stored — the key is shown once.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <Input className="min-w-[180px] flex-[2]" placeholder="consumer name (no ':') e.g. promopilot" value={nn} onChange={(e) => setNn(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
            <Select value={nk} onValueChange={setNk}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="app">app</SelectItem>
                <SelectItem value="dev">dev</SelectItem>
              </SelectContent>
            </Select>
            <Input className="min-w-[140px] flex-1" placeholder={nk === "dev" ? "owner (a person)" : "apps have no owner"} disabled={nk !== "dev"} value={nk === "dev" ? no : ""} onChange={(e) => setNo(e.target.value)} />
            <Button disabled={!!busy} onClick={add}>
              Issue key
            </Button>
          </div>
        </CardContent>
      </Card>

      {unreg.length > 0 && (
        <Card className="border-warn/40">
          <CardHeader>
            <CardTitle>Seen but unregistered ({unreg.length})</CardTitle>
            <CardDescription>These names are in the call log with no registry entry. Register them so a typo can&apos;t quietly bill as a new consumer.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>name</TableHead>
                  <TableHead>calls</TableHead>
                  <TableHead>tokens</TableHead>
                  <TableHead>jobs</TableHead>
                  <TableHead>register as</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unreg.map((x: any) => (
                  <TableRow key={x.name}>
                    <TableCell className="font-mono font-semibold">{x.name}</TableCell>
                    <TableCell className="font-mono">{nfmt(x.calls)}</TableCell>
                    <TableCell className="font-mono text-muted-foreground">{nfmt(x.tokens)}</TableCell>
                    <TableCell className="font-mono text-muted-foreground">{x.jobs || 0}</TableCell>
                    <TableCell>
                      <div className="flex gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === x.name}
                          onClick={() => {
                            const o = prompt(`"${x.name}" is a developer machine. Who owns it? (person, e.g. philip)`);
                            if (o && o.trim()) save(x.name, "dev", o.trim(), "");
                          }}
                        >
                          as dev
                        </Button>
                        <Button variant="outline" size="sm" disabled={busy === x.name} onClick={() => save(x.name, "app", "", "")}>
                          as app
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Registry</CardTitle>
          <CardDescription>
            {regd.length} consumer{regd.length === 1 ? "" : "s"}
            {reg && reg.owners.length ? `, ${reg.owners.length} owner(s)` : ""}. Revoke a key with ✕; a consumer with no active key is flagged.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>consumer</TableHead>
                <TableHead>kind</TableHead>
                <TableHead>owner</TableHead>
                <TableHead>keys</TableHead>
                <TableHead>jobs</TableHead>
                <TableHead>calls</TableHead>
                <TableHead>tokens</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {regd.length ? (
                regd.map((c: any) => (
                  <TableRow key={c.name}>
                    <TableCell className="font-mono align-top">
                      <b>{c.name}</b>
                      {c.note && <div className="text-micro text-muted-foreground">{c.note}</div>}
                    </TableCell>
                    <TableCell className="align-top">
                      <KindBadge kind={c.kind} />
                    </TableCell>
                    <TableCell className="font-mono align-top">
                      {c.kind === "dev" ? <span className="text-p-crazyrouter">{c.owner}</span> : <span className="text-muted-foreground" title="an app is not a person">—</span>}
                    </TableCell>
                    <TableCell className="min-w-[150px] align-top">
                      {c.keys
                        .filter((k: any) => !k.revoked)
                        .map((k: any) => (
                          <div key={k.id} className="my-px flex items-center gap-1.5">
                            <Badge variant="secondary" className="font-mono text-muted-foreground" title={"issued " + (k.created ? new Date(k.created).toISOString().slice(0, 10) : "?") + " · last used " + since(k.lastUsed)}>
                              {k.id}
                            </Badge>
                            <span className="text-micro text-muted-foreground">{k.lastUsed ? since(k.lastUsed) : "unused"}</span>
                            <button className="text-muted-foreground hover:text-danger" title="revoke" onClick={() => revokeKey(c.name, k.id)}>
                              ✕
                            </button>
                          </div>
                        ))}
                      {!c.activeKeys && <span className="text-meta text-danger">no key{mode === "required" ? " — 401ing" : ""}</span>}
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground align-top">{c.jobs || 0}</TableCell>
                    <TableCell className="font-mono align-top">{nfmt(c.calls)}</TableCell>
                    <TableCell className="font-mono text-muted-foreground align-top">{nfmt(c.tokens)}</TableCell>
                    <TableCell className="align-top">
                      <div className="flex gap-1.5">
                        <Button variant="outline" size="sm" disabled={busy === c.name} onClick={() => issueKey(c.name)}>
                          New key
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy === c.name} onClick={() => remove(c.name)}>
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={8} className="text-ui text-muted-foreground">
                    No consumers yet. Register one above — that issues its first key.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className={mode !== "required" ? "border-warn/40" : ""}>
        <CardHeader>
          <CardTitle>Access control</CardTitle>
          <CardDescription>Two staged gates. Authentication is the lock (a key); the name gate is a spelling check for keyless callers, redundant once auth is required.</CardDescription>
          <div className="mt-2">
            <Seg value={mode} onChange={setMode} items={[["off", "off"], ["optional", "optional"], ["required", "required"]]} />
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-ui text-muted-foreground">
            <span className="font-mono">off</span> — keys ignored; <span className="font-mono">X-Project</span> is the only identity.
            <br />
            <span className="font-mono">optional</span> — a valid key wins; no key falls back to the header. <b>Migration mode.</b> A key presented and <i>bad</i> is always a 401.
            <br />
            <span className="font-mono">required</span> — no valid key, no service. The only mode where the self-asserted header stops being an identity.
          </p>
          {mode !== "required" && (
            <p className="mt-3 text-body text-warn">
              <b>The inference endpoints are open.</b> Anyone who can reach <span className="font-mono">llm.hostbun.cc</span> can spend the Max subscriptions by naming a registered consumer. Only <span className="font-mono">required</span> closes that.
            </p>
          )}
          {keyless.length > 0 && (
            <p className="mt-2 text-body text-danger">
              <b>{keyless.length} registered consumer(s) hold no key</b> — {keyless.join(", ")}. Switching to <span className="font-mono">required</span> 401s every one of them.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3.5">
            <div>
              <b className="text-body">Name gate</b>{" "}
              <span className="text-ui text-muted-foreground">— refuse an unregistered consumer with <span className="font-mono">403 unknown_consumer</span> (keyless callers only).</span>
              {unreg.length > 0 && (
                <div className="mt-1 text-ui text-danger">
                  <b>{unreg.length} unregistered consumer(s) in the log.</b> {reg && reg.enforcing ? "Refused now." : "Register them before enabling, or their traffic dies."}
                </div>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy === "enforce"}
              className={reg && reg.enforcing ? "text-ok border-ok/50 bg-ok/[0.14]" : ""}
              onClick={() => enforce(!(reg && reg.enforcing))}
            >
              {reg && reg.enforcing ? "● Enforcing" : "Off"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
