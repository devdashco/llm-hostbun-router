// Standing up an app in one call, and the warning that fires when one of them can reach opus.
//
//   node test/apps.test.mjs      (also runs in `npm test`)
//
// Two things are checked here and neither is visible from a 200:
//
//   · WHICH ids a tier resolves to. `standard` exists to be the allowlist an app gets without
//     anyone hand-copying twelve model ids, and its one job is to leave the premium claudecode ids
//     out. A tier that quietly includes opus still answers ok:true, still issues a working key, and
//     costs 5-10x on the shared Max pool until someone reads the rule back. The negative assertion
//     (no opus/fable in `standard`) is the whole point of the tier existing.
//   · WHEN the premium watcher fires. It is a DIFF, so the two ways it breaks are both silent: a
//     baseline that is never taken pages about every app on the next restart, and a baseline that
//     swallows the first look never fires at all. Both look like "no alerts" from outside.
//
// The watcher is driven directly rather than over HTTP because a Telegram POST is the only visible
// effect in production, and a test may not send one. watchPremiumApps() returns what it alerted on
// for exactly this reason.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  ok    ${n}`); pass++; };
const bad = (n, why) => { console.log(`  FAIL  ${n}\n        ${why}`); fail++; };
const check = (n, cond, why = "") => (cond ? ok(n) : bad(n, why));

const { CFG } = require_(path.join(ROOT, "src", "config.js"));
const AL = require_(path.join(ROOT, "src", "alert.js"));
const CO = require_(path.join(ROOT, "src", "consumers.js"));

// ── who can reach opus ───────────────────────────────────────────────────────
console.log("premium exposure, per rule shape:");
CFG.consumers = {
  norule: { kind: "app" },                       // registered and never restricted — the accident
  safe: { kind: "app" },                         // an allowlist without a premium id
  opus: { kind: "app" },                         // an allowlist WITH one
  blocked: { kind: "app" },
  pinned: { kind: "app" },                       // pinned to haiku: the pin rewrites every call
  localonly: { kind: "app" },
  human: { kind: "dev", owner: "philip" },       // a person choosing opus is not news
};
CFG.projectRoutes = {
  safe: { allowModels: ["claude-haiku-4-5", "claude-sonnet-5"] },
  opus: { allowModels: ["claude-haiku-4-5", "claude-opus-5"] },
  blocked: { block: true },
  pinned: { provider: "claudecode", model: "claude-haiku-4-5" },
  localonly: { allowProviders: ["local"] },
  human: { allowModels: ["claude-opus-5"] },
};
const prem = AL.premiumApps(CFG);
check("an app with no rule at all is premium-capable", prem.has("norule"), [...prem.keys()].join(","));
check("...and the reason says so, not just 'true'", /no routing rule/.test(prem.get("norule") || ""), prem.get("norule"));
check("an allowlist naming opus is premium-capable", /claude-opus-5/.test(prem.get("opus") || ""), prem.get("opus"));
check("an allowlist without one is NOT", !prem.has("safe"));
check("a blocked project is not (nothing runs)", !prem.has("blocked"));
// A pin REWRITES the model, so no request can reach opus however wide the allowlist is. Reading the
// allowlist before the pin would report every pinned app as premium-capable — noise, and a watcher
// that cries wolf gets muted.
check("a project pinned to haiku is NOT, even with no allowlist", !prem.has("pinned"));
check("allowProviders without claudecode is NOT", !prem.has("localonly"));
check("a DEV consumer is never reported — a person choosing opus is expected", !prem.has("human"));

// ── the diff ─────────────────────────────────────────────────────────────────
console.log("\nthe watcher fires on ADDITIONS only:");
// The first look is the baseline (loadConfig takes it at boot). A restart must not page about the
// apps that were already there.
const first = AL.watchPremiumApps(CFG);
check("the first look is a silent baseline", first.length === 0, JSON.stringify(first));
check("...even though it saw premium apps", prem.size >= 2, String(prem.size));
const noop = AL.watchPremiumApps(CFG);
check("an unchanged config alerts about nothing", noop.length === 0, JSON.stringify(noop));

CFG.consumers.newapp = { kind: "app" };          // registered with no rule — the exact accident
const added = AL.watchPremiumApps(CFG);
check("a newly registered app with no rule ALERTS", added.length === 1 && added[0].name === "newapp", JSON.stringify(added));
const again = AL.watchPremiumApps(CFG);
check("...once, not on every subsequent write", again.length === 0, JSON.stringify(again));

// Widening an existing app's allowlist is the same event through a different door.
CFG.projectRoutes.safe = { allowModels: ["claude-haiku-4-5", "claude-opus-4-8"] };
const widened = AL.watchPremiumApps(CFG);
check("an existing app WIDENED to opus alerts too", widened.length === 1 && widened[0].name === "safe", JSON.stringify(widened));

// ── what a tier resolves to ──────────────────────────────────────────────────
console.log("\ntiers resolve against the live catalogs:");
CFG.claudecodeModels = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5"];
CFG.localMap = { local: "qwen3.5-9b", "qwen3.5-9b": "qwen3.5-9b" };
// Point crazyrouter at a closed port: the catalog fetch must FAIL loudly (a warning the caller can
// read), never hand back a shorter allowlist as though that were the answer.
CFG.bases.crazyrouter = "http://127.0.0.1:1";
const std = await CO.tierModels("standard");
check("standard carries the non-premium claudecode ids", std.models.includes("claude-sonnet-5"), JSON.stringify(std.models));
check("standard EXCLUDES opus", !std.models.includes("claude-opus-5"), JSON.stringify(std.models));
check("standard EXCLUDES fable", !std.models.includes("claude-fable-5"), JSON.stringify(std.models));
check("standard carries the free local ids", std.models.includes("qwen3.5-9b"), JSON.stringify(std.models));
check("an unreachable crazyrouter catalog is REPORTED, not silently dropped", !!std.warning, String(std.warning));
const front = await CO.tierModels("frontier");
check("frontier includes opus", front.models.includes("claude-opus-5"), JSON.stringify(front.models));
check("frontier includes fable", front.models.includes("claude-fable-5"), JSON.stringify(front.models));
const loc = await CO.tierModels("local");
check("local is the GPU ids only", loc.models.includes("qwen3.5-9b") && !loc.models.some((m) => m.startsWith("claude")), JSON.stringify(loc.models));

// ── the endpoint ─────────────────────────────────────────────────────────────
console.log("\nPOST /api/apps:");
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const cfgPath = path.join(os.tmpdir(), `apps-cfg-${process.pid}.json`);
fs.writeFileSync(cfgPath, JSON.stringify({ auth: { mode: "required" }, logging: { enabled: false, content: false } }));
const srv = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), CONFIG_FILE: cfgPath, PRICES_FILE: "/nonexistent.json",
    ADMIN_PASSWORD: "ddash", SESSION_INSECURE: "1", DATABASE_URL: "", PANEL_DIR: "/nonexistent" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => (log += d));
srv.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 100 && !/llm-gateway on/.test(log); i++) await new Promise((r) => setTimeout(r, 100));

try {
  const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "ddash" }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const post = async (body, withCookie = true) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(withCookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  const anon = await post({ name: "x" }, false);
  check("it is behind the admin cookie — creating an app is not a public act", anon.status === 401, String(anon.status));

  const noName = await post({});
  check("a nameless app is a 400", noName.status === 400, JSON.stringify(noName.json));
  const badTier = await post({ name: "x", tier: "cheap" });
  check("an unknown tier is refused and NAMES the tiers", badTier.status === 400 && Array.isArray(badTier.json.tiers),
    JSON.stringify(badTier.json));
  // Validation runs before the registry, so a caller's mistake reads as their mistake even with the
  // database down — the same property the legacy key route has.
  const noDb = await post({ name: "newthing" });
  check("with no database it refuses 503 rather than writing a key that vanishes",
    noDb.status === 503 && /registry unavailable/.test(noDb.json.error || ""), JSON.stringify(noDb.json));
  // ...and the rule it wrote first must not be left behind on that failure.
  const state = await (await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { cookie } })).json();
  check("a failed create leaves no orphan routing rule", !(state.projectRoutes || {}).newthing,
    JSON.stringify(state.projectRoutes));
  check("the alert channel is reported on /api/health", await (async () => {
    const h = await (await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { cookie } })).json();
    return !!(h.alerts && h.alerts.channel);
  })());
} finally {
  srv.kill("SIGKILL");
  try { fs.unlinkSync(cfgPath); } catch { /* gone */ }
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
