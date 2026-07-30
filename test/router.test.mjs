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
const CFG_PATH = CFG;   // alias: `CFG` is shadowed inside the in-process blocks below
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
let cookie = (rawLogin.match(/hb_admin=([^;]+)/) || [])[1] || "";
if (!cookie) { console.error(`harness: login failed, refusing to report passes\n${rawLogin.slice(0, 300)}`); server.kill(); process.exit(2); }
const api = (path, body) => {
  const a = [`${BASE}/api/${path}`, "-H", `cookie: hb_admin=${cookie}`];
  if (body !== undefined) a.push("-X", "POST", "-d", JSON.stringify(body));
  return JSON.parse(curl(a).split("\n<")[0]);
};
const status = (path) => curl(["-o", "/dev/null", `${BASE}${path}`]).trim().replace(/[<>]/g, "");

let pass = 0, fail = 0;
// Set by the reset block at the bottom of this file, which unlinks CONFIG_FILE and reverts CFG to
// envDefaults(). Every assertion above it reads a fixture that no longer exists afterwards, so a
// case appended below would run against a blank router and either pass vacuously or fail for a
// reason that has nothing to do with what it is testing. The ordering was a comment; now it trips.
let fixtureDestroyed = false;
let revokedCookie = "";
function check(label, actual, expected) {
  if (fixtureDestroyed) {
    fail++;
    console.log(`  FAIL  ${label}\n        this ran AFTER the reset block, which wipes the fixture.` +
                "\n        Move it above `POST /api/reset` — everything below that point sees a blank config.");
    return;
  }
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
// Every id the image service advertises has to be here, or the one that is missing is the one that
// reaches crazyrouter. `sdxl-lightning` is what it actually loads (SDXL 1.0 + the 8-step Lightning
// LoRA); it was added to /v1/models on 2026-07-27 and must stay barred alongside the other two.
check("sdxl-lightning refused too", route("sdxl-lightning", "x"), { blocked: true });

console.log("admin — the alias routes:");
// consumers/alias and registry/alias fold a legacy caller name onto its canonical consumer. Both
// write the registry, so both must REFUSE without a DB rather than write CFG — the same rule as
// key issuance. Driven here rather than in wire.test.mjs: 503 is the CORRECT answer, and that suite
// treats any 5xx as the router breaking.
{
  // `{from, to}` — the field names the route actually reads. These used to send {alias, consumer},
  // so `from` was undefined and the 503 came from requireDb() firing before any alias logic ran:
  // green, but not for the reason the label claims. Now that validation is hoisted above the DB
  // gate, a malformed body answers "from required" and this reads the real path.
  check("consumers/alias needs the DB",
    api("consumers/alias", { from: "old-name", to: "acme" }).error, "registry unavailable: no database connection");
  check("registry/alias needs the DB",
    api("registry/alias", { from: "old-name", to: "acme" }).error, "registry unavailable: no database connection");
}

console.log("admin — minting and revoking credentials:");
// registry/keys mints an sk-llm-; both revoke routes destroy one. A key that authenticates until
// the next registry write and then silently vanishes is not hypothetical here — it is what the
// legacy CFG-writing path did (reproduced 2026-07-10, fixed in c385a5e). The rule that came out of
// that is: a registry write with no DB REFUSES. None of these three routes was covered until now.
{
  const issued = api("registry/keys", { name: "brand-new-consumer", kind: "app" });
  check("minting a key needs the DB", issued.error, "registry unavailable: no database connection");
  check("...and hands back no secret to store", issued.key, undefined);
  check("revoking via the registry route needs the DB",
    api("registry/keys/revoke", { name: "acme", id: "deadbeef" }).error, "registry unavailable: no database connection");
  check("revoking via the consumers route needs the DB",
    api("consumers/keys/revoke", { name: "acme", id: "deadbeef" }).error, "registry unavailable: no database connection");
  // Validation still answers without a DB — a caller's error should be about their request, not our
  // infrastructure. This is the line that keeps "refuses" from degrading into "always 503".
  check("a mint with no name is a validation error, not a DB error",
    /name/i.test(api("registry/keys", { kind: "app" }).error || ""), true);
}

// A malformed request must report ITSELF, not our infrastructure. Every one of these runs with no
// DB, so a `503 registry unavailable` here would tell a caller to come back later about a request
// that was wrong no matter what the database was doing. addConsumer already ordered its checks this
// way and said why in a comment; the other seven writers did not.
console.log("admin — validation answers before the database is demanded:");
{
  const noDbMsg = "registry unavailable: no database connection";
  const cases = [
    ["developers",          {},                          "name required"],
    ["consumers/keys/revoke", { name: "", id: "x" },      "name required"],
    ["consumers/keys/revoke", { name: "acme", id: "" },   "key id required"],
    ["consumers/policy",    { name: "" },                 "valid consumer name required"],
    ["consumers/purge",     {},                           "name required"],
    ["registry/alias",      {},                           "from required"],
  ];
  for (const [route, body, want] of cases) {
    // The whole point: with no DB, the answer must be the VALIDATION error, never noDbMsg.
    const got = api(route, body).error;
    check(`${route} says "${want}", not "${noDbMsg}"`, got, want);
  }
}

console.log("admin — the destructive routes, with no database to destroy:");
// calls/clear wipes the call log; consumers/purge deletes an unregistered caller's history. Neither
// had a test until 2026-07-26, which is the wrong way round — the read-only routes were covered
// because they were the easy ones. This harness runs with DATABASE_URL="", so driving them destroys
// nothing; what that exercises is the more interesting half anyway, which is how each behaves when
// it CANNOT do the thing it was asked to do.
{
  // clear must not answer a bare {ok:true}. With no DB it wiped nothing, and an operator reading
  // "ok" would believe otherwise — the same "report the no-op as success" failure as an unpriced
  // model costing $0. dbReady:false is the part that makes `ok` honest.
  const cleared = api("calls/clear", {});
  check("clear with no DB still says ok", cleared.ok, true);
  check("...but declares it cleared nothing", cleared.dbReady, false);

  // purge must REFUSE, not report `deleted: 0`. "I deleted nothing" and "I could not reach the
  // database" are different answers and the caller has to be able to tell them apart.
  const purged = api("consumers/purge", { name: "some-unregistered-name" });
  check("purge with no DB refuses", purged.error, "registry unavailable: no database connection");
  check("...and does not claim a deletion count", purged.deleted, undefined);
}

console.log("admin — the switch that decides whether anyone needs a key:");
// POST /api/auth flips auth.mode. It is the single most consequential toggle in the control plane —
// `required` is what makes an API key mean anything, and `off` opens every inference endpoint to
// whoever can reach the host — and it had NO test until 2026-07-26. It is deliberately separate
// from POST /api/config so the change is an explicit, logged act; nothing checked that separation
// held, or that a nonsense mode was refused rather than stored.
{
  const before = api("state").authMode;
  check("a nonsense mode is refused", api("auth", { mode: "sometimes" }).error, "mode must be off | optional | required");
  check("...and the live mode is unchanged by the refusal", api("state").authMode, before);
  check("a valid mode is accepted", api("auth", { mode: "required" }).mode, "required");
  check("...and is what the router now reports", api("state").authMode, "required");
  // `off` must remain reachable: it is the documented escape hatch when the registry is unseeded,
  // and a gate you cannot open is as much an outage as one you cannot close.
  check("`off` is still settable", api("auth", { mode: "off" }).ok, true);
  // The gate must follow the ROUTE, not the URL spelling. `isInference` was a regex over the path
  // suffix (chat/completions|responses|completions|messages|chat) while dispatch resolves purely on
  // the body's `model` — so a POST to any other path carrying a real model id skipped the key check,
  // the UA lock, the project rules and the usage limits, and was proxied to a paid provider with the
  // router's own crazyrouter key attached. Verified by boot-and-probe before this check was written:
  // /v1/chat/completions answered 401 while /v1/embeddings went through.
  // Assert the REASON, not the status: a bare 401 also comes back from unrelated paths in this
  // harness, so `=== "401"` here passed with the bug still in place — the assertion-that-cannot-fail
  // this suite keeps producing. `invalid_api_key` is emitted only by keyFail(), i.e. only by the
  // gate itself.
  api("auth", { mode: "required" });
  const refusal = (p) => {
    const out = curl(["-m", "4", "-X", "POST", `${BASE}${p}`,
      "-H", "content-type: application/json", "-d", '{"model":"gemini-2.5-flash","input":"hi"}']);
    const [body, code] = out.split("\n<");
    let why = "(no json)";
    try { why = JSON.parse(body).error.code; } catch { /* not the gate's body */ }
    return `${code.replace(/[<>]/g, "")} ${why}`;
  };
  check("no key on the canonical inference path is refused BY THE KEY GATE",
    refusal("/v1/chat/completions"), "401 invalid_api_key");
  check("no key on a path OUTSIDE the old regex is refused by the same gate",
    refusal("/v1/embeddings"), "401 invalid_api_key");
  check("...on any unlisted path that still carries a model", refusal("/v1/rerank"), "401 invalid_api_key");
  // A credential meant for another backend must not be reported as "no key" — that sends whoever is
  // debugging to the wrong side of the wire, which is exactly what happened with the OTel ingest.
  const foreign = curl(["-m", "4", "-X", "POST", `${BASE}/v1/chat/completions`,
    "-H", "content-type: application/json", "-H", "authorization: Bearer 3b1c3830-dead-beef-0000-000000000000",
    "-d", '{"model":"gemini-2.5-flash","messages":[]}']).split("\n<")[0];
  check("a foreign credential is refused as NOT OURS, not as none-sent",
    /not one of ours/.test(foreign), true);
  check("...and the credential is never echoed back", /3b1c3830-dead/.test(foreign), false);
  api("auth", { mode: before || "optional" });                 // leave the harness as we found it
  check("the mode was restored for the rest of this suite", api("state").authMode, before);
}

console.log("admin — the one endpoint that returns a live secret:")
// /api/reveal hands back a raw sk-ant-oat so a direct-mode box can resync after a rotation. It had
// NO coverage until 2026-07-26, and it moved to src/accounts.js that day — a broken dispatch
// binding or a slipped auth gate on this route leaks a Max subscription token, silently.
{
  const raw = (path, body, withCookie) => {
    const a = [`${BASE}/api/${path}`, "-X", "POST", "-d", JSON.stringify(body)];
    if (withCookie) a.push("-H", `cookie: hb_admin=${cookie}`);
    const out = curl(a);
    const [text, code] = out.split("\n<");
    return { code: (code || "").replace(/[<>]/g, ""), text };
  };
  const authed = raw("reveal", { account: "acctA" }, true);
  check("an authed reveal returns the account's real token", JSON.parse(authed.text).token, "sk-ant-oat-fake-a");
  const anon = raw("reveal", { account: "acctA" }, false);
  check("an UNAUTHENTICATED reveal is refused", anon.code, "401");
  check("...and leaks no token in the body", /sk-ant-oat/.test(anon.text), false);
  check("an unknown account is a 400, not a 500", raw("reveal", { account: "nope" }, true).code, "400");
}

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
// The seed gives `promopilot` a real key row, so there IS a hash in CFG to leak. Without one this
// check passed with the redaction in src/consumers.js deleted outright — nothing to redact.
{
  const listed = api("consumers");
  const all = [].concat(listed.registered || [], listed.consumers || [], Array.isArray(listed) ? listed : []);
  const pp = all.find((c) => c && c.name === "promopilot") || null;
  check("the consumer holding a key is listed at all", !!pp, true);
  check("...and reports it has one", JSON.stringify(pp || {}).includes("eeee5555"), true);
  check("hash never leaves the process", JSON.stringify(listed).includes('"hash"'), false);
  check("...nor does the hash VALUE under another name", JSON.stringify(listed).includes("9f1a0000"), false);
}

console.log("admin — the gate:");
check("unauthed state is 401", status("/api/state"), "401");
check("bad password is 401", curl(["-o", "/dev/null", "-X", "POST", `${BASE}/api/login`, "-d", '{"password":"no"}']).trim().replace(/[<>]/g, ""), "401");
check("unknown admin endpoint is 404", api("nope").error, "unknown admin endpoint");
// /api/pricing was exempted from the admin gate as "public" while no such route existed, so the
// path fell through to the MODEL ROUTER: prod answered `model_not_routable: no model specified` and
// logged it as blocked traffic. An unknown /api path must be answered by the admin dispatcher —
// like /admin/*, the point is that it never reaches the router that bills people.
check("/api/pricing is not routed as inference", api("pricing").error, "unknown admin endpoint");
check("...and says nothing about models", /model/.test(JSON.stringify(api("pricing"))), false);

console.log("shell routes:");
// The panel is a Next static export (panel/out) built separately (`npm run build:panel`); the image
// builds it in stage 1. If it isn't built locally, skip these rather than fail the router suite.
if (existsSync(join(ROOT, "panel/out/index.html"))) {
  check("root serves the panel", status("/"), "200");
  check("a UI slug serves the panel", status("/routing"), "200");
  check("a consolidated slug serves the panel", status("/consumers"), "200");
  check("the renamed provider page serves the panel", status("/providers"), "200");
  check("a legacy slug still serves the panel (client-side redirect)", status("/accounts"), "200");
  check("a renamed-away slug still serves the panel", status("/identity"), "200");
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

console.log("config — every base the panel offers is a base this handler accepts:");
// The panel renders an editable base URL per provider and posts all three in one `bases` object.
// The handler read `local` and `crazyrouter` and dropped `claudecode`, answering {ok:true,
// persisted:true} — a save that reports success, changes nothing, and reverts on the next state
// load. A save that lies is worse than a save that refuses.
{
  const before = api("state").bases || {};
  const r = api("config", { bases: { ...before, claudecode: "http://127.0.0.1:1/pinned" } });
  check("the save reports ok", !!r.ok, true);
  check("...and the claudecode base actually changed", (api("state").bases || {}).claudecode, "http://127.0.0.1:1/pinned");
  check("...without disturbing the others", (api("state").bases || {}).local, before.local);
  // `anthropic` is the pre-rename spelling and still arrives from older callers and config files.
  api("config", { bases: { anthropic: "http://127.0.0.1:1/legacy" } });
  check("the legacy `anthropic` spelling lands on claudecode too",
    (api("state").bases || {}).claudecode, "http://127.0.0.1:1/legacy");
  api("config", { bases: before });                       // leave the harness as we found it
  check("the base was restored for the rest of this suite", (api("state").bases || {}).claudecode, before.claudecode);
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

// Malformed JSON is ONE answer on every control-plane route. Nineteen hand-rolled copies of the
// read-and-parse preamble had drifted into four different behaviours, and two of them swallowed the
// error and carried on with an empty object. On claudecode/limits that is not cosmetic: an empty
// body means "no account named", which the handler reads as "refresh them ALL", so a truncated
// payload silently fired a live probe at every subscription in the pool. It must refuse instead.
const rawPost = (path, raw) => {
  const out = curl([`${BASE}/api/${path}`, "-H", `cookie: hb_admin=${cookie}`,
                    "-H", "content-type: application/json", "-X", "POST", "-d", raw]);
  const [bodyText, code] = out.split("\n<");
  return { code: (code || "").replace(/[<>]/g, ""), body: bodyText };
};
{
  const r = rawPost("claudecode/limits", '{"account":');   // truncated — the realistic malformed body
  check("a malformed body is a 400, not a fan-out probe", r.code, "400");
  check("...and says why", JSON.parse(r.body).error, "bad json");
  // An EMPTY body is still valid: several routes are legitimately called with no payload, and
  // conflating "sent nothing" with "sent garbage" is the bug above.
  check("an empty body is still accepted", rawPost("consumers/enforce", "").code, "200");
}
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

  // A disabled login is never contacted for the model catalog either. It is never SERVED
  // (accountFor returns null for a project pinned to it) and its read fails forever — an
  // OAuth-disabled subscription answers 403 on every request — so sweeping it every 6h puts a
  // permanent "could not read the catalog on <name>" warning in the panel about a login nobody
  // expects to work. A warning that always fires is one nobody reads.
  {
    const { fetchAnthropicModels } = req(join(ROOT, "src/claudecode.js"));
    const savedPool = CFG.claudecodeAccountPool, savedFetch = globalThis.fetch;
    // A failed read returns null too, so "it came back null" cannot tell "skipped it" from "tried
    // and failed" — which is the whole change. Count the outbound requests instead: zero is the
    // assertion. (Timing would say the same thing and say it flakily; a refused connection on a
    // dead port is as fast as not dialling at all.)
    let calls = 0;
    globalThis.fetch = (...a) => { calls++; return savedFetch(...a); };
    CFG.claudecodeAccountPool = [{ name: "gone", token: "sk-ant-oat-x", disabled: true }];
    const hit = await fetchAnthropicModels();
    globalThis.fetch = savedFetch;
    check("a pool of only disabled logins yields no catalog", hit, null);
    check("...without contacting any of them", calls, 0);
    CFG.claudecodeAccountPool = savedPool;
  }

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
  // A stale reading (reset7 already in the past) describes a window that no longer exists — u7>=1
  // must NOT bench the account forever. Same reading with reset7 still ahead does bench it.
  ACCT_CACHE.set("org-late", reading({ u7: 1, s7: "rejected", reset7: now - 60 }));
  check("a stale spent-weekly reading (reset7 in the past) doesn't bench the pin", accountFor("someapp").name, "late");
  ACCT_CACHE.set("org-late", reading({ u7: 1, s7: "rejected", reset7: now + 60 }));
  check("the same reading with reset7 still ahead does bench it", accountFor("someapp").name, "early");
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

  // A 429 on an account WITH headroom is a burst limit, not a spent window — bench it for the 60s
  // floor, never to the window reset. Benching a healthy account to reset5 is what emptied the pool on
  // 2026-07-25: the one usable login went dark for hours and every app got 403 no_account_for_project.
  const FAR5 = now + 4 * 3600, FAR7 = now + 5 * 86400;
  ACCT_CACHE.set("org-early", reading({ u5: 0.08, u7: 0.02, reset5: FAR5, reset7: FAR7 }));
  noteAcctCooldown("early");
  check("a 429 with headroom benches only for the short floor, not the window reset",
    acctCooling("early", Date.now() + 61_000), false);
  clearAcctCooldown("early");
  // ...but when the reading says the 5h window IS spent, the bench really does run to reset5.
  ACCT_CACHE.set("org-early", reading({ u5: 1, s5: "rejected", reset5: FAR5, reset7: FAR7 }));
  noteAcctCooldown("early");
  check("a 429 on a spent 5h window benches until reset5", acctCooling("early", Date.now() + 61_000), true);
  clearAcctCooldown("early");
  // A spent WEEKLY window outranks the 5h reset — it is the longer, binding wait.
  ACCT_CACHE.set("org-early", reading({ u7: 1, s7: "rejected", reset5: now + 60, reset7: FAR7 }));
  noteAcctCooldown("early");
  check("a 429 on a spent weekly window benches past the 5h reset",
    acctCooling("early", Date.now() + 3600_000), true);
  clearAcctCooldown("early");
  // Retry-After still wins over the floor when no window is spent.
  ACCT_CACHE.set("org-early", reading({ u5: 0.08, u7: 0.02, reset5: FAR5, reset7: FAR7 }));
  noteAcctCooldown("early", 300);
  check("Retry-After extends the bench even with headroom", acctCooling("early", Date.now() + 61_000), true);
  clearAcctCooldown("early");
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

  // A reading is a snapshot; the window it describes rolls on its own. Past `reset`, "spent"
  // describes a window that no longer exists — so an account whose weekly reset has ALREADY passed
  // must count as usable again, even though its last harvested reading said u7=1/rejected.
  //
  // The weekly branch of acctSpentNow used to skip this check (the 5h branch always had it), which
  // benched the account exactly when `soonest-weekly-reset` had steered work to it *because* it was
  // about to reset. Reproduced before fixing: accountFor returned null — 403 no_account_for_project
  // from an account holding a full week of headroom.
  const { ACCT_CACHE: CACHE, ORG_OF_ACCOUNT: ORGS } = req(join(ROOT, "src/db.js"));
  const nowMs = Date.now();
  const prevStrategy = CFG.accountStrategy, prevPool = CFG.claudecodeAccountPool, prevCons = CFG.consumers;
  CFG.accountStrategy = "soonest-weekly-reset";
  CFG.consumers = { ...(CFG.consumers || {}), rolledapp: { kind: "app" } };
  CFG.claudecodeAccountPool = [{ name: "rolled", token: "sk-ant-oat-fake-r" }];
  ORGS.set("rolled", "org-rolled");
  const acctReadingAt = (reset7Ms) => ({ u5: 0, u7: 1, s5: "allowed", s7: "rejected",
    reset5: Math.floor((nowMs - 7200e3) / 1000), reset7: Math.floor(reset7Ms / 1000), ts: nowMs - 8000e3 });
  CACHE.set("org-rolled", acctReadingAt(nowMs - 3600e3));            // weekly window rolled an hour ago
  check("a spent weekly window past its reset is usable again", (accountFor("rolledapp") || {}).name, "rolled");
  CACHE.set("org-rolled", acctReadingAt(nowMs + 3600e3));            // still an hour to go — genuinely spent
  check("a spent weekly window before its reset is still spent", accountFor("rolledapp"), null);
  CACHE.delete("org-rolled"); ORGS.delete("rolled");
  CFG.accountStrategy = prevStrategy; CFG.claudecodeAccountPool = prevPool; CFG.consumers = prevCons;
}

{
  // ── extractProject accepts a pre-parsed body, and must answer identically either way ─────────
  // server.js parses the body to read `.model`, then extractProject re-parsed the same bytes to
  // look for a project field. On a 340 KB agent transcript that is ~280 µs of duplicate work, and
  // it fires on the NORMAL path: with key-based auth a well-behaved client sends no X-Project
  // header, so the lookup always falls through to the body. The optional third argument shares the
  // parse. These pin the equivalence — including the case that would bite, a non-JSON body where
  // server.js passes null and `null` must not be read as an object nor trigger a re-parse.
  const { createRequire: cr } = await import("node:module");
  const rq2 = cr(import.meta.url);
  const { extractProject: ep } = rq2(join(ROOT, "src/identity.js"));
  const hdrs = (h) => ({ headers: h });
  const bUser = Buffer.from(JSON.stringify({ model: "m", user: "promopilot", messages: [] }));
  const bMeta = Buffer.from(JSON.stringify({ metadata: { project: "redbut" } }));
  check("body `user` fallback (buffer only)", ep(hdrs({}), bUser), "promopilot");
  check("body `user` fallback (pre-parsed)", ep(hdrs({}), bUser, JSON.parse(bUser)), "promopilot");
  check("metadata.project (buffer only)", ep(hdrs({}), bMeta), "redbut");
  check("metadata.project (pre-parsed)", ep(hdrs({}), bMeta, JSON.parse(bMeta)), "redbut");
  check("an X-Project header still beats the body", ep(hdrs({ "x-project": "acme" }), bUser, JSON.parse(bUser)), "acme");
  // Proves the shared parse is actually USED, not just accepted: hand it a parsed object that
  // disagrees with the buffer. If the buffer were re-parsed anyway the answer would be "fromBuffer".
  check("the pre-parsed body is used, the buffer is not re-parsed",
    ep(hdrs({}), Buffer.from(JSON.stringify({ user: "fromBuffer" })), { user: "fromParsed" }), "fromparsed");
  check("a non-JSON body with parsed=null is no project", ep(hdrs({}), Buffer.from("not json"), null), "");
  check("a non-JSON body with no parsed arg is no project", ep(hdrs({}), Buffer.from("not json")), "");
  check("an empty body is no project", ep(hdrs({}), Buffer.alloc(0), null), "");
}

{
  // ── usage limits resolve like every other per-project rule: exact path, then consumer ────────
  // A cap is a property of WHO calls, not of which workload they run. limitFor matched the literal
  // string only, so a cap on `promopilot` never touched `promopilot:generatetext` — and the jobs are
  // where the traffic is. The same trap projectRoutes hit in 2026-07-09, still standing in the one
  // control whose job is to stop an app draining the shared pool.
  const { createRequire } = await import("node:module");
  const rq = createRequire(import.meta.url);
  const { CFG: C2 } = rq(join(ROOT, "src/config.js"));
  const { limitFor: lf, resolveLimit: rl } = rq(join(ROOT, "src/routing.js"));
  const cap = (tokens) => ({ window: "24h", tokens, calls: 0, warnPct: 80, slowPct: 95, hard: "block" });
  const prevLimits = C2.projectLimits, prevDefault = C2.projectLimitDefault;
  C2.projectLimitDefault = { window: "24h", tokens: 0, calls: 0, warnPct: 80, slowPct: 95, hard: "block" };

  C2.projectLimits = { promopilot: cap(1000) };
  check("a cap on the consumer applies to the consumer", (lf("promopilot") || {}).tokens, 1000);
  check("a cap on the consumer applies to its jobs", (lf("promopilot:generatetext") || {}).tokens, 1000);
  // ...and it must METER at that scope too, or three jobs each get the full allowance and the cap
  // is silently 3x what it says.
  check("a consumer-scoped cap meters the whole consumer", rl("promopilot:generatetext").byConsumer, true);
  check("...at the consumer's scope, not the job path", rl("promopilot:generatetext").scope, "promopilot");
  // And the SAME cap must meter the same way when the call arrives with no job suffix at all. This
  // block only ever asked about job paths, so the bare-consumer case went unchecked: it took the
  // exact-match branch, which hard-coded byConsumer:false, and metered a bare `promopilot` call
  // only against traffic that also arrived bare. Same config, same consumer, two buckets, decided
  // by whether the caller sent X-Job — and the cap was bypassable in the spend-more direction.
  check("a bare consumer call meters the whole consumer too", rl("promopilot").byConsumer, true);
  check("...which is the same bucket its jobs are metered in",
    rl("promopilot").scope, rl("promopilot:generatetext").scope);

  // An exact-path entry still wins outright — including an all-zero one, so a single greedy job can
  // be exempted from its consumer's cap. Falling through to the consumer here would make "exempt"
  // unexpressible.
  C2.projectLimits = { promopilot: cap(1000), "promopilot:heavy": cap(50) };
  check("an exact-path cap beats the consumer's", (lf("promopilot:heavy") || {}).tokens, 50);
  check("an exact-path cap meters that path alone", rl("promopilot:heavy").byConsumer, false);
  C2.projectLimits = { promopilot: cap(1000), "promopilot:free": { window: "24h", tokens: 0, calls: 0, warnPct: 80, slowPct: 95, hard: "block" } };
  check("an all-zero exact entry exempts the job from its consumer's cap", lf("promopilot:free"), null);

  // A consumer with no cap of its own is unaffected — no accidental prefix matching.
  C2.projectLimits = { promo: cap(1000) };
  check("a different consumer is not caught by a prefix", lf("promopilot:generatetext"), null);
  C2.projectLimits = prevLimits; C2.projectLimitDefault = prevDefault;
}

{
  // ── model cost + premium-tier catalog (pure; no server) ──────────────────────
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const { isPremiumModel, modelTier, unpricedModels, listCostUsd } = req(join(ROOT, "src/pricing.js"));
  const { CLAUDECODE_MODEL_SEED, CLAUDECODE_MODEL_ALIASES } = req(join(ROOT, "src/config.js"));
  // Every SEEDED/ALIASED model must have a token cost + tier. Note the limit of this check, which
  // its old comment overstated: the live catalog is reconciled against api.anthropic.com at boot
  // and every 6h, so an id Anthropic ships lands in CFG.claudecodeModels and gets served without
  // ever passing through here. `claude-opus-5` did exactly that, in prod, on 2026-07-26. A build
  // gate cannot cover runtime discovery — what covers it is listCostUsd returning null (below),
  // adminState.unpricedModels, and the panel banner that renders both.
  check("every seeded/aliased claudecode model has a token cost", unpricedModels([...CLAUDECODE_MODEL_SEED, ...CLAUDECODE_MODEL_ALIASES]), []);
  // Only opus/fable classify "premium" — the warning trigger.
  check("opus is premium", isPremiumModel("claude-opus-4-8"), true);
  check("fable is premium", isPremiumModel("claude-fable-5"), true);
  check("sonnet is not premium", isPremiumModel("claude-sonnet-5"), false);
  check("haiku is not premium", isPremiumModel("claude-haiku-4-5"), false);
  check("a non-claude id has no tier (never premium)", isPremiumModel("gemini-3.1-flash-lite"), false);
  check("an unlisted opus variant still reads premium (prefix fallback)", isPremiumModel("claude-opus-9-9"), true);
  check("modelTier reads the tier", modelTier("claude-sonnet-4-6"), "sonnet");
  check("a priced model has a non-zero list cost", listCostUsd("claude-opus-4-8", 1e6, 1e6) > 0, true);
  // An unpriced id must read UNKNOWN, never 0. Zero is the claim "this traffic was free", and the
  // ids missing from MODEL_COST are the newest — i.e. the dearest. It made the premium-burn banner
  // announce "claude-opus-5 (opus) — N calls, ~$0.00 list".
  check("an unknown model list cost is null, not 0", listCostUsd("gemini-x", 1e6, 1e6), null);
  check("an unpriced NEW claude id is null too (the real case)", listCostUsd("claude-opus-99", 1e6, 1e6), null);
  check("...while still classifying as premium, so the row is flagged", isPremiumModel("claude-opus-99"), true);

  // Telemetry is fire-and-forget: shipEvent/shipError must never throw (a HyperDX hiccup can't break
  // an inference request). With no HYPERDX_INGEST_API_KEY in the test env, both are silent no-ops.
  const { shipEvent, shipError } = req(join(ROOT, "src/telemetry.js"));
  check("shipEvent/shipError never throw (fire-and-forget)",
    (() => { try { shipEvent("premium", { event: "premium_usage" }); shipError("err", {}); return "ok"; } catch { return "threw"; } })(), "ok");
}

console.log("admin — logout, the last route with no test:");
{
  // A fresh login of its own — reusing the suite-wide `cookie` would mean a broken logout (one that
  // actually revoked something) breaks every check below this block instead of just these five.
  const freshLoginRaw = curl(["-i", "-X", "POST", `${BASE}/api/login`, "-d", '{"password":"ddash"}']);
  const oldCookie = (freshLoginRaw.match(/hb_admin=([^;]+)/) || [])[1] || "";
  check("fresh login for the logout test issued a cookie", oldCookie.length > 0, true);

  const logoutOut = curl([`${BASE}/api/logout`, "-X", "POST", "-H", `cookie: hb_admin=${oldCookie}`]);
  check("logout answers ok", JSON.parse(logoutOut.split("\n<")[0]).ok, true);

  // The clearing header has to be read from a session that is still VALID. This used to log out
  // twice with the same cookie, which worked only while logout was a client-side courtesy: now that
  // it bumps the signing epoch AND sits below the auth gate, the first call kills that cookie and
  // the second is answered 401 with no Set-Cookie at all. Two things landed together and the test
  // was written against neither.
  const secondRaw = curl(["-i", "-X", "POST", `${BASE}/api/login`, "-d", '{"password":"ddash"}']);
  const secondCookie = (secondRaw.match(/hb_admin=([^;]+)/) || [])[1] || "";
  const logoutRaw = curl(["-i", `${BASE}/api/logout`, "-X", "POST", "-H", `cookie: hb_admin=${secondCookie}`]);
  check("logout's Set-Cookie clears the cookie client-side (empty value, Max-Age=0)",
    /hb_admin=;[^\r\n]*Max-Age=0/i.test(logoutRaw), true);
  // And the gate itself: logout revokes every session and writes config to disk, so it must not be
  // reachable without one. Nobody is "logged out" by a request that had no session to begin with.
  const anonLogout = curl(["-o", "/dev/null", "-X", "POST", `${BASE}/api/logout`]).trim().replace(/[<>]/g, "");
  check("an unauthenticated logout is refused, not a free lever on everyone else's session", anonLogout, "401");
  // GET must not do it either: an `<img src=".../api/logout">` on any page the operator visits would
  // otherwise throw them out of the panel.
  const getLogout = curl(["-o", "/dev/null", `${BASE}/api/logout`, "-H", `cookie: hb_admin=${cookie}`]).trim().replace(/[<>]/g, "");
  check("a GET cannot log anyone out", getLogout !== "200", true);

  // BUG, asserted precisely rather than papered over: sessions are a stateless HMAC-signed token
  // (sign() over CFG.adminPassword + an `exp=` payload — see makeSession()/validSession() in
  // src/admin.js). validSession() checks only the signature and the expiry; there is no
  // server-side session store or revocation list for logout to write to. So `POST /api/logout`
  // can only tell the CLIENT to drop the cookie (Max-Age=0) — it cannot invalidate the token
  // itself. Replaying the OLD cookie value after "logout" still authenticates every cookie-gated
  // route, right up to its 7-day expiry.
  const afterLogout = curl([`${BASE}/api/state`, "-H", `cookie: hb_admin=${oldCookie}`]);
  const [, stateStatus] = afterLogout.split("\n<");
  check("the OLD cookie no longer authenticates after logout", stateStatus.replace(/[<>]/g, ""), "401");
  // Logging out must not lock the operator out: a NEW login still works, and it is the same
  // password — the epoch changes the signing key, it does not change the credential.
  const reLoginRaw = curl(["-i", "-X", "POST", `${BASE}/api/login`, "-d", '{"password":"ddash"}']);
  const newCookie = (reLoginRaw.match(/hb_admin=([^;]+)/) || [])[1] || "";
  check("logging in again after a logout still works", newCookie.length > 0, true);
  check("...and the new cookie authenticates",
    curl([`${BASE}/api/state`, "-H", `cookie: hb_admin=${newCookie}`, "-o", "/dev/null"]).trim().replace(/[<>]/g, ""), "200");
  check("...and it is a DIFFERENT token than the revoked one", newCookie !== oldCookie, true);
  // The suite-wide `cookie` was minted before this logout, so it died too — re-point it, or every
  // assertion below this block silently tests the 401 path instead of what it says it tests.
  cookie = newCookie;
  revokedCookie = oldCookie;   // the reset block below checks it stays dead
}

// ── POST /api/reset — LAST, because it destroys the fixture everything above reads ──────────────
// It unlinks CONFIG_FILE and replaces CFG with envDefaults(). Nothing covered it, and it is the one
// remaining route that can undo the whole control plane in a single call: a reset that quietly did
// not reset would leave an operator believing they had cleared a bad pin.
//
// Placed after every other assertion on purpose. Restoring the seed afterwards would mean rebuilding
// it through the API and asserting against a fixture the test itself wrote — running it last costs
// nothing and keeps the fixture honest for everyone above.
console.log("admin — reset, run last because it wipes the fixture:");
{
  // `z` is what the POST-config-replaces block above left behind — the only file-backed rule still
  // standing by the time we get here. Asserting on it rather than on the seed keeps this test
  // truthful about the state the suite actually arrives in; my first version assumed the seeded
  // rules survived and failed, which is the assertion doing its job.
  check("a file-backed project rule exists before the reset", Object.keys(api("state").projectRoutes || {}), ["z"]);
  const r = api("reset", {});
  check("reset reports ok", r.ok, true);
  check("...and returns the fresh state inline", typeof r.state, "object");
  const after = api("state");
  check("the file-backed project rules are gone", Object.keys(after.projectRoutes || {}).length, 0);
  // What must SURVIVE: the pool comes from ANTHROPIC_POOL in the env, not the config file, so a
  // reset must not strand every project by emptying it. envDefaults() is a re-read of the
  // environment, not a blank slate.
  check("the env-provided account pool survives", (after.claudecodeAccountPool || []).map((a) => a.name), ["acctA", "acctB"]);
  check("the config file was actually unlinked", existsSync(CFG_PATH), false);
  // A reset restores env defaults, and the session epoch is the one field that must NOT go back:
  // restoring it walks the revocation counter backwards and every cookie an earlier logout killed
  // starts working again. `revokedCookie` was minted before the logout block above.
  check("a reset does not resurrect a cookie revoked by an earlier logout",
    curl(["-o", "/dev/null", `${BASE}/api/state`, "-H", `cookie: hb_admin=${revokedCookie}`]).trim().replace(/[<>]/g, ""), "401");
  check("...while the operator's current session still works after the reset",
    curl(["-o", "/dev/null", `${BASE}/api/state`, "-H", `cookie: hb_admin=${cookie}`]).trim().replace(/[<>]/g, ""), "200");
}

fixtureDestroyed = true;   // anything asserting past this point is in the wrong place — see check()

server.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
