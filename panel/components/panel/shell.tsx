"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutGrid, List, Route, Users, Lock, Menu } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Ctx } from "@/components/panel/context";
import { CallDrawer } from "@/components/panel/call-drawer";
import { ErrorBoundary } from "@/components/panel/error-boundary";
import { api, setOnUnauth } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { name: "Overview", slug: "overview", Icon: LayoutGrid },
  { name: "Calls", slug: "calls", Icon: List },
  { name: "Routing", slug: "routing", Icon: Route },
  { name: "Identity", slug: "identity", Icon: Users },
  { name: "Settings", slug: "settings", Icon: Lock },
];

function Sidebar({ active }: { active: string }) {
  return (
    <nav className="flex flex-1 flex-col gap-px">
      {NAV.map(({ name, slug, Icon }) => (
        <Link
          key={slug}
          href={`/${slug}/`}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-body font-medium transition-colors",
            active === slug
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground",
          )}
        >
          <Icon
            className={cn("size-4 shrink-0", active === slug ? "text-p-crazyrouter" : "text-muted-foreground/70")}
          />
          <span>{name}</span>
        </Link>
      ))}
    </nav>
  );
}

function Shell({ active, children }: { active: string; children: React.ReactNode }) {
  const [sbOpen, setSbOpen] = useState(false);
  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-[248px_minmax(0,1fr)]">
      <aside
        className={cn(
          "flex h-screen flex-col border-r border-border bg-sidebar px-3 pb-3 pt-4",
          "sticky top-0 self-start max-md:fixed max-md:z-50 max-md:w-[248px] max-md:transition-transform",
          sbOpen ? "max-md:translate-x-0" : "max-md:-translate-x-[101%]",
        )}
      >
        <div className="flex items-center gap-2.5 px-1.5 pb-4">
          <div className="grid size-[30px] place-items-center rounded-lg bg-primary text-ui font-bold text-primary-foreground">
            hb
          </div>
          <div>
            <div className="text-body font-semibold leading-tight">hostbun</div>
            <div className="text-meta leading-tight text-muted-foreground/80">
              llm router · control panel
            </div>
          </div>
        </div>
        <Sidebar active={active} />
        <div className="mt-2 border-t border-border pt-2.5">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={async () => {
              try {
                await api("logout", { method: "POST" });
              } catch {
                /* ignore */
              }
              location.reload();
            }}
          >
            Sign out
          </Button>
        </div>
      </aside>
      {sbOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={() => setSbOpen(false)} />
      )}
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-2.5 border-b border-border bg-background/80 px-3.5 py-2.5 backdrop-blur md:hidden">
          <Button variant="outline" size="sm" onClick={() => setSbOpen(!sbOpen)} aria-label="menu">
            <Menu className="size-4" />
          </Button>
          <h3 className="text-sm font-semibold capitalize">{active}</h3>
        </header>
        <div className="mx-auto w-full max-w-[1200px] px-4 pb-24 pt-5 md:px-7 md:pt-7">
          <ErrorBoundary>{children}</ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="p-10 text-center text-muted-foreground">{children}</div>;
}

function Login({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const submit = async () => {
    setErr("");
    try {
      await api("login", { method: "POST", body: JSON.stringify({ password: pw }) });
      onOk();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <div className="mx-auto mt-[16vh] max-w-[340px] text-center">
      <div className="mb-3.5 flex justify-center">
        <div className="grid size-[30px] place-items-center rounded-lg bg-primary text-ui font-bold text-primary-foreground">
          hb
        </div>
      </div>
      <h1 className="text-lg font-semibold">llm.hostbun.cc</h1>
      <p className="mb-5 mt-1.5 text-body text-muted-foreground">
        Control panel for the router. Every model call we make goes through it.
      </p>
      <div className="rounded-xl border border-border bg-card p-5 text-left">
        <label htmlFor="pw" className="mb-1.5 block text-ui text-muted-foreground">
          Password
        </label>
        <Input
          id="pw"
          type="password"
          placeholder="••••••"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <div className="h-3" />
        <Button className="w-full" onClick={submit}>
          Sign in
        </Button>
        {err && <p className="mt-3 text-body text-danger">{err}</p>}
      </div>
    </div>
  );
}

// The gate: boot by probing /api/state (401 → <Login/>), then provide app context + shell + the
// single call drawer. Port of admin/ui/app.js's App root.
export function PanelGate({ active, children }: { active: string; children: React.ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [state, setState] = useState<any>(null);
  const [callId, setCallId] = useState<number | null>(null);
  const router = useRouter();

  const boot = useCallback(async () => {
    try {
      const s = await api("state");
      setState(s);
      setAuthed(true);
    } catch {
      setAuthed(false);
    }
  }, []);
  useEffect(() => {
    setOnUnauth(() => setAuthed(false));
    boot();
  }, [boot]);

  const reload = useCallback(
    (s?: any) => {
      if (s) setState(s);
      else return boot();
    },
    [boot],
  );
  const gotoCalls = useCallback(
    (params: Record<string, string | undefined>) => {
      const u = new URLSearchParams();
      Object.entries(params || {}).forEach(([k, v]) => {
        if (v) u.set(k, String(v));
      });
      const qs = u.toString();
      router.push("/calls/" + (qs ? "?" + qs : ""));
    },
    [router],
  );
  const go = useCallback(
    (slug: string, tab?: string) => router.push(`/${slug}/` + (tab ? `?t=${tab}` : "")),
    [router],
  );

  return (
    <>
      {/* theme="dark" is load-bearing: the ui/sonner primitive reads next-themes, and this app has
          no ThemeProvider (it forces .dark on <html> instead), so useTheme() falls back to "system"
          and toasts render light on a light-mode OS. Overriding here beats editing the primitive. */}
      <Toaster theme="dark" richColors position="bottom-center" />
      {authed === null ? (
        <Centered>…</Centered>
      ) : !authed ? (
        <Login onOk={boot} />
      ) : !state ? (
        <Centered>loading…</Centered>
      ) : (
        <Ctx.Provider value={{ state, reload, openCall: setCallId, gotoCalls, go }}>
          <Shell active={active}>{children}</Shell>
          <CallDrawer id={callId} onClose={() => setCallId(null)} />
        </Ctx.Provider>
      )}
    </>
  );
}
