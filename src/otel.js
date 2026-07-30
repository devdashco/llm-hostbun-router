// src/otel.js — OTLP/JSON ingest for the calls this router NEVER SEES.
//
// A cccc box routes through the gateway (`ANTHROPIC_BASE_URL=https://llm.hostbun.cc`), so every
// request lands in the call log on its way past. But `cccc/shell/gateway-route.sh` deliberately
// falls back to a DIRECT api.anthropic.com connection in two cases — the router is down, or the
// operator forced it (`.cccc-force-direct`) — and in that window the whole spend is invisible: same
// Max subscription, same tokens, no row. The panel reads "no traffic" when the truth is "traffic we
// cannot see", which is the exact plausible-value-standing-in-for-unknown failure this codebase
// keeps hitting.
//
// Claude Code ships its OWN OpenTelemetry stream (`CLAUDE_CODE_ENABLE_TELEMETRY=1`), and one of its
// log events — `claude_code.api_request` — is a per-call record carrying model, duration, cost and
// all four token counts. That maps 1:1 onto a `calls` row. So the direct branches export the OTEL
// env pointing here, and this turns each event back into a call-log row.
//
// LOAD-BEARING, not preferences:
//
// 1. **Logs, not metrics.** `claude_code.token.usage` is a counter aggregated over an export window
//    — it can total tokens but cannot say which CALL they belong to, and re-deriving rows from a
//    delta counter is guesswork. `/otel/v1/metrics` answers 200 and drops the payload, purely so a
//    box configured with a bare `OTEL_EXPORTER_OTLP_ENDPOINT` doesn't retry forever.
// 2. **Only the direct branches export.** Routed traffic is already logged by proxy(); if a routed
//    box also shipped OTEL, every call would be counted TWICE and every usage number would be a lie.
//    gateway-route.sh unsets these vars on the `up` path for that reason.
// 3. **The row is marked `job=direct`.** These tokens did not pass through the router — no account
//    pin was applied, no allowlist was checked, no cache breakpoint was marked. Folding them in
//    under the plain consumer name would make `pbox` read as one homogeneous stream when half of it
//    bypassed every rule the router enforces.
// 4. **Identity comes from the key**, exactly like the inference paths: `Authorization: Bearer
//    sk-llm-…` via `OTEL_EXPORTER_OTLP_HEADERS`. A resource attribute is a self-asserted string.
const zlib = require("node:zlib");

const { CFG } = require("./config");
const { recordCall } = require("./db");
const { authenticate, parseConsumer } = require("./identity");

// OTLP/JSON encodes every attribute as an `AnyValue` union. int64 arrives as a STRING (JSON has no
// 64-bit integer) — every numeric field read below goes through num() for that reason, and Number()
// here is belt-and-braces for any attribute read raw.
function anyVal(v) {
  if (v == null || typeof v !== "object") return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (v.boolValue !== undefined) return !!v.boolValue;
  return null;
}
function kvMap(list) {
  const out = {};
  for (const a of list || []) if (a && a.key) out[a.key] = anyVal(a.value);
  return out;
}
const num = (x) => (x == null || x === "" || Number.isNaN(Number(x)) ? null : Number(x));

// Anthropic login → our account name. `acct_limits`, `/api/accounts` and every per-account spend
// query key on the router's own name (`philip`, `claude2mejlto`), not on the email; the pool carries
// `email` as the human label, so this is the one place the two vocabularies meet. No match → keep
// the raw email rather than inventing an account: an unknown name in the accounts view is honest,
// a wrong one is not.
function accountForEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const a = (CFG.claudecodeAccountPool || []).find((x) => String(x.email || "").trim().toLowerCase() === e);
  return a ? a.name : null;
}

// Pure: an OTLP/JSON logs payload → call-log records. Exported so it can be unit-tested without a
// server, a database or a network hop.
function otlpRows(payload, { consumer, ip } = {}) {
  const rows = [];
  for (const rl of (payload && payload.resourceLogs) || []) {
    const resAttrs = kvMap(rl.resource && rl.resource.attributes);
    for (const sl of rl.scopeLogs || []) {
      for (const lr of sl.logRecords || []) {
        const a = { ...resAttrs, ...kvMap(lr.attributes) };
        // The event name lives in `event.name` ("api_request"); older/other emitters put the fully
        // qualified name in the body ("claude_code.api_request"). Accept both, match on the suffix.
        const name = String(a["event.name"] || anyVal(lr.body) || "").replace(/^claude_code\./, "");
        if (name !== "api_request" && name !== "api_error") continue;

        const ts = lr.timeUnixNano ? Math.round(Number(lr.timeUnixNano) / 1e6)
          : (Date.parse(a["event.timestamp"]) || Date.now());
        const model = a.model || null;
        const inTok = num(a.input_tokens), outTok = num(a.output_tokens);
        const job = String(a.job || "direct").trim() || "direct";
        const acct = accountForEmail(a["user.email"]) || a["user.email"] || null;
        rows.push({
          ts,
          ip: ip || null,
          ua: "claude-code (otel, direct)",
          method: "POST",
          path: "/v1/messages",
          reqModel: model, sentModel: model, provider: "claudecode",
          keyLabel: `claudecode:${acct || "direct"}`,
          status: name === "api_error" ? (num(a.status_code) || 500) : 200,
          ms: num(a.duration_ms),
          stream: false,
          usage: {
            prompt_tokens: inTok, completion_tokens: outTok,
            total_tokens: inTok == null && outTok == null ? null : (inTok || 0) + (outTok || 0),
            cache_read_input_tokens: num(a.cache_read_tokens),
            cache_creation_input_tokens: num(a.cache_creation_tokens),
          },
          error: name === "api_error" ? String(a.error || "api_error") : null,
          project: consumer ? `${consumer}:${job}` : null,
          userId: a["session.id"] ? `session_${a["session.id"]}` : null,
        });
      }
    }
  }
  return rows;
}

// POST /otel/v1/logs (and /otel/v1/metrics, accepted and dropped — see header note 1).
function ingest(req, res, { bodyBuf, ip, path }) {
  const done = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  // /otel/v1/metrics is a black hole ABOVE the auth gate, on purpose: it exists only so a box
  // pointed at a bare OTEL_EXPORTER_OTLP_ENDPOINT stops retrying, and it stores nothing whether the
  // caller is authenticated or not. Behind the gate it answered 401 forever instead, which is the
  // retry storm it was added to prevent — and each retry wrote a `[otel] 401` line, burying the
  // 401s that mean something. Nothing is read, written or echoed here, so there is nothing to gate.
  if (!path.endsWith("/logs")) return done(200, { partialSuccess: {} });
  const mode = (CFG.auth && CFG.auth.mode) || "optional";
  const auth = mode === "off" ? null : authenticate(req);
  if (mode !== "off" && !(auth && auth.ok)) {
    // Name the sender. This is an ingest from OUTSIDE, so a 401 is either a box that needs fixing
    // or someone probing — and `ip=` alone cannot tell them apart on a box running many agents.
    const ua = String(req.headers["user-agent"] || "-").slice(0, 60);
    console.error(`[otel] 401 ${(auth && auth.why) || "no key"} ip=${ip} path=${path} ua=${ua}`);
    return done(401, { error: { type: "invalid_api_key", code: "invalid_api_key",
      message: "OTEL ingest needs this box's router key: OTEL_EXPORTER_OTLP_HEADERS=\"Authorization=Bearer sk-llm-…\"." } });
  }
  // With auth off there is no key to read identity from, so fall back to what the exporter asserts
  // (`OTEL_RESOURCE_ATTRIBUTES=consumer=…`, read below) via the header cccc already sends.
  const consumer = auth && auth.ok
    ? auth.consumer
    : parseConsumer(String(req.headers["x-consumer"] || "")).consumer || null;

  let payload = null;
  try {
    const raw = /gzip/i.test(String(req.headers["content-encoding"] || ""))
      ? zlib.gunzipSync(bodyBuf) : bodyBuf;
    payload = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    // Almost always http/protobuf hitting a JSON-only endpoint. Say so: the fix is one env var.
    console.warn(`[otel] unparseable body (${e.message}) — set OTEL_EXPORTER_OTLP_PROTOCOL=http/json`);
    return done(400, { error: { message: "expected OTLP/JSON — set OTEL_EXPORTER_OTLP_PROTOCOL=http/json" } });
  }

  let rows = [];
  try { rows = otlpRows(payload, { consumer, ip }); } catch (e) { console.warn(`[otel] parse failed: ${e.message}`); }
  for (const r of rows) recordCall(r);
  if (rows.length) console.log(`[otel] ${rows.length} direct call(s) logged consumer=${consumer || "-"} ip=${ip}`);
  return done(200, { partialSuccess: {} });
}

module.exports = { ingest, otlpRows, anyVal, kvMap };
