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
  ["POST /admin/api/login", () => call("/admin/api/login", J({ password: "ddash" }))],
];

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
