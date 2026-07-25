"use client";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHead } from "@/components/panel/primitives";
import { useApp } from "@/components/panel/context";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";

// The inbound gate: the admin password, the obliterated-model token, and where the account tokens
// actually live. Sits beside Consumers because both answer "who may call this router".
export function Access() {
  const { state, reload } = useApp();
  const [v, setV] = useState({ oblit: "", admin: "" });
  async function setSecret(field: string, val: string) {
    if (!val) return notify("enter a value", true);
    try {
      const r: any = await api("config", { method: "POST", body: JSON.stringify({ [field]: val }) });
      reload(r.state);
      notify(field + " updated");
    } catch (e: any) {
      notify(e.message, true);
    }
  }
  async function disableGate() {
    if (!confirm("Disable the gate? Gated models become open to anyone.")) return;
    try {
      const r: any = await api("config", { method: "POST", body: JSON.stringify({ oblitToken: "" }) });
      reload(r.state);
      notify("gate disabled");
    } catch (e: any) {
      notify(e.message, true);
    }
  }
  async function changePw() {
    if (v.admin.length < 3) return notify("min 3 chars", true);
    if (!confirm("Change admin password? You may need to sign in again.")) return;
    try {
      await api("config", { method: "POST", body: JSON.stringify({ adminPassword: v.admin }) });
      setV({ ...v, admin: "" });
      notify("password changed — re-login if prompted");
    } catch (e: any) {
      notify(e.message, true);
    }
  }
  return (
    <div className="space-y-4.5">
      <PageHead
        title="Access"
        desc={
          <>
            Live, file-backed overrides in <span className="font-mono">{state.configFile}</span>. Leaving a field blank keeps the current value.
          </>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Claudecode account tokens ({(state.claudecodeAccountPool || []).length} in pool)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-ui text-muted-foreground">
            Max account tokens live in <span className="font-mono">claudecodeAccountPool</span> inside the config file above, and that is the only
            copy anywhere. They are never returned to this UI. Edit them on the volume, and back it up before touching the app.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Obliterated / uncensored gate</CardTitle>
          <CardDescription>
            Token: <span className="font-mono">{state.oblitTokenSet ? state.oblitTokenMasked : "(open — no gate)"}</span>. When set, a request to a
            gated model needs <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>. Empty means open.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <Input type="password" className="flex-1" placeholder="new gate token" value={v.oblit} onChange={(e) => setV({ ...v, oblit: e.target.value })} />
            <Button variant="outline" size="sm" onClick={() => { setSecret("oblitToken", v.oblit); setV({ ...v, oblit: "" }); }}>
              Update
            </Button>
            <Button variant="destructive" size="sm" onClick={disableGate}>
              Disable gate
            </Button>
          </div>
          <p className="mt-2.5 text-ui text-muted-foreground">Gated upstream model ids are edited on Routing, under Advanced → JSON enforcement.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Admin password</CardTitle>
          <CardDescription>
            Current: <span className="font-mono">{state.adminPasswordMasked}</span>. Changing it signs you out of other sessions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <Input type="password" className="flex-1" placeholder="new admin password (≥3 chars)" value={v.admin} onChange={(e) => setV({ ...v, admin: e.target.value })} />
            <Button variant="destructive" size="sm" onClick={changePw}>
              Change
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
