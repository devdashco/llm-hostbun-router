// What the REAL server writes to the call log, per path.
//
//   node test/server-rows.test.mjs
//
// The other suites boot server.js in a CHILD process, which makes a row unobservable: there is no
// database in a test, and `recordCall` lives in the child. So the behaviour that matters most about
// server.js's own handler — which requests produce a row, and what is on it — had no coverage at
// all, and a fix to it could not be tested. That is not hypothetical: `/local/*` forwarded without
// a model or a project for as long as it existed, so every row from it read `req_model=null,
// project=null` while the identical body sent to /v1/chat/completions was fully attributed.
//
// This boots server.js IN-PROCESS with `recordCall` stubbed at the db module first — the same trick
// proxy-log.test.mjs uses, and for the same reason: http.js destructures it at require time, so a
// later patch is captured too late to see. Requiring server.js runs it; it listens on PORT.
//
// Nothing here reaches a real upstream: every provider base points at a loopback fake.
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const req_ = createRequire(import.meta.url);

const freePort = () => new Promise((r) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); });
});

// A fake that answers anything with a plausible OpenAI body, and remembers what it was asked.
const seen = [];
const fake = http.createServer((rq, rs) => {
  let body = "";
  rq.on("data", (c) => (body += c));
  rq.on("end", () => {
    seen.push({ path: rq.url, body });
    rs.writeHead(200, { "content-type": "application/json" });
    rs.end(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }));
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

const PORT = await freePort();
const cfgPath = join(os.tmpdir(), `server-rows-${process.pid}.json`);
fs.writeFileSync(cfgPath, JSON.stringify({
  // auth off: this suite is about what gets RECORDED, not about who may call. The gate has its own
  // coverage in router.test.mjs, and leaving it on here would only test the refusal path twice.
  auth: { mode: "off" }, logging: { enabled: true, content: false },
  // A real key, because the OTel ingest below authenticates for real — identity there comes from
  // the KEY, never from a resource attribute the exporter asserts.
  consumers: { pbox: { kind: "dev", owner: "philip", keys: [{ id: "dddd4444", hash: "SHA" }] } },
  consumerAliases: {}, projectRoutes: {}, projectAccounts: {},
  crazyrouterKey: "test-key",
}).replace('"SHA"', JSON.stringify(createHash("sha256").update("probesecret").digest("hex"))));
const OTEL_KEY = "sk-llm-dddd4444-probesecret";

Object.assign(process.env, {
  PORT: String(PORT), CONFIG_FILE: cfgPath, ADMIN_PASSWORD: "ddash", SESSION_INSECURE: "1",
  DATABASE_URL: "", PANEL_DIR: "/nonexistent", PRICES_FILE: "/nonexistent.json",
  LOCAL_BASE: FAKE, CRAZYROUTER_BASE: FAKE, ANTHROPIC_BASE: "http://127.0.0.1:1",
  IMAGE_BASE: FAKE, ANTHROPIC_POOL: "[]",
});

const rows = [];
const db = req_(join(ROOT, "src/db.js"));
db.recordCall = (row) => rows.push(row);      // MUST precede the server.js require below
db.dbUp = () => true;                         // recordCall's own guard: no DB, but rows still flow
req_(join(ROOT, "server.js"));
for (let i = 0; i < 100; i++) {               // wait for the listener
  try { await fetch(`http://127.0.0.1:${PORT}/api/pricing`); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
}

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, why) => { fail++; console.log(`  FAIL  ${m}\n        ${why}`); };
const check = (m, actual, expected) => (JSON.stringify(actual) === JSON.stringify(expected)
  ? ok(m) : bad(m, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));

// A row is written from the response stream's `end` handler, so it does not exist the instant fetch
// resolves. Poll instead of sleeping a fixed amount — a fixed sleep is how this kind of check turns
// into one that cannot fail on a slow machine.
const rowSoon = async (ms = 2000) => {
  for (let i = 0; i < ms / 25 && !rows.length; i++) await new Promise((r) => setTimeout(r, 25));
  return rows[0];
};
const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

console.log("server.js — what lands in the call log:");

// ── /local/* back-compat ────────────────────────────────────────────────────────────────────────
// The reason this file exists. This path strips the /local prefix and forwards; it used to pass
// neither the model nor the caller to proxy().
{
  rows.length = 0;
  await post("/local/v1/chat/completions", { model: "qwen3.5-9b", messages: [{ role: "user", content: "hi" }] },
    { "x-project": "seoul:crawl" });
  const row = await rowSoon();
  if (!row) bad("a /local/* call is recorded", "no row");
  else {
    ok("a /local/* call is recorded");
    check("...naming the model the caller asked for", row.reqModel, "qwen3.5-9b");
    check("...and the consumer AND job it belongs to", row.project, "seoul:crawl");
    check("...against the local provider", row.provider, "local");
  }
}

// The same request through the canonical path must be attributed identically — that equivalence is
// the actual invariant. Asserting /local/* alone would let the two drift apart again in the other
// direction and still pass.
{
  rows.length = 0;
  await post("/v1/chat/completions", { model: "qwen3.5-9b", messages: [{ role: "user", content: "hi" }] },
    { "x-project": "seoul:crawl" });
  const row = await rowSoon();
  if (!row) bad("the canonical path is recorded", "no row");
  else {
    ok("the canonical path is recorded");
    check("...with the same model as the /local/* form", row.reqModel, "qwen3.5-9b");
    check("...and the same consumer", row.project, "seoul:crawl");
  }
}

// ── the OTel ingest, end to end ─────────────────────────────────────────────────────────────────
// otel.test.mjs covers the PARSE (otlpRows over an OTLP/JSON payload) and the GATE (401s) as
// separate halves. Nothing covered the wiring between them: an authenticated POST arriving at the
// real server and becoming a call-log row. That path is the whole reason the ingest exists — a
// direct-connect box talks to api.anthropic.com and this router writes nothing, so these rows are
// the only record that spend happened at all.
{
  // Flip the gate to `required` for this block only — prod's mode, and the one where identity comes
  // from the KEY. With auth off the ingest falls back to the self-asserted `x-consumer` header, so
  // the test would prove the fallback works and say nothing about the path that actually runs.
  // CFG is mutated in place and shared with the server running in this process, so this reaches it.
  const { CFG } = req_(join(ROOT, "src/config.js"));
  const prevMode = CFG.auth.mode;
  CFG.auth.mode = "required";
  rows.length = 0;
  const attrs = { "event.name": "api_request", model: "claude-opus-5", duration_ms: 4200,
    input_tokens: 1200, output_tokens: 340, cache_read_tokens: 88000, cache_creation_tokens: 5000,
    "session.id": "abc-123" };
  const payload = { resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
    scopeLogs: [{ logRecords: [{ timeUnixNano: "1750000000000000000",
      attributes: Object.entries(attrs).map(([k, v]) => ({ key: k,
        value: typeof v === "number" ? { intValue: String(v) } : { stringValue: String(v) } })) }] }] }] };
  const r = await fetch(`http://127.0.0.1:${PORT}/otel/v1/logs`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${OTEL_KEY}` },
    body: JSON.stringify(payload),
  });
  check("an authenticated OTLP post is accepted", r.status, 200);
  const row = await rowSoon();
  if (!row) bad("...and becomes a call-log row", "no row — the ingest accepted it and dropped it");
  else {
    ok("...and becomes a call-log row");
    // Tagged `:direct` because these tokens passed no pin, no allowlist and no cache breakpoint.
    // Folding them under the bare consumer name would make half of `pbox` stop meaning "went
    // through the router".
    check("...tagged as direct, not as routed traffic", row.project, "pbox:direct");
    check("...with the model the box actually used", row.reqModel, "claude-opus-5");
    check("...and every token count, cache included",
      [row.usage.prompt_tokens, row.usage.completion_tokens, row.usage.cache_read_input_tokens],
      [1200, 340, 88000]);
  }
  // An unauthenticated ingest must write NOTHING: this is a write into the call log from outside,
  // and forging spend against another consumer is the whole reason it is gated.
  rows.length = 0;
  const anon = await fetch(`http://127.0.0.1:${PORT}/otel/v1/logs`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  check("an unauthenticated OTLP post is refused", anon.status, 401);
  await new Promise((r) => setTimeout(r, 150));
  check("...and writes no row at all", rows.length, 0);
  CFG.auth.mode = prevMode;
}

// ── the guard that keeps this harness honest ────────────────────────────────────────────────────
// If the stub were wired wrong, or `recordThis` were forced true, every check above would pass for
// the wrong reason. A GET that reaches no upstream must produce NO row.
{
  rows.length = 0;
  await fetch(`http://127.0.0.1:${PORT}/api/pricing`);
  await new Promise((r) => setTimeout(r, 200));
  check("a control-plane GET writes no row", rows.length, 0);
}

fake.close();
try { fs.unlinkSync(cfgPath); } catch { /* gone */ }
console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
