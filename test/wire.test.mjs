// Wire smoke test — boots the real server against a fake upstream and drives every route.
//
// This exists because the src/ split left EIGHT module-level identifiers behind (HOP_REQ, HOP_RES,
// HEADROOM_URL, IMAGE_MODEL_IDS, CONTENT_CAP, WINDOW_MS, jsonEnforce, wantsJsonFormat). Every one of
// them threw a ReferenceError at request time, the process-wide fatal-guard swallowed the throw, and
// the container stayed "healthy" while returning 502 to every caller for hours. The 36-check suite
// passed the whole time — because nothing in it proxied a request.
//
// A ReferenceError on any route fails this test. That is the entire point: unit tests that never
// touch the wire cannot catch a wire bug.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

// Ports are chosen by the OS, not hardcoded. A fixed port lets a stale process from an earlier run
// answer instead of the server under test — the suite then passes green against a stranger.
import net from "node:net";
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort(), UPSTREAM = await freePort();
let pass = 0, fail = 0;
const ok = (name) => { console.log(`  ok    ${name}`); pass++; };
const bad = (name, why) => { console.log(`  FAIL  ${name}\n        ${why}`); fail++; };

// A stand-in for llama.cpp / api.anthropic.com / crazyrouter. Answers everything with a valid,
// OpenAI-shaped body so the router's own code — not the upstream — is what is under test.
// `?fail=1` on the inbound path makes the stub answer 4xx. Every route below used to meet a stub
// that ALWAYS returned 200, so no error branch in the router was ever executed — and the json-enforce
// upstream-error branch was throwing ReferenceError on HOP_RES from 2026-07-26 (introduced by the
// jsonenforce split in 8dc6ca3) until this made it reachable.
let failNext = false;
const upstream = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    if (failNext) { failNext = false; res.writeHead(429, { "content-type": "application/json" }); return res.end('{"error":{"message":"rate limited"}}'); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-test", object: "chat.completion", model: "fake",
      choices: [{ index: 0, message: { role: "assistant", content: "{\"ok\":true}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      data: [{ id: "fake-model", object: "model" }],
    }));
  });
});
await new Promise((r) => upstream.listen(UPSTREAM, r));

const cfgPath = path.join(os.tmpdir(), `wire-cfg-${process.pid}.json`);
fs.writeFileSync(cfgPath, JSON.stringify({
  bases: { local: `http://127.0.0.1:${UPSTREAM}`, crazyrouter: `http://127.0.0.1:${UPSTREAM}`, claudecode: `http://127.0.0.1:${UPSTREAM}` },
  localMap: { local: "fake-model" },
  crazyrouterKey: "test", requireProject: false, requireRegisteredConsumer: false,
  auth: { mode: "off" }, logging: { enabled: false, content: false },
  consumers: {}, consumerAliases: {},
}));

// A stand-in for the exported panel, so the panel branches can be driven without a `panel/` build.
// Two files is all they need: the root shell and one UI_ROUTES slug.
const panelDir = path.join(os.tmpdir(), `wire-panel-${process.pid}`);
fs.mkdirSync(path.join(panelDir, "calls"), { recursive: true });
fs.mkdirSync(path.join(panelDir, "_next", "static", "chunks"), { recursive: true });
fs.writeFileSync(path.join(panelDir, "index.html"), "<!doctype html><title>panel</title>");
fs.writeFileSync(path.join(panelDir, "calls", "index.html"), "<!doctype html><title>calls</title>");
fs.writeFileSync(path.join(panelDir, "_next", "static", "chunks", "x.js"), "export const a=1;");

const srv = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(PORT), CONFIG_FILE: cfgPath, PRICES_FILE: "/nonexistent.json",
    ADMIN_PASSWORD: "ddash", SESSION_INSECURE: "1", DATABASE_URL: "", PANEL_DIR: panelDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => (log += d));
srv.stderr.on("data", (d) => (log += d));

// Wait for OUR process to print its own banner, then confirm the port answers. Polling the port
// alone would happily accept an answer from anything already listening there.
const up = async () => {
  for (let i = 0; i < 100; i++) {
    if (/llm-gateway on :/.test(log)) {
      try { await fetch(`http://127.0.0.1:${PORT}/v1/models`); return true; } catch { /* not yet */ }
    }
    if (srv.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};
if (!(await up())) {
  console.error("server never came up. log:\n" + log);
  srv.kill("SIGKILL"); upstream.close();
  process.exit(1);
}
assert.ok(!/EADDRINUSE/.test(log), "port was already taken — the test would have run against a stale server");

// Every request gets a deadline. A route that HANGS is a failure too — and a hang is exactly what a
// half-streamed proxy response looks like, so a test without a timeout just stops, green-ish, forever.
const call = (p, init) => fetch(`http://127.0.0.1:${PORT}${p}`, { ...init, signal: AbortSignal.timeout(8000) })
  .then(async (r) => { await r.arrayBuffer(); return r.status; })   // drain: an unread body leaves the socket open
  .catch((e) => `ERR ${e.name === "TimeoutError" ? "timed out (hung)" : e.message}`);
const J = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const CHAT = { model: "local", max_tokens: 4, messages: [{ role: "user", content: "hi" }] };

const routes = [
  ["GET  /v1/models", () => call("/v1/models")],
  // the plain proxy path — this is where HOP_REQ/HOP_RES threw
  ["POST /v1/chat/completions", () => call("/v1/chat/completions", J(CHAT))],
  // the json-enforce path — this is where wantsJsonFormat/jsonEnforce threw
  ["POST /v1/chat/completions (json_object)", () => call("/v1/chat/completions", J({ ...CHAT, response_format: { type: "json_object" } }))],
  ["POST /v1/messages (native)", () => call("/v1/messages", J({ model: "claude-haiku-4-5", max_tokens: 4, messages: [{ role: "user", content: "hi" }] }))],
  ["POST /v1/completions", () => call("/v1/completions", J({ model: "local", prompt: "hi", max_tokens: 4 }))],
  ["GET  /local/v1/models", () => call("/local/v1/models")],
  ["GET  /prices.json", () => call("/prices.json")],
  ["GET  / (panel)", () => call("/")],
];

// The control plane, behind the cookie. These are GET routes that read a query string via
// url.parse() — the require for which the split dropped, so every one of them threw AFTER writing
// headers, surfacing as a hang rather than a 500. Nothing above this line reads a query string,
// which is exactly why the first version of this test missed it.
const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, J({ password: "ddash" }));
const cookie = (login.headers.getSetCookie?.() || []).join("; ");
const adminGet = (p) => fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { cookie }, signal: AbortSignal.timeout(8000) })
  .then(async (r) => { await r.arrayBuffer(); return r.status; })
  .catch((e) => `ERR ${e.name === "TimeoutError" ? "timed out (hung)" : e.message}`);
// Same, for the POST side of the control plane. router.test.mjs cannot drive the routes that touch
// a provider — its header says so, and its seed points bases.local at the real pbox host with
// bases.crazyrouter defaulting to the real crazyrouter.com, so a test there would leave the
// network. HERE every base is the loopback fake above, which is why these belong in this file.
const adminPost = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}`,
  { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(8000) })
  .then(async (r) => { await r.arrayBuffer(); return r.status; })
  .catch((e) => `ERR ${e.name === "TimeoutError" ? "timed out (hung)" : e.message}`);

routes.push(
  ["POST /api/login", () => Promise.resolve(login.status)],
  ["GET  /api/state", () => adminGet("/api/state")],
  ["GET  /api/health", () => adminGet("/api/health")],
  ["GET  /api/calls?limit=1", () => adminGet("/api/calls?limit=1")],
  // The rest of the call log (src/calllog.js). What these three actually prove is the DISPATCH
  // WIRING: that each `CL.x` the handler names really exists and is callable. Typo one and this
  // goes red on a TypeError. Verified by doing exactly that.
  //
  // They prove little about the handler BODIES, and it would be easy to read them as if they did:
  // with no DB every one returns at its own `dbUp()` guard, the first line in each. Deleting
  // `dbRow` from calllog.js's imports leaves all three green here — `test/imports.test.mjs` is what
  // catches that, and did. Anything past the guard is only covered against a real database.
  ["GET  /api/calls/facets", () => adminGet("/api/calls/facets")],
  ["GET  /api/call?id=1", () => adminGet("/api/call?id=1")],
  ["GET  /api/export?limit=1", () => adminGet("/api/export?limit=1")],
  ["GET  /api/stats", () => adminGet("/api/stats")],
  // The other two consumption rollups. They moved to src/analytics.js with stats, but only stats was
  // driven here — so an identifier left unbound in either one (the whole reason this file exists)
  // would have shipped. Both take a query string, which is the half of the route that throws late.
  ["GET  /api/usage?win=1h", () => adminGet("/api/usage?win=1h")],
  ["GET  /api/series?window=1h&by=consumer", () => adminGet("/api/series?window=1h&by=consumer")],
  // The read-mostly tail of the control plane, uncovered until 2026-07-26. Low blast radius each,
  // but they are the routes that read a query string or call a provider, which is precisely the
  // shape that hung the whole panel when the src/ split dropped a require (see this file's header).
  // The json-enforce path when the UPSTREAM fails. Distinct from the happy path above: it builds its
  // own response headers, and it did that with an unimported HOP_RES — a ReferenceError thrown after
  // the row was logged, so the caller got nothing and the log said the upstream 429'd.
  ["POST /v1/chat/completions (json_object, upstream 429)", async () => {
    failNext = true;
    return call("/v1/chat/completions", J({ ...CHAT, response_format: { type: "json_object" } }));
  }],
  ["GET  /api/models", () => adminGet("/api/models")],
  ["GET  /api/limits", () => adminGet("/api/limits")],
  ["GET  /api/claudecode/models", () => adminGet("/api/claudecode/models")],
  ["GET  /api/crazyrouter", () => adminGet("/api/crazyrouter")],
  ["POST /api/crazyrouter/test", () => adminPost("/api/crazyrouter/test", { key: "sk-test-not-a-real-key" })],
  ["GET  /api/consumers", () => adminGet("/api/consumers")],
  ["GET  /api/developers", () => adminGet("/api/developers")],
  // The registry's read surface. Without a DB these do NOT 503 — they answer 200 from the
  // /data/config.json mirror and SAY so (`stale: true` + a warning). That is deliberate: a cold boot
  // with the DB down must still authenticate. The comment here claimed 503 for a long time; the
  // status-only loop below could not tell the difference, so the real invariant is asserted
  // separately underneath — a caller must be able to tell a mirror read from a live one.
  ["GET  /api/machines", () => adminGet("/api/machines")],
  ["GET  /api/projects", () => adminGet("/api/projects")],
);

// The /admin surface is gone. These assert the removal, and — more importantly — that removing it
// did not swallow the two carve-outs: /api/v1/* is real inference traffic and /api/pricing is public.
// Routing either into the cookie-gated admin handler would 401 callers that never had a cookie.
const expect = async (name, p, want, init) => {
  const got = await call(p, init);
  if (got === want) ok(`${name} -> ${got}`);
  else bad(name, `expected ${want}, got ${got}`);
};
// The registry read surface, on the invariant the status loop above cannot see. With no DB the
// answer is the config mirror, and a caller who cannot tell that from a live read will act on data
// that is "possibly out of date" believing it is current — which is the same failure as a confident
// zero. This suite runs with DATABASE_URL unset, so this IS the DB-down case.
for (const path of ["/api/machines", "/api/projects"]) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { cookie } });
  const body = await r.json().catch(() => ({}));
  if (r.status !== 200) bad(`${path} serves the mirror when the DB is down`, `status ${r.status}`);
  else if (body.stale !== true) bad(`${path} SAYS it is serving the mirror`, `no stale flag: ${JSON.stringify(body).slice(0, 120)}`);
  else if (!/mirror/i.test(body.warning || "")) bad(`${path}'s warning names what the reader is looking at`, body.warning || "(none)");
  else ok(`${path} answers from the mirror and says so`);
}

await expect("GET  /admin/api/state is GONE", "/admin/api/state", 404);
await expect("GET  /admin is GONE", "/admin", 404);
await expect("GET  /api/v1/models still routes to the catalog", "/api/v1/models", 200);
await expect("POST /api/v1/chat/completions still proxies", "/api/v1/chat/completions", 200, J(CHAT));

// A base URL default that outlives the box it named is not a style nit — it is where traffic goes
// when the env var is missing. `sdturbo.bofrid.dev` stayed the coded default for the image provider
// after that service moved to ww; it answers 503, so any boot without IMAGE_BASE aimed every image
// call at a decommissioned host. Read from SOURCE so this needs no server and no network: the point
// is that a RETIRED host can never sit in a default again, not that today's host is spelled right.
{
  const RETIRED_BASES = ["sdturbo.bofrid.dev"];
  const cfgSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "config.js"), "utf8");
  const defaults = [...cfgSrc.matchAll(/process\.env\.\w+\s*\|\|\s*"(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  const dead = defaults.filter((u) => RETIRED_BASES.some((h) => u.includes(h)));
  if (dead.length) bad("no retired host survives as a base default", `still defaulted to: ${dead.join(", ")}`);
  else ok(`no retired host in the ${defaults.length} base defaults (checked: ${RETIRED_BASES.join(", ")})`);
}

// The panel is READ-ONLY, so HEAD has to reach it exactly like GET. Both panel branches used to
// test `req.method === "GET"` and nothing else, so a HEAD fell past them into the model router and
// came back `400 blocked (no model specified)` — prod's log carried a steady drip of
// `HEAD /calls/ -> blocked` from browser link prefetching. 400 is the tell: a genuine miss is 404.
const HEAD = { method: "HEAD" };
await expect("GET  / serves the panel shell", "/", 200);
await expect("HEAD / serves the panel shell", "/", 200, HEAD);
await expect("HEAD /calls/ serves its slug", "/calls/", 200, HEAD);
await expect("HEAD an asset serves it", "/_next/static/chunks/x.js", 200, HEAD);
await expect("HEAD a missing asset is 404, not blocked", "/_next/static/chunks/nope.js", 404, HEAD);

for (const [name, run] of routes) {
  const before = log.length;
  const status = await run();
  await new Promise((r) => setTimeout(r, 120));   // let the fatal-guard print
  const fresh = log.slice(before);
  if (/ReferenceError|TypeError: .* is not a function/.test(fresh)) {
    bad(name, fresh.split("\n").find((l) => /ReferenceError|TypeError/.test(l)).trim());
  } else if (typeof status === "string") {
    bad(name, status);
  } else if (status >= 500) {
    bad(name, `HTTP ${status} (upstream is a stub — a 5xx here means the router itself broke)`);
  } else {
    ok(`${name} -> ${status}`);
  }
}

// Nothing anywhere in the run should have hit the guard.
if (/fatal-guard/.test(log)) bad("no fatal-guard trips", log.split("\n").filter((l) => /fatal-guard/.test(l))[0]);
else ok("no fatal-guard trips");

srv.kill("SIGKILL");
upstream.close();
fs.rmSync(cfgPath, { force: true });
fs.rmSync(panelDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
