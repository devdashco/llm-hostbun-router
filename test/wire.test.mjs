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
const upstream = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
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

const srv = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(PORT), CONFIG_FILE: cfgPath, PRICES_FILE: "/nonexistent.json",
    ADMIN_PASSWORD: "ddash", SESSION_INSECURE: "1", DATABASE_URL: "" },
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

routes.push(
  ["POST /api/login", () => Promise.resolve(login.status)],
  ["GET  /api/state", () => adminGet("/api/state")],
  ["GET  /api/health", () => adminGet("/api/health")],
  ["GET  /api/calls?limit=1", () => adminGet("/api/calls?limit=1")],
  ["GET  /api/stats", () => adminGet("/api/stats")],
  ["GET  /api/consumers", () => adminGet("/api/consumers")],
  ["GET  /api/developers", () => adminGet("/api/developers")],
  // The registry's read surface. Without a DB these answer 503, not 500 or a hang — a caller must be
  // able to tell "the registry is down" from "you asked wrong".
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
await expect("GET  /admin/api/state is GONE", "/admin/api/state", 404);
await expect("GET  /admin is GONE", "/admin", 404);
await expect("GET  /api/v1/models still routes to the catalog", "/api/v1/models", 200);
await expect("POST /api/v1/chat/completions still proxies", "/api/v1/chat/completions", 200, J(CHAT));

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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
