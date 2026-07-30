// OTLP ingest — the direct-connect boxes' token usage.
//
// Two halves, because two different things fail silently here:
//
//  * the PARSE. OTLP/JSON puts every int64 in a STRING (`{"intValue":"1234"}`), so an unconverted
//    token count lands in Postgres as text or NaN and the usage rollups quietly read zero. Pinned
//    field by field, plus the two shapes the event name arrives in. (Measured: dropping the Number()
//    in anyVal does NOT turn this red — num() on each numeric read is the actual guard, and that is
//    the one to keep. The assertions below pin the OUTPUT type, not which line produces it.)
//  * the GATE. /otel/v1/logs is a write into the call log from outside; unauthenticated it would let
//    anyone forge spend against any consumer. It sits ABOVE the inference auth gate in server.js
//    (`isInference` never matches it), so it carries its own — which means nothing else is watching.
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import nodeCrypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const { otlpRows } = await import("../src/otel.js").then((m) => m.default || m);

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  ok    ${n}`); pass++; };
const bad = (n, why) => { console.log(`  FAIL  ${n}\n        ${why}`); fail++; };
const check = (n, cond, why = "") => (cond ? ok(n) : bad(n, why));

// ── the parse ────────────────────────────────────────────────────────────────────────────────────
const evt = (attrs, extra = {}) => ({
  resourceLogs: [{
    resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
    scopeLogs: [{ logRecords: [{ timeUnixNano: "1750000000000000000", ...extra,
      attributes: Object.entries(attrs).map(([k, v]) => [k, v]).map(([k, v]) => ({
        key: k,
        value: typeof v === "number" ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
          : { stringValue: String(v) },
      })) }] }],
  }],
});

const apiReq = evt({
  "event.name": "api_request", model: "claude-opus-5", duration_ms: 4200,
  input_tokens: 1200, output_tokens: 340, cache_read_tokens: 88000, cache_creation_tokens: 5000,
  cost_usd: 0.42, "session.id": "abc-123", "user.email": "claude2@mejl.to",
});

{
  const [r] = otlpRows(apiReq, { consumer: "pbox", ip: "1.2.3.4" });
  check("api_request → one row", !!r, "no row produced");
  check("model carried onto both model columns", r.reqModel === "claude-opus-5" && r.sentModel === "claude-opus-5");
  check("provider is claudecode", r.provider === "claudecode", r && r.provider);
  check("intValue strings become NUMBERS", r.usage.prompt_tokens === 1200 && typeof r.usage.prompt_tokens === "number",
    JSON.stringify(r.usage));
  check("all four token counts land", r.usage.completion_tokens === 340
    && r.usage.cache_read_input_tokens === 88000 && r.usage.cache_creation_input_tokens === 5000,
    JSON.stringify(r.usage));
  check("total = input + output", r.usage.total_tokens === 1540, String(r.usage.total_tokens));
  check("timeUnixNano → ms", r.ts === 1750000000000, String(r.ts));
  check("duration is ms, not ns", r.ms === 4200, String(r.ms));
  check("status 200 on a successful request", r.status === 200);
  // job=direct is what separates bypassed traffic from routed traffic in every rollup. Fold it in
  // under the bare consumer name and half of `pbox` silently stops meaning "went through the router".
  check("row is tagged <consumer>:direct", r.project === "pbox:direct", String(r.project));
  check("identity is the caller's, not the payload's", otlpRows(apiReq, { consumer: "wmac" })[0].project === "wmac:direct");
}

{
  // The account pool keys on OUR name, not the login email — /api/accounts and every per-account
  // spend query do split_part(key_label,':',2). An unmapped email stays raw rather than becoming a
  // wrong-but-plausible account name.
  const { CFG } = await import("../src/config.js");
  CFG.claudecodeAccountPool = [{ name: "claude2mejlto", email: "claude2@mejl.to", token: "x" }];
  check("user.email maps to the pool's account name",
    otlpRows(apiReq, { consumer: "pbox" })[0].keyLabel === "claudecode:claude2mejlto",
    otlpRows(apiReq, { consumer: "pbox" })[0].keyLabel);
  CFG.claudecodeAccountPool = [];
  check("unknown email is kept raw, not guessed",
    otlpRows(apiReq, { consumer: "pbox" })[0].keyLabel === "claudecode:claude2@mejl.to");
}

{
  const errRows = otlpRows(evt({ "event.name": "api_error", model: "claude-opus-5", status_code: 429,
    error: "rate limited", duration_ms: 10 }), { consumer: "pbox" });
  check("api_error → row with the upstream status", errRows[0] && errRows[0].status === 429, JSON.stringify(errRows[0]));
  check("api_error carries the message", errRows[0] && errRows[0].error === "rate limited");
}

{
  // The fully-qualified name arrives in the log BODY on some emitters; the short one in event.name.
  const viaBody = otlpRows({ resourceLogs: [{ scopeLogs: [{ logRecords: [
    { body: { stringValue: "claude_code.api_request" }, attributes: [{ key: "model", value: { stringValue: "m" } }] }] }] }] },
    { consumer: "pbox" });
  check("event name from the body is accepted", viaBody.length === 1, JSON.stringify(viaBody));
}

{
  // Every other Claude Code event (user_prompt, tool_result, session.count…) rides the same stream.
  // Turning any of them into a call-log row would invent calls that never happened.
  const noise = otlpRows(evt({ "event.name": "user_prompt", prompt_length: 42 }), { consumer: "pbox" });
  check("non-api events produce NO rows", noise.length === 0, JSON.stringify(noise));
  check("garbage payload produces no rows", otlpRows({}, {}).length === 0 && otlpRows(null, {}).length === 0);
}

// ── the gate ─────────────────────────────────────────────────────────────────────────────────────
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const cfgPath = path.join(os.tmpdir(), `otel-cfg-${process.pid}.json`);
fs.writeFileSync(cfgPath, JSON.stringify({
  auth: { mode: "required" }, logging: { enabled: false, content: false },
  // A REAL key. With an empty registry every request 401s at the gate, so the checks below that are
  // about what happens AFTER authentication never reached their branch — `a non-JSON body never
  // 5xx's` was measuring the 401, and stayed green with the malformed-body handling removed
  // entirely (probed by the audit that found it). The parse branch needs a caller who got in.
  consumers: { probe: { kind: "app", keys: [{ id: "dddd4444", hash: nodeCrypto.createHash("sha256").update("probesecret").digest("hex") }] } },
  consumerAliases: {}, crazyrouterKey: "test",
}));
const GOOD_KEY = "sk-llm-dddd4444-probesecret";
const srv = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(PORT), CONFIG_FILE: cfgPath, PRICES_FILE: "/nonexistent.json",
    ADMIN_PASSWORD: "ddash", SESSION_INSECURE: "1", DATABASE_URL: "", PANEL_DIR: "/nonexistent" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => (log += d));
srv.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 100 && !/llm-gateway on/.test(log); i++) await new Promise((r) => setTimeout(r, 100));

const post = async (body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/otel/v1/logs`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
};

try {
  check("boots", /llm-gateway on/.test(log), log.slice(-400));
  const anon = await post(apiReq);
  check("ingest without a key is 401", anon.status === 401, `${anon.status} ${anon.text.slice(0, 120)}`);
  const badKey = await post(apiReq, { authorization: "Bearer sk-llm-deadbeef-nope" });
  check("ingest with a bad key is 401", badKey.status === 401, String(badKey.status));
  // Protobuf into a JSON-only endpoint is the likely misconfiguration; it must say so, not 500.
  // Authenticated, so this actually reaches the parse. Protobuf into a JSON-only endpoint is the
  // likely misconfiguration and must be a 400 that NAMES the fix, never a 5xx and never a hang:
  // ingest() is called un-awaited, so an uncaught throw there is an unhandled rejection with no
  // response ever sent. `< 500` could not tell any of that apart from the 401 it was really seeing.
  // A credential meant for somewhere ELSE must not read as "no key". This is the exact shape that
  // hid the live misconfiguration: pbox shipped OTel here carrying its HyperDX token, and the log
  // said `no key`, so the box looked like telemetry was simply off rather than pointed at the wrong
  // backend with the wrong credential.
  const foreign = await post(apiReq, { authorization: "Bearer 3b1c3830-dead-beef-0000-000000000000" });
  check("a foreign credential is still 401", foreign.status === 401, String(foreign.status));
  check("...and the refusal says it is not OURS, not that none was sent",
    /not one of ours/.test(foreign.text) && !/^no key/.test(JSON.parse(foreign.text).error.message), true);
  check("...without echoing the credential", !/3b1c3830-dead/.test(foreign.text), true);

  const proto = await post("\x00\x01binary", { authorization: `Bearer ${GOOD_KEY}` });
  check("a non-JSON body from an AUTHENTICATED caller is a 400", proto.status === 400, String(proto.status));
  check("...naming the protocol to change, not a bare failure", /http\/json|protocol/i.test(proto.text), true);
  // `!== 404` was the original assertion here and it could not fail for the reason it was written:
  // an UNAUTHENTICATED metrics POST answered 401 — a retry forever, and a `[otel] 401` line per
  // retry — and 401 is not 404, so the check stayed green while the storm it names ran in prod.
  // Metrics is a black hole that stores nothing, so the only answer that ends the retry is 200.
  const metrics = await fetch(`http://127.0.0.1:${PORT}/otel/v1/metrics`, { method: "POST", body: "{}" });
  check("an unauthenticated metrics POST is 200-and-dropped, not a 401 the exporter retries",
    metrics.status === 200, String(metrics.status));
  // The 401 must say WHICH sender to go fix: one box runs many agents behind one IP.
  check("a 401 names the path and the user-agent, not just the ip",
    /\[otel\] 401 .*ip=.*path=\/otel\/v1\/logs ua=/.test(log), log.slice(-300));
} finally {
  srv.kill("SIGKILL");
  try { fs.unlinkSync(cfgPath); } catch { /* gone */ }
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
