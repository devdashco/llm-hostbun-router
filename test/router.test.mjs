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
import { copyFileSync, mkdtempSync } from "node:fs";
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
  env: { ...process.env, PORT: String(PORT), CONFIG_FILE: CFG, ADMIN_PASSWORD: "ddash",
         SESSION_INSECURE: "1", ADMIN_FILE: join(ROOT, "admin/index.html"), DATABASE_URL: "" },
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

console.log("admin — a consumer is a person's machine or an app, never both:");
check("app registers", api("consumers", { name: "acme", kind: "app" }).ok, true);
check("app may not have an owner", api("consumers", { name: "acme", kind: "app", owner: "bob" }).error, "an app has no owner");
check("dev must have an owner", !!api("consumers", { name: "acme3", kind: "dev" }).error, true);
check("kind must be dev or app", api("consumers", { name: "acme", kind: "robot" }).error, "kind must be 'dev' or 'app'");
check("a job is not a consumer", !!api("consumers", { name: "acme:job", kind: "app" }).error, true);

console.log("admin — issuing a key IS registering:");
const k = api("consumers/keys", { name: "fresh", kind: "app" });
check("key returned once", /^sk-llm-[0-9a-f]{8}-.{20,}$/.test(k.key || ""), true);
check("consumer created by the same call", api("state").consumers.fresh.kind, "app");
check("hash never leaves the process", JSON.stringify(api("consumers")).includes('"hash"'), false);
check("revoke", api("consumers/keys/revoke", { name: "fresh", id: k.keyId }).ok, true);

console.log("admin — the gate:");
check("unauthed state is 401", status("/api/state"), "401");
check("bad password is 401", curl(["-o", "/dev/null", "-X", "POST", `${BASE}/api/login`, "-d", '{"password":"no"}']).trim().replace(/[<>]/g, ""), "401");
check("unknown admin endpoint is 404", api("nope").error, "unknown admin endpoint");

console.log("shell routes:");
check("root serves the panel", status("/"), "200");
check("a UI slug serves the panel", status("/routing"), "200");
// The /admin prefix is gone, not redirected. A tombstone 404 rather than a fall-through into the
// model router, which would answer a stale POST /admin/api/login with "model_not_routable".
check("/admin is gone", status("/admin"), "404");
check("/admin/api/* is gone", status("/admin/api/state"), "404");
// Not 404: an unknown path with no model falls into the resolver, which refuses ("no model
// specified; no default route") — a 400. There is no catch-all at the root, by design.
check("an unknown path is refused, not routed", status("/nope"), "400");

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

server.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
