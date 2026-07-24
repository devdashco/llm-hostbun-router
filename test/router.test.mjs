// End-to-end test of the two things this router must never get wrong: WHERE a call goes, and
// WHETHER it is allowed to go there. Boots a real server against test/parity-seed.json on a
// throwaway config file, then asserts over the admin API.
//
//   node test/router.test.mjs
//
// No database, no upstream. Anything that calls a provider (health, models, test, probe) is out of
// scope here by design — those are not hermetic, and a test that needs the internet gets disabled.
//
// It was written as an old-vs-new parity harness during the src/ split (32 checks, 0 differences)
// and kept as a regression suite: every expectation below was a real bug or a load-bearing rule.
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "llm-router-test-"));
const CFG = join(TMP, "config.json");
// Ask the OS for a free port rather than picking one: a hardcoded port silently collided with an
// unrelated local service and every assertion "failed" against its 404s.
const PORT = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const BASE = `http://localhost:${PORT}`;

// curl, not fetch: some sandboxes block node's outbound sockets. `-w` appends the status so a
// body-only comparison can never hide a 200-vs-500.
const curl = (args) => {
  try { return execFileSync("curl", ["-s", "-m", "8", "-w", "\n<%{http_code}>", ...args], { encoding: "utf8" }); }
  catch (e) { return `CURL-FAIL ${e.message}`; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

copyFileSync(join(ROOT, "test/parity-seed.json"), CFG);
const server = spawn("node", [join(ROOT, "server.js")], {
  // A two-account pool, pointed at a dead port. The boot catalog sweep therefore fails fast against
  // 127.0.0.1 instead of reaching api.anthropic.com — this suite makes no network calls, and a test
  // that quietly did would spend real tokens on someone's Max plan.
  env: { ...process.env, PORT: String(PORT), CONFIG_FILE: CFG, ADMIN_PASSWORD: "ddash",
         SESSION_INSECURE: "1", PANEL_DIR: join(ROOT, "panel/out"), DATABASE_URL: "",
         ANTHROPIC_BASE: "http://127.0.0.1:1",
         ANTHROPIC_POOL: JSON.stringify([{ name: "acctA", token: "sk-ant-oat-fake-a" }, { name: "acctB", token: "sk-ant-oat-fake-b" }]) },
  stdio: "ignore",
});
process.on("exit", () => server.kill());
await sleep(2500);

// If login fails, every later assertion would compare against a 401 body and quietly "pass" the ones
// that expect an error. Bail loudly instead.
const rawLogin = curl(["-i", "-X", "POST", `${BASE}/api/login`, "-d", '{"password":"ddash"}']);
const cookie = (rawLogin.match(/hb_admin=([^;]+)/) || [])[1] || "";
if (!cookie) { console.error(`harness: login failed, refusing to report passes\n${rawLogin.slice(0, 300)}`); server.kill(); process.exit(2); }
const api = (path, body) => {
  const a = [`${BASE}/api/${path}`, "-H", `cookie: hb_admin=${cookie}`];
  if (body !== undefined) a.push("-X", "POST", "-d", JSON.stringify(body));
  return JSON.parse(curl(a).split("\n<")[0]);
};
const status = (path) => curl(["-o", "/dev/null", `${BASE}${path}`]).trim().replace(/[<>]/g, "");

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}
// A resolve reduced to what we actually care about: which provider, which model, blocked or not.
const route = (model, project) => {
  const r = api("resolve", { model, project });
  return r.blocked ? { blocked: true } : { provider: r.provider, model: r.sentModel };
};

console.log("routing — pins rewrite:");
// A pin on the consumer covers every job under it. `promopilot:generatetext` used to miss the pin
// entirely and fall through to crazyrouter, the only provider that bills per token.
check("promopilot pinned", route("claude-opus-4-8", "promopilot"), { provider: "claudecode", model: "claude-haiku-4-5" });
check("promopilot:job inherits the pin", route("claude-opus-4-8", "promopilot:generatetext"), { provider: "claudecode", model: "claude-haiku-4-5" });
check("unruled project routes normally", route("gemini-2.5-flash", "nobody"), { provider: "crazyrouter", model: "gemini-2.5-flash" });

console.log("routing — allowlists refuse, never substitute:");
check("seoul may use local", route("qwen3.5-9b", "seoul"), { provider: "local", model: "qwen3.5-9b" });
check("seoul may not use claudecode", route("claude-opus-4-8", "seoul"), { blocked: true });
check("seoul:job inherits the allowlist", route("claude-opus-4-8", "seoul:crawl"), { blocked: true });
check("redbut may use an allowed model", route("claude-haiku-4-5", "redbut"), { provider: "claudecode", model: "claude-haiku-4-5" });
check("redbut may not use another", route("claude-opus-4-8", "redbut"), { blocked: true });
check("blocked project is blocked", route("claude-haiku-4-5", "fb-bot"), { blocked: true });

console.log("routing — the paid door stays shut:");
// An image id on a text endpoint used to fall through the whole resolver into crazyrouter and come
// back as their 404 — on our bill.
check("imagegen refused on a text endpoint", route("imagegen", "x"), { blocked: true });
check("sd-turbo refused too", route("sd-turbo", "x"), { blocked: true });

console.log("admin — merge endpoints never clobber siblings:");
const before = Object.keys(api("state").projectRoutes).sort();
api("routes", { project: "acme", allowProviders: ["local"] });
check("POST routes merges", Object.keys(api("state").projectRoutes).sort(), [...before, "acme"].sort());
check("POST routes rejects an unknown provider", api("routes", { project: "acme", allowProviders: ["openai"] }).error, "unknown provider 'openai' in allowProviders");
check("POST routes rejects an empty rule", !!api("routes", { project: "acme2", allowModels: [] }).error, true);
check("POST routes clears", api("routes", { project: "acme", clear: true }).projectRoutes.acme, undefined);
check("POST pins rejects an unknown account", !!api("pins", { project: "acme", account: "nope" }).error, true);

// The registry lives in Postgres, and this suite runs without one. Validation that holds with or
// without a database still answers; anything that would WRITE refuses with 503 rather than saving
// into CFG, living in memory until the next refresh(), and silently vanishing — which is exactly
// what the old CFG-writing endpoints did.
console.log("admin — a consumer is a person's machine or an app, never both:");
check("app may not have an owner", api("consumers", { name: "acme", kind: "app", owner: "bob" }).error, "a project has no owner — it is not a person");
check("dev must have an owner", api("consumers", { name: "acme3", kind: "dev" }).error, "a machine belongs to a developer — developer required");
check("kind must be dev or app", api("consumers", { name: "acme", kind: "robot" }).error, "kind must be 'dev' or 'app'");
check("a job is not a consumer", !!api("consumers", { name: "acme:job", kind: "app" }).error, true);

console.log("admin — a registry write without a DB refuses, it does not pretend:");
check("registering needs the DB", api("consumers", { name: "acme", kind: "app" }).error, "registry unavailable: no database connection");
check("issuing a key needs the DB", api("consumers/keys", { name: "fresh", kind: "app" }).error, "registry unavailable: no database connection");
check("hash never leaves the process", JSON.stringify(api("consumers")).includes('"hash"'), false);

console.log("admin — the gate:");
check("unauthed state is 401", status("/api/state"), "401");
check("bad password is 401", curl(["-o", "/dev/null", "-X", "POST", `${BASE}/api/login`, "-d", '{"password":"no"}']).trim().replace(/[<>]/g, ""), "401");
check("unknown admin endpoint is 404", api("nope").error, "unknown admin endpoint");

console.log("shell routes:");
// The panel is a Next static export (panel/out) built separately (`npm run build:panel`); the image
// builds it in stage 1. If it isn't built locally, skip these rather than fail the router suite.
if (existsSync(join(ROOT, "panel/out/index.html"))) {
  check("root serves the panel", status("/"), "200");
  check("a UI slug serves the panel", status("/routing"), "200");
  check("a consolidated slug serves the panel", status("/identity"), "200");
  check("a legacy slug still serves the panel (client-side redirect)", status("/accounts"), "200");
} else {
  console.log("  skip  panel/out not built — run `npm run build:panel` to exercise shell routes");
}
// The /admin prefix is gone, not redirected. A tombstone 404 rather than a fall-through into the
// model router, which would answer a stale POST /admin/api/login with "model_not_routable".
check("/admin is gone", status("/admin"), "404");
check("/admin/api/* is gone", status("/admin/api/state"), "404");
// Not 404: an unknown path with no model falls into the resolver, which refuses ("no model
// specified; no default route") — a 400. There is no catch-all at the root, by design.
check("an unknown path is refused, not routed", status("/nope"), "400");

// The pool view lists every subscription, its usage-window headroom, and who spends it. These are
// Claude Max logins — there is no per-model "serves" verdict (a 429 is a usage window, not a
// capability). Assert the contract: a row per account, and orphan pins are surfaced.
console.log("accounts — the pool view:");
{
  const a = api("accounts");
  check("every pool account gets a row, traffic or not", a.accounts.map((x) => x.name).sort(), ["acctA", "acctB"]);
  check("summary counts the pool", a.summary.accounts, 2);
  api("pins", { project: "ghostproj", account: "acctA" });
  api("config", { projectAccounts: { ghostproj: "vanished" } });   // simulate an account removed from the pool
  const b = api("accounts");
  check("a pin naming an absent account is reported as orphaned", b.orphanPins, [{ project: "ghostproj", account: "vanished" }]);
  api("config", { projectAccounts: {} });
}

// Creating, labelling with an email, and disabling a pool account — the only create path (POST config
// replaces the pool wholesale and the panel never holds the other tokens).
console.log("accounts — create / email / disable:");
{
  check("a non-oat token is refused",
    !!api("accounts/token", { account: "acctC", token: "nope" }).error, true);
  check("an unknown name creates the account (create-if-absent)", api("accounts/token", { account: "acctC", token: "sk-ant-oat-fake-c", email: "c@mejl.to" }).created, true);
  check("a line-wrapped token is de-whitespaced, not rejected",
    api("accounts/token", { account: "acctD", token: "sk-ant-oat-\n  fake-d" }).created, true);
  api("accounts/remove", { account: "acctD", force: true });
  const withC = api("accounts").accounts.find((x) => x.name === "acctC");
  check("the new account appears in the pool", !!withC, true);
  check("its email is surfaced", withC.email, "c@mejl.to");
  check("it is enabled by default", withC.disabled, false);
  // Disable it, and confirm the pool view flags it and names the pin left stranded.
  api("pins", { project: "cproj", account: "acctC" });
  const dis = api("accounts/disable", { account: "acctC" });
  check("disable reports the stranded pin", dis.stranded, ["cproj"]);
  check("a disabled account is flagged in the pool view", api("accounts").accounts.find((x) => x.name === "acctC").disabled, true);
  check("re-enabling clears the flag", api("accounts/disable", { account: "acctC", disabled: false }).disabled, false);
  // Rotating a token can also carry an email change; "" clears it.
  check("rotate can clear the email", api("accounts/token", { account: "acctC", token: "sk-ant-oat-fake-c2", email: "" }).ok, true);
  check("the email is now cleared", api("accounts").accounts.find((x) => x.name === "acctC").email, null);
  // Clean up so later sections see the original two-account pool + no stray pins.
  api("accounts/remove", { account: "acctC", force: true });
  api("config", { projectAccounts: {} });
}

console.log("config — POST config REPLACES projectRoutes (documented, load-bearing):");
api("config", { projectRoutes: { z: { provider: "local", model: "qwen3.5-9b", allowModels: ["qwen3.5-9b"] } } });
check("siblings are gone", Object.keys(api("state").projectRoutes), ["z"]);
check("the survivor still routes", route("qwen3.5-9b", "z"), { provider: "local", model: "qwen3.5-9b" });
// The allowlist judges the model that will actually be SENT, not the one the caller asked for. `z`
// pins every request to qwen3.5-9b, so asking for haiku is rewritten and then passes its own
// allowlist. Checking the requested id instead would make a pin and an allowlist contradict each
// other on every request.
check("the pin is applied before the allowlist judges it", route("claude-haiku-4-5", "z"), { provider: "local", model: "qwen3.5-9b" });
// Every module holds one CFG reference. Reassigning it instead of swapping its contents is why the
// panel could save, report success, and change nothing.
check("a config write is visible to the router", api("state").projectRoutes.z.provider, "local");

// ── account strategy: soonest-weekly-reset ──────────────────────────────────
// HTTP surface against the subprocess first, then the picker in-process: it orders on ACCT_CACHE
// weekly readings, which only live traffic or a DB can seed — neither exists in the subprocess, so
// requiring src/ directly is the only hermetic way to feed it data.
console.log("account strategy — the opt-in weekly-reset picker:");
check("default strategy is pinned", api("state").accountStrategy, "pinned");
check("a bad mode is refused", api("claudecode/strategy", { mode: "round-robin" }).error, "mode must be pinned | soonest-weekly-reset");
{
  const r = api("claudecode/strategy", { mode: "soonest-weekly-reset" });
  check("flipping the strategy answers with the pick", [r.ok, r.mode, r.autoAccount], [true, "soonest-weekly-reset", null]); // no readings → null
  check("the flip is visible in state", api("state").accountStrategy, "soonest-weekly-reset");
  api("claudecode/strategy", { mode: "pinned" });
}

{
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const { CFG } = req(join(ROOT, "src/config.js"));
  const { ACCT_CACHE, ACCT_DEAD, ORG_OF_ACCOUNT } = req(join(ROOT, "src/db.js"));
  const { accountFor } = req(join(ROOT, "src/routing.js"));
  const now = Math.floor(Date.now() / 1000);
  const reading = (o) => ({ u5: 0.1, u7: 0.1, reset5: now + 3600, reset7: now + 86400, s5: "allowed", s7: "allowed", ts: Date.now(), ...o });
  CFG.claudecodeAccountPool = [{ name: "early", org: "org-early", token: "x" },
                               { name: "late", org: "org-late", token: "x" },
                               { name: "spent", org: "org-spent", token: "x" }];
  CFG.projectAccounts = { someapp: "late", somedev: "late" };
  CFG.consumers = { someapp: { kind: "app", keys: [] }, somedev: { kind: "dev", owner: "p", keys: [] } };
  CFG.defaultAccount = "";
  CFG.accountStrategy = "soonest-weekly-reset";
  for (const n of ["early", "late", "spent"]) ORG_OF_ACCOUNT.set(n, "org-" + n);

  // No readings at all → never hop blind: the pin decides, exactly as before.
  check("no weekly reading anywhere → the pin decides", accountFor("someapp").name, "late");

  ACCT_CACHE.set("org-early", reading({ u5: 0.5, u7: 0.5 }));
  ACCT_CACHE.set("org-late",  reading({ reset7: now + 6 * 86400 }));
  ACCT_CACHE.set("org-spent", reading({ u7: 1, s7: "rejected", reset7: now + 1800 }));
  // `spent` resets soonest but its weekly is rejected; `early` is the soonest USABLE reset.
  check("an app gets the soonest usable weekly reset", accountFor("someapp").name, "early");
  check("a job inherits its consumer's auto pick", accountFor("someapp:worker").name, "early");
  check("a dev keeps its pin — a human's session never hops", accountFor("somedev").name, "late");
  // A currently-spent 5h window disqualifies until it rolls.
  ACCT_CACHE.set("org-early", reading({ u5: 1, s5: "rejected", u7: 0.5 }));
  check("a spent 5h window is skipped until it rolls", accountFor("someapp").name, "late");
  // A dead login is never a candidate, whatever its reset says.
  ACCT_CACHE.set("org-early", reading({}));
  ACCT_DEAD.add("early");
  check("a dead login (OAuth disabled) is never picked", accountFor("someapp").name, "late");
  ACCT_DEAD.delete("early");
  // reset7 in the past = the window rolled and the reading is stale — not a candidate.
  ACCT_CACHE.set("org-early", reading({ reset7: now - 60 }));
  check("a rolled-over reading is stale, not a candidate", accountFor("someapp").name, "late");
  // ── "use whatever account is available": a dead/spent PIN must not break the app ──
  // Reset to a clean slate: no readings anywhere, so Tier A (soonest weekly reset) is empty and the
  // Tier-B availability fallback is what's under test.
  CFG.accountStrategy = "soonest-weekly-reset";
  ACCT_DEAD.clear();
  for (const n of ["early", "late", "spent"]) ACCT_CACHE.delete("org-" + n);
  // Pin usable, no readings → keep the pin (stable, never hop blind).
  check("a usable pin is kept when nothing is orderable", accountFor("someapp").name, "late");
  // Pin's login is DEAD → serve from the first AVAILABLE account instead of 403'ing the app.
  ACCT_DEAD.add("late");
  check("a dead pin falls to an available account", accountFor("someapp").name, "early");
  // Pin's weekly window is SPENT → same: use whatever is available.
  ACCT_DEAD.clear();
  ACCT_CACHE.set("org-late", reading({ u7: 1, s7: "rejected" }));
  check("a spent pin falls to an available account", accountFor("someapp").name, "early");
  // EVERY account dead/spent → fall to the pin so the caller gets ITS own 429/403, never a guess.
  ACCT_DEAD.add("early"); ACCT_DEAD.add("spent");
  check("nothing available → the pin, so the truth (429/403) reaches the caller", accountFor("someapp").name, "late");
  ACCT_DEAD.clear();
  for (const n of ["early", "late", "spent"]) ACCT_CACHE.delete("org-" + n);
  // A dev is still never swept into the availability fallback — a human's session stays put.
  ACCT_DEAD.add("late");
  check("a dev keeps its (even dead) pin — never auto-hopped", accountFor("somedev").name, "late");
  ACCT_DEAD.clear();

  // ── post-429 cooldown: a real 429 benches the auto-pick so the app's NEXT request hops off it ──
  // A 429 carries no ratelimit headers, so the harvest can't mark the account spent; the cooldown is
  // what makes autoAccount stop re-picking a dry account and route to an available one instead.
  const { noteAcctCooldown, acctCooling, clearAcctCooldown } = req(join(ROOT, "src/routing.js"));
  ACCT_CACHE.set("org-early", reading({ reset7: now + 86400 }));       // soonest weekly reset, usable
  ACCT_CACHE.set("org-late",  reading({ reset7: now + 3 * 86400 }));   // later, usable
  ACCT_CACHE.set("org-spent", reading({ reset7: now + 5 * 86400 }));   // latest, usable
  check("auto picks the soonest usable weekly reset", accountFor("someapp").name, "early");
  noteAcctCooldown("early");                                            // a real 429 just benched it
  check("a 429-cooled account reads as cooling", acctCooling("early", Date.now()), true);
  check("the app hops to the next available account after a 429", accountFor("someapp").name, "late");
  check("a dev is untouched by app-side cooldown (keeps its pin)", accountFor("somedev").name, "late");
  clearAcctCooldown("early");
  check("clearing the cooldown restores the account", accountFor("someapp").name, "early");
  for (const n of ["early", "late", "spent"]) ACCT_CACHE.delete("org-" + n);

  // Strategy off → the invariant, untouched.
  CFG.accountStrategy = "pinned";
  ACCT_CACHE.set("org-early", reading({}));
  check("strategy pinned → the pin, always", accountFor("someapp").name, "late");

  // A disabled account is never served, even as an explicit pin: accountFor returns null so the
  // caller gets 403 no_account_for_project (re-pin), never a request to a dead subscription.
  CFG.claudecodeAccountPool = CFG.claudecodeAccountPool.map((a) => a.name === "late" ? { ...a, disabled: true } : a);
  check("a disabled pin resolves to no account (403 path)", accountFor("someapp"), null);
  CFG.claudecodeAccountPool = CFG.claudecodeAccountPool.map((a) => { const { disabled, ...rest } = a; return rest; });
  check("re-enabling the pin serves it again", accountFor("someapp").name, "late");

  // autoDisableAccount: a 403 permission_error persistently disables the login and reports the pins
  // it stranded. Idempotent, and it does NOT auto-re-enable.
  const { autoDisableAccount } = req(join(ROOT, "src/routing.js"));
  const stranded = autoDisableAccount("late", "test");
  check("auto-disable reports the stranded pins", stranded, ["someapp", "somedev"]);
  check("auto-disable sets the persistent flag", CFG.claudecodeAccountPool.find((a) => a.name === "late").disabled, true);
  check("auto-disable is idempotent (already disabled → null)", autoDisableAccount("late", "test"), null);
  check("an auto-disabled pin now resolves to no account", accountFor("someapp"), null);
  CFG.claudecodeAccountPool = CFG.claudecodeAccountPool.map((a) => { const { disabled, ...rest } = a; return rest; });
}

{
  // ── model cost + premium-tier catalog (pure; no server) ──────────────────────
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const { isPremiumModel, modelTier, unpricedModels, listCostUsd } = req(join(ROOT, "src/pricing.js"));
  const { CLAUDECODE_MODEL_SEED, CLAUDECODE_MODEL_ALIASES } = req(join(ROOT, "src/config.js"));
  // Every advertised model MUST have a token cost + tier defined — a new Anthropic id shipped without a
  // price fails the build HERE rather than silently reading as $0 / no-tier in the stats.
  check("every advertised claudecode model has a token cost", unpricedModels([...CLAUDECODE_MODEL_SEED, ...CLAUDECODE_MODEL_ALIASES]), []);
  // Only opus/fable classify "premium" — the warning trigger.
  check("opus is premium", isPremiumModel("claude-opus-4-8"), true);
  check("fable is premium", isPremiumModel("claude-fable-5"), true);
  check("sonnet is not premium", isPremiumModel("claude-sonnet-5"), false);
  check("haiku is not premium", isPremiumModel("claude-haiku-4-5"), false);
  check("a non-claude id has no tier (never premium)", isPremiumModel("gemini-3.1-flash-lite"), false);
  check("an unlisted opus variant still reads premium (prefix fallback)", isPremiumModel("claude-opus-9-9"), true);
  check("modelTier reads the tier", modelTier("claude-sonnet-4-6"), "sonnet");
  check("a priced model has a non-zero list cost", listCostUsd("claude-opus-4-8", 1e6, 1e6) > 0, true);
  check("an unknown model list cost is 0 (no guess)", listCostUsd("gemini-x", 1e6, 1e6), 0);
}

server.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
