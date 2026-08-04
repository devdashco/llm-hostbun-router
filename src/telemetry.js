// Shaping a request/response into a call-log row, and shipping errors to HyperDX.
// Pure-ish: reads CFG, writes nothing. The extractors must never throw on a malformed body — a
// caller sending garbage still gets proxied, and a log line is not worth a 500.
const { CFG } = require("./config");
// keyLabel() needs it. routing does not require telemetry, so this cannot cycle.
const { isGated } = require("./routing");
// `clip` was USED here but never imported. It never crashed because every caller sat inside a
// `try { ... } catch { return null; }`, so the ReferenceError was swallowed and reqContent came back
// null — silently, on every non-claudecode call (the claudecode `full` branch returns before
// reaching clip, which is why prompts were recorded for Claude traffic and nothing else). db does
// not require telemetry, so this cannot cycle.
const { clip } = require("./db");

// ── error → HyperDX (OTLP logs, service.name=llm.hostbun.cc). Auth header has NO "Bearer". ──
const HDX_KEY = process.env.HYPERDX_INGEST_API_KEY || "";
const HDX_URL = process.env.HYPERDX_OTLP_URL || "https://otel.hyperdx.hostbun.cc/v1/logs";

function keyLabel(route) {
  if (route.provider === "crazyrouter") return "crazyrouterKey";
  if (route.provider === "openrouter") return "openrouterKey";
  if (route.provider === "claudecode") return "claudecode-pool";
  if (route.provider === "local") return isGated(route.target) && CFG.oblitToken ? "oblitToken" : "none (open)";
  return "—";
}

// (Removed: the wrapper-account label reader. The gateway picks the account itself now, so the log is
// attributed at dispatch time — no need to read it back out of a wrapper's response header.)

// Extract the prompt text from a request body (chat messages / responses input / prompt).
// full=true (local-dev anthropic provider) saves the ENTIRE turn — system + tools + messages, uncapped —
// so every chat is preserved verbatim. Other providers keep the clipped messages-only view (prod DB size).
// Distinct MCP servers + counts from a tools[] array. Claude Code ships ~1000 tool
// DEFINITIONS (name + full input_schema) on EVERY request — ~2.4 MB of mostly-identical
// JSON. We keep the analysis signal (how many tools, which MCP servers) and DROP the schemas,
// so the full-save is the conversation (system+messages+response), not a megabyte of tool specs.
function toolsSummary(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  // handle both dialects: Anthropic {name,...} and OpenAI {type:"function",function:{name}}
  const names = tools.map((t) => t && (t.name || (t.function && t.function.name))).filter(Boolean);
  const mcp = names.filter((n) => n.startsWith("mcp__"));
  const servers = [...new Set(mcp.map((n) => n.split("__")[1]).filter(Boolean))].sort();
  return { count: names.length, mcp: mcp.length, builtin: names.length - mcp.length, servers };
}

// Per-request SHAPE metrics for the call log — answers "what's loaded into this
// conversation and how big is it": how many tools (and how many are MCP), which MCP
// servers, the tool-schema tax in KB (the ~350K-token sink), the conversation length
// (message count), and the system-prompt size. Fail-safe: nulls on any parse issue.
// Parse a request body ONCE. The three extractors below each used to do their own
// JSON.parse(bodyBuf.toString()), and proxy() calls all three on every request — so a body was
// parsed three times and stringified to a fresh JS string three times. Measured on a 340 KB body
// (the 227-message/86k-token agent transcript shape this router actually carries): 916 µs for the
// three, against 280 µs for one parse. 636 µs per request of pure duplicate work, on the hottest
// path in the process. Returns null on a non-JSON body; every extractor already treats that as
// "nothing to report", which is why they can share one result.
function parseReq(bodyBuf) {
  if (!bodyBuf || !bodyBuf.length) return null;
  try { return JSON.parse(bodyBuf.toString()); } catch { return null; }
}

function reqMetaFrom(j) {
  const out = { toolCount: null, mcpTools: null, toolServers: null, toolsKb: null, msgCount: null, systemKb: null };
  if (!j) return out;
  if (Array.isArray(j.tools) && j.tools.length) {
    const s = toolsSummary(j.tools);
    out.toolCount = s.count;
    out.mcpTools = s.mcp;
    out.toolServers = (s.servers || []).join(",") || null;
    out.toolsKb = Math.round(JSON.stringify(j.tools).length / 1024);
  }
  if (Array.isArray(j.messages)) out.msgCount = j.messages.length;
  if (j.system != null) out.systemKb = Math.round(JSON.stringify(j.system).length / 1024);
  return out;
}

function reqContentFrom(j, full) {
  if (!CFG.logging.content || !j) return null;
  // Full local-dev save: the conversation verbatim + a compact tools SUMMARY (not the schemas).
  if (full) return JSON.stringify({ model: j.model, system: j.system, messages: j.messages, tools: toolsSummary(j.tools) });
  if (Array.isArray(j.messages)) return clip(JSON.stringify(j.messages));
  if (j.input != null) return clip(typeof j.input === "string" ? j.input : JSON.stringify(j.input));
  if (typeof j.prompt === "string") return clip(j.prompt);
  return null;
}
// Kept as a buffer wrapper because server.js's refusal paths (401/400) genuinely have only the
// raw body — they run before anything has parsed it. Its two siblings had no such caller and
// were removed; "each is still correct alone" is not a reason to export a function nobody calls.
function extractRequestContent(bodyBuf, full) { return reqContentFrom(parseReq(bodyBuf), full); }

// Which project a call belongs to. Apps declare it via the `X-Project` header (preferred);
// we also accept `X-Project-Id`, a body `project`/`metadata.project` field, or the OpenAI
// `user` field as fallbacks. Normalised to a short lowercase slug. Returns "" if unset.

function reqParamsFrom(j) {
  const out = { effort: null, thinkingTokens: null, maxTokens: null, temperature: null, userId: null };
  if (!j) return out;
  // effort: OpenAI sends reasoning_effort/reasoning.effort as a label. Claude Code / Anthropic
  // /v1/messages has no effort field — the effort IS the extended-thinking budget, so we derive a
  // label from thinking.budget_tokens too (so the dev log shows an effort tier either dialect).
  out.effort = j.reasoning_effort || (j.reasoning && j.reasoning.effort) || null;
  if (j.thinking && typeof j.thinking === "object") {
    out.thinkingTokens = j.thinking.type === "enabled"
      ? (typeof j.thinking.budget_tokens === "number" ? j.thinking.budget_tokens : null)
      : 0;
  } else if (typeof j.max_thinking_tokens === "number") {
    out.thinkingTokens = j.max_thinking_tokens;
  }
  if (!out.effort && typeof out.thinkingTokens === "number" && out.thinkingTokens > 0) {
    // Rough tiers matching Claude Code's effort→budget mapping (labels only; thinking_tokens keeps the raw).
    out.effort = out.thinkingTokens >= 32000 ? "high" : out.thinkingTokens >= 8000 ? "medium" : "low";
  }
  const mt = j.max_tokens ?? j.max_completion_tokens;
  if (typeof mt === "number") out.maxTokens = mt;
  if (typeof j.temperature === "number") out.temperature = j.temperature;
  // Claude Code stamps a per-session identity in metadata.user_id; also accept a top-level user.
  out.userId = (j.metadata && (j.metadata.user_id || j.metadata.userId)) || (typeof j.user === "string" ? j.user : null) || null;
  return out;
}

// Everything proxy() needs off the request body, from ONE parse. The three single-purpose
// extractors above stay exported: they are the readable unit, and each is still correct alone.
function extractReqAll(bodyBuf, full) {
  const j = parseReq(bodyBuf);
  return { reqContent: reqContentFrom(j, full), ...reqParamsFrom(j), ...reqMetaFrom(j) };
}

// Which project a call belongs to. Apps declare it via the `X-Project` header (preferred);
// we also accept `X-Project-Id`, a body `project`/`metadata.project` field, or the OpenAI
// `user` field as fallbacks. Normalised to a short lowercase slug. Returns "" if unset.

// Normalise a usage block to {prompt_tokens, completion_tokens, total_tokens}. OpenAI already
// uses those names; anthropic /v1/messages uses {input_tokens, output_tokens} (+ cache_* which
// count toward input). Passing an unknown shape through is harmless — recordCall reads the three
// canonical keys and stores null for whatever is missing.
function normalizeUsage(u) {
  if (!u || typeof u !== "object") return u;
  if (u.prompt_tokens != null || u.completion_tokens != null) return u; // already OpenAI-shaped
  if (u.input_tokens != null || u.output_tokens != null) {
    const inp = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const out = u.output_tokens || 0;
    return { ...u, prompt_tokens: inp, completion_tokens: out, total_tokens: inp + out };
  }
  return u;
}

// Pull {content, usage} from a finished upstream body (handles SSE streams + plain JSON).
function extractResponseBody(buf, isStream) {
  const out = { content: null, usage: null, stopReason: null };
  if (!buf || !buf.length) return out;
  const text = buf.toString();
  if (isStream) {
    let content = "";
    let rawUsage = null;
    const tools = [];   // tool_use calls the model made in this stream (Claude Code is tool-heavy)
    const mergeUsage = (u) => { if (u && typeof u === "object") rawUsage = { ...(rawUsage || {}), ...u }; };
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const data = s.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        // OpenAI chat.completions delta
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (d && typeof d.content === "string") content += d.content;
        if (d && Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) if (tc.function && tc.function.name) tools.push(tc.function.name);
        if (j.usage) mergeUsage(j.usage);
        // Anthropic /v1/messages events: text in content_block_delta, usage split
        // across message_start (input) and message_delta (output). tool_use turns emit NO text —
        // capture the tool name off content_block_start so tool-only replies aren't logged empty.
        if (j.type === "content_block_delta" && j.delta && typeof j.delta.text === "string") content += j.delta.text;
        if (j.type === "content_block_start" && j.content_block && j.content_block.type === "tool_use" && j.content_block.name) tools.push(j.content_block.name);
        if (j.type === "message_start" && j.message && j.message.usage) mergeUsage(j.message.usage);
        // stop_reason arrives on message_delta (anthropic) / the finish_reason in the last openai chunk.
        if (j.type === "message_delta" && j.delta && j.delta.stop_reason) out.stopReason = j.delta.stop_reason;
        if (d && j.choices[0].finish_reason) out.stopReason = j.choices[0].finish_reason;
      } catch { /* partial / non-json chunk */ }
    }
    if (tools.length) out.toolsCalled = tools;
    // Prefer text; if a turn was pure tool_use (no text), record the calls so it isn't saved blank.
    out.content = content || (tools.length ? `[tool_use] ${tools.join(", ")}` : null);
    if (rawUsage) out.usage = normalizeUsage(rawUsage);
    return out;
  }
  try {
    const j = JSON.parse(text);
    if (j.usage) out.usage = normalizeUsage(j.usage);
    const m = j.choices && j.choices[0] && j.choices[0].message;
    if (m && (m.content || m.reasoning_content)) out.content = m.content || m.reasoning_content;
    else if (Array.isArray(j.content)) { // anthropic /v1/messages: content is an array of blocks
      out.content = j.content.map((b) => (b && typeof b.text === "string") ? b.text : JSON.stringify(b)).join("");
      const tc = j.content.filter((b) => b && b.type === "tool_use").map((b) => b.name).filter(Boolean);
      if (tc.length) out.toolsCalled = tc;
    }
    else if (Array.isArray(j.output)) out.content = JSON.stringify(j.output); // responses API
    else if (j.error) out.content = JSON.stringify(j.error);
    out.stopReason = j.stop_reason || (j.choices && j.choices[0] && j.choices[0].finish_reason) || null;
  } catch { /* non-json envelope */ }
  return out;
}

// Persist one call. `rec` carries the request-side fields; never throws.
// Harvest the free rate-limit snapshot off an upstream response's headers. Anthropic stamps
// `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}` + `anthropic-organization-id`
// on every /v1/messages response — so any real call tells us that account's live 5h/7d headroom
// at zero token cost. Upsert keyed by org-id → always the freshest per account. No-op unless the
// headers are present (only the anthropic provider / native passthrough carries them).

// One OTLP log record → HyperDX. Fire-and-forget; a no-op when no ingest key is configured, so it
// never blocks or fails a request. `severityNumber` follows the OTLP scale (ERROR=17, WARN=13, INFO=9).
// Repeat collapse. Every occurrence used to ship, so ONE persistently broken upstream buries
// everything else: measured 2026-07-26, the dead image ingress had put 601 copies of
// "upstream 504 POST /v1/images/generations" into HyperDX against ~529 rows of all other signals
// combined — more than half the router's error volume was a single fault repeating.
//
// The rule is never to drop a DISTINCT signal, only repeats of one already reported. A signature is
// the severity + message (attrs vary per call: ip, model, project), so the first occurrence ships
// immediately and further identical ones are summarised once a minute carrying how many were seen.
// A new fault is therefore never delayed — only a fault you have already been told about.
// Env-tunable only so the suppressed-COUNT path is testable without a 60s sleep; production never
// sets it. An untestable branch is one that rots, and the count is the part that makes suppression
// honest rather than lossy.
const SHIP_WINDOW_MS = parseInt(process.env.SHIP_WINDOW_MS || "60000", 10);
const _shipSeen = new Map();   // signature -> { at, suppressed }
function shipThrottle(sig, now) {
  const e = _shipSeen.get(sig);
  if (!e || now - e.at >= SHIP_WINDOW_MS) {
    const suppressed = e ? e.suppressed : 0;
    _shipSeen.set(sig, { at: now, suppressed: 0 });
    // Prune opportunistically: an unbounded map keyed by message text is a slow leak on a router
    // that runs for weeks. Anything untouched for 10 windows cannot be mid-suppression.
    if (_shipSeen.size > 500) {
      for (const [k, v] of _shipSeen) if (now - v.at > SHIP_WINDOW_MS * 10) _shipSeen.delete(k);
    }
    return { send: true, suppressed };
  }
  e.suppressed++;
  return { send: false, suppressed: 0 };
}

function shipLog(severityText, severityNumber, message, attrs) {
  if (!HDX_KEY) return;
  const gate = shipThrottle(severityText + "\u0000" + message, Date.now());
  if (!gate.send) return;
  if (gate.suppressed > 0) {
    attrs = { ...(attrs || {}), repeats_suppressed: gate.suppressed, repeat_window_s: SHIP_WINDOW_MS / 1000 };
    message = `${message} (+${gate.suppressed} more in the last ${SHIP_WINDOW_MS / 1000}s)`;
  }
  const payload = { resourceLogs: [{
    resource: { attributes: [
      { key: "service.name", value: { stringValue: "llm.hostbun.cc" } },
      { key: "deployment.environment", value: { stringValue: "prod" } },
    ] },
    scopeLogs: [{ logRecords: [{
      timeUnixNano: String(Date.now()) + "000000",
      severityText, severityNumber,
      body: { stringValue: String(message).slice(0, 2000) },
      attributes: Object.entries(attrs || {}).map(([k, v]) => ({ key: k, value: { stringValue: String(v).slice(0, 500) } })),
    }] }],
  }] };
  // The alerting channel had no self-monitoring: a `.catch(() => {})` here meant a HyperDX outage or
  // a rotated ingest key dropped every WARN and ERROR with nothing anywhere saying so. An operator
  // watching HyperDX for `account_disabled` or `waste_burn` would see silence and read it as
  // nothing to report — which is the same failure the db counter exists to prevent, one level
  // deeper: not "the scan crashed" but "the scan found something and telling anyone failed".
  // Counted rather than logged per-failure on purpose: a dead ingest fails on EVERY event, and a
  // warning per failure would be the noise the throttle above exists to stop.
  fetch(HDX_URL, { method: "POST", headers: { "content-type": "application/json", authorization: HDX_KEY }, body: JSON.stringify(payload) })
    .then((r) => { if (!r.ok) noteShipFail(`HTTP ${r.status}`); })
    .catch((e) => noteShipFail(e.message));
}
// Counters since boot, surfaced by shipHealth() the way dbWriteHealth() surfaces dropped rows. The
// first failure logs once so it appears in the container log too; the rest only move the count.
let shipFails = 0, lastShipErr = null, lastShipErrAt = 0;
function noteShipFail(why) {
  if (!shipFails) console.warn(`[ship] telemetry delivery failing: ${why} — WARN/ERROR events are not reaching HyperDX`);
  shipFails++; lastShipErr = why; lastShipErrAt = Date.now();
}
const shipHealth = () => ({ failures: shipFails, lastError: lastShipErr, lastErrorAt: lastShipErrAt || null });
// An upstream/runtime failure — the error stream in HyperDX.
function shipError(message, attrs) { shipLog("ERROR", 17, message, attrs); }
// A structured, ALERTABLE operational signal (not an error): an app reaching for a premium model, an
// account cooled off a 429, a login auto-disabled. Same plumbing as shipError, WARN severity, and an
// `event` attribute so HyperDX can alert per event type. These are also in the Postgres call log —
// this puts them where you'd set an alert, not just where you'd run a query after the fact.
function shipEvent(message, attrs) { shipLog("WARN", 13, message, attrs); }


// llama.cpp only reads the flag out of `chat_template_kwargs` — a top-level `enable_thinking` is
// accepted and silently ignored. Callers send the top-level form, so hoist it rather than drop it.
function applyLocalThinkingDefault(j) {
  if (!j || typeof j !== "object") return j;
  const kw = j.chat_template_kwargs;
  const asked = kw && typeof kw === "object" && kw.enable_thinking !== undefined;
  if (!asked) {
    const top = typeof j.enable_thinking === "boolean" ? j.enable_thinking : false;
    j.chat_template_kwargs = { ...(kw && typeof kw === "object" ? kw : {}), enable_thinking: top };
  }
  delete j.enable_thinking;
  return j;
}
const isChatCompletions = (url) => typeof url === "string" && url.split("?")[0].endsWith("/chat/completions");

module.exports = { shipHealth,
  keyLabel, toolsSummary, extractRequestContent, extractReqAll,
  normalizeUsage, extractResponseBody, shipError, shipEvent, applyLocalThinkingDefault, isChatCompletions,
};
