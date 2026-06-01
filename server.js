// llm.hostbun.cc — single-URL OpenAI router.
//   model "local"                                        -> local LM Studio gemma-4-e4b-it-obliterated (DEFAULT, multimodal, open)
//   model "gemma-4-e4b-it-obliterated"                   -> same (full id)
//   model "gemma" / "google/gemma-4-26b-a4b"             -> local LM Studio gemma 26B MoE, no key
//   model "obliterated" / "qwen3.6-27b-obliterated"      -> local LM Studio Qwen3.6-27B abliterated (Bearer-gated if OBLIT_TOKEN set)
//   model "claude*" (e.g. claude-sonnet-4-6)             -> claude.hostbun.cc claudebox (real Claude via Claude Code), key injected
//   any other model                                      -> crazyrouter.com, key injected
//   (local models JIT-swap in VRAM — they don't all fit at once)
//   GET /v1/models                            -> local + claudebox + crazyrouter's list (merged)
//   /docs, docs.<host>                         -> docs page
//   /prices(.json)                             -> computed price feed (CORS *)
//   /local/*                                   -> kept for back-compat (strips /local -> llm.bofrid.dev)
const http = require("http");
const fs = require("fs");
const { Readable } = require("stream");

const KEY = process.env.CRAZYROUTER_KEY || "";
const CRAZY = (process.env.CRAZY_BASE || "https://crazyrouter.com").replace(/\/$/, "");
const LOCAL = (process.env.LOCAL_BASE || "https://llm.bofrid.dev").replace(/\/$/, "");
const PORT = parseInt(process.env.PORT || "80", 10);
const DOCS_FILE = process.env.DOCS_FILE || "/srv/docs/index.html";
const PRICES_FILE = process.env.PRICES_FILE || "/srv/prices.json";
const CANON = process.env.LOCAL_MODEL || "google/gemma-4-26b-a4b";
const OBLIT = process.env.LOCAL_MODEL_2 || "qwen3.6-27b-obliterated";
// Default local model: small (8GB) multimodal abliterated Gemma 4 E4B. "local" resolves here.
const E4B = process.env.LOCAL_MODEL_3 || "gemma-4-e4b-it-obliterated";
// Claude lane: models starting with "claude" route to the claudebox wrapper at
// claude.hostbun.cc (real Claude via Claude Code), with CLAUDE_TOKEN injected as Bearer.
const CLAUDE_BASE = (process.env.CLAUDE_BASE || "https://claude.hostbun.cc").replace(/\/$/, "");
const CLAUDE_TOKEN = process.env.CLAUDE_TOKEN || "ddash";
const isClaudeModel = (m) => typeof m === "string" && m.toLowerCase().startsWith("claude");
// Optional bearer gate for the obliterated (uncensored) model only. When set, requests
// routed to OBLIT must send `Authorization: Bearer <OBLIT_TOKEN>` (or `x-api-key`).
// gemma + cloud lanes stay open so existing callers (fb-bot, promopilot) are unaffected.
const OBLIT_TOKEN = process.env.OBLIT_TOKEN || "";

// ── JSON-output enforcement ──
// When a /chat/completions request sets response_format = {type:"json_object"} or
// {type:"json_schema"} (or the string "json_object"), the gateway buffers the upstream reply,
// checks the assistant message content actually parses as JSON, and — if it doesn't — re-prompts
// the SAME model with a corrective message ("your reply was not valid JSON, remake it") up to
// JSON_MAX_RETRIES times. A reply wrapped in ```json fences is auto-repaired (unfenced) instead
// of wasting a round-trip. If the model still won't comply, the caller gets HTTP 422 with code
// "json_validation_failed" rather than the malformed body. Disable with JSON_ENFORCE=0.
const JSON_ENFORCE = (process.env.JSON_ENFORCE || "1") !== "0";
const JSON_MAX_RETRIES = parseInt(process.env.JSON_MAX_RETRIES || "2", 10);

// ── error → HyperDX (OTLP logs, service.name=llm.hostbun.cc). Auth header has NO "Bearer". ──
const HDX_KEY = process.env.HYPERDX_INGEST_API_KEY || "";
const HDX_URL = process.env.HYPERDX_OTLP_URL || "https://otel.hyperdx.hostbun.cc/v1/logs";
function shipError(message, attrs) {
  if (!HDX_KEY) return;
  const payload = { resourceLogs: [{
    resource: { attributes: [
      { key: "service.name", value: { stringValue: "llm.hostbun.cc" } },
      { key: "deployment.environment", value: { stringValue: "prod" } },
    ] },
    scopeLogs: [{ logRecords: [{
      timeUnixNano: String(Date.now()) + "000000",
      severityText: "ERROR", severityNumber: 17,
      body: { stringValue: String(message).slice(0, 2000) },
      attributes: Object.entries(attrs || {}).map(([k, v]) => ({ key: k, value: { stringValue: String(v).slice(0, 500) } })),
    }] }],
  }] };
  fetch(HDX_URL, { method: "POST", headers: { "content-type": "application/json", authorization: HDX_KEY }, body: JSON.stringify(payload) }).catch(() => {});
}

// Alias (lowercased) -> the exact model id sent to LM Studio. "local" (the default selector)
// maps to the small multimodal E4B; "gemma" + the 26B full id stay on the gemma MoE
// (back-compat for fb-bot/promopilot); "obliterated" + its full id map to the Qwen3.6-27B
// abliterated model. Exact match only, so cloud models that merely start with "gemma" aren't
// hijacked. The local models can't all fit VRAM at once — LM Studio JIT-swaps on request.
const LOCAL_MAP = new Map([
  ["local", E4B],
  [E4B.toLowerCase(), E4B],
  ["gemma", CANON],
  [CANON.toLowerCase(), CANON],
  ["obliterated", OBLIT],
  ["obliteratus", OBLIT],
  [OBLIT.toLowerCase(), OBLIT],
]);
const localTarget = (m) => (m == null ? null : LOCAL_MAP.get(String(m).toLowerCase()) || null);
const isLocalModel = (m) => localTarget(m) !== null;

const HOP_REQ = new Set(["host", "connection", "content-length", "accept-encoding",
  "keep-alive", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const HOP_RES = new Set(["connection", "content-length", "content-encoding",
  "transfer-encoding", "keep-alive", "te", "trailer", "upgrade"]);

const readBody = (req) => new Promise((resolve) => {
  const c = [];
  req.on("data", (d) => c.push(d));
  req.on("end", () => resolve(Buffer.concat(c)));
  req.on("error", () => resolve(Buffer.concat(c)));
});

function sendFile(res, path, type, cors) {
  fs.readFile(path, (e, buf) => {
    if (e) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    const h = { "content-type": type };
    if (cors) h["access-control-allow-origin"] = "*";
    res.writeHead(200, h);
    res.end(buf);
  });
}

// Copy the incoming headers minus hop-by-hop ones, applying lane auth (injected crazyrouter key
// or a per-lane bearer token). Shared by the streaming passthrough and the JSON-enforcing path.
function buildHeaders(req, { injectKey, authToken } = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_REQ.has(k.toLowerCase())) headers[k] = v;
  }
  if (injectKey) headers["authorization"] = `Bearer ${KEY}`;
  else if (authToken) headers["authorization"] = `Bearer ${authToken}`;
  return headers;
}

async function proxy(req, res, base, { bodyBuf, injectKey, authToken, rewriteModel, model, lane } = {}) {
  const target = base + req.url;
  const ip = req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const headers = buildHeaders(req, { injectKey, authToken });
  let body = bodyBuf;
  if (rewriteModel && bodyBuf && bodyBuf.length) {
    try {
      const j = JSON.parse(bodyBuf.toString());
      if (j && j.model) { j.model = rewriteModel; body = Buffer.from(JSON.stringify(j)); headers["content-type"] = "application/json"; }
    } catch { /* leave body as-is */ }
  }
  const init = { method: req.method, headers, redirect: "follow" };
  if (!["GET", "HEAD"].includes(req.method) && body && body.length) init.body = body;
  let up;
  try { up = await fetch(target, init); }
  catch (e) {
    console.error(`[err] fetch-failed lane=${lane || "?"} model=${model || "-"} ${target}: ${e.message}`);
    shipError(`upstream fetch failed: ${e.message}`, { model: model || "-", lane: lane || "?", ip, target });
    res.writeHead(502, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "upstream fetch failed: " + e.message } }));
  }
  if (up.status >= 400) {
    console.error(`[err] upstream=${up.status} lane=${lane || "?"} model=${model || "-"} ${target}`);
    up.clone().text().then((t) => shipError(`upstream ${up.status} ${req.method} ${req.url}`, { model: model || "-", lane: lane || "?", ip, status: up.status, body: t })).catch(() => {});
  }
  const rh = {};
  up.headers.forEach((v, k) => { if (!HOP_RES.has(k.toLowerCase())) rh[k] = v; });
  res.writeHead(up.status, rh);
  if (up.body) Readable.fromWeb(up.body).pipe(res);
  else res.end();
}

// True when the request asks the model to emit JSON (OpenAI `response_format`).
const wantsJsonFormat = (o) => {
  const rf = o && o.response_format;
  if (!rf) return false;
  const t = typeof rf === "string" ? rf : rf.type;
  return t === "json_object" || t === "json_schema";
};

// Strip a single surrounding ```json … ``` (or ``` … ```) fence, if present.
function stripFences(s) {
  const m = String(s).trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : String(s).trim();
}

// Validate that the assistant content is valid JSON. Returns {ok:true} when it parses as-is,
// {ok:true, repaired:true, value} when only a ```json fence had to be stripped, or
// {ok:false, error} otherwise. (Structural JSON only — dependency-free, no JSON-Schema validation.)
function validateJsonContent(content) {
  if (content == null || content === "") return { ok: false, error: "empty response content" };
  try { JSON.parse(content); return { ok: true, repaired: false }; }
  catch (e1) {
    const stripped = stripFences(content);
    if (stripped !== content) {
      try { JSON.parse(stripped); return { ok: true, repaired: true, value: stripped }; }
      catch { /* still bad — fall through to the retry path */ }
    }
    return { ok: false, error: e1.message };
  }
}

// Emit the validated completion. Non-streaming → the buffered JSON body verbatim. If the caller
// asked for stream:true we reconstruct a minimal OpenAI SSE (content in one delta + stop + [DONE])
// so their SSE parser is satisfied — we had to buffer upstream to validate, so a true token stream
// isn't possible once enforcement is on.
function finishJson(res, wantStream, parsed, rawText) {
  if (!wantStream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(rawText);
  }
  const choice = (parsed.choices && parsed.choices[0]) || {};
  const content = (choice.message && choice.message.content) || "";
  const meta = { id: parsed.id || "chatcmpl-json", created: parsed.created || Math.floor(Date.now() / 1000), model: parsed.model || "" };
  const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ ...meta, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish_reason || null }] })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(chunk({ role: "assistant", content }, null));
  res.write(chunk({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

// JSON-enforced chat completion: buffer upstream (forced non-stream), validate the content parses
// as JSON, and on failure re-prompt the model with the parse error so it remakes a valid answer.
async function jsonEnforce(req, res, route) {
  const { base, injectKey, authToken, rewriteModel, model, lane, ip, bodyBuf } = route;
  const reqObj = JSON.parse(bodyBuf.toString());           // caller already verified this parses
  const wantStream = !!reqObj.stream;
  reqObj.stream = false;                                   // must see the whole body to validate
  if (rewriteModel) reqObj.model = rewriteModel;
  const messages = Array.isArray(reqObj.messages) ? reqObj.messages.slice() : [];
  const headers = buildHeaders(req, { injectKey, authToken });
  headers["content-type"] = "application/json";
  headers["accept"] = "application/json";
  const target = base + req.url;

  let lastErr = "", lastRaw = "";
  for (let attempt = 0; attempt <= JSON_MAX_RETRIES; attempt++) {
    reqObj.messages = messages;
    let up;
    try { up = await fetch(target, { method: req.method, headers, redirect: "follow", body: Buffer.from(JSON.stringify(reqObj)) }); }
    catch (e) {
      console.error(`[err] json-enforce fetch-failed lane=${lane} model=${model || "-"} ${target}: ${e.message}`);
      shipError(`json-enforce upstream fetch failed: ${e.message}`, { model: model || "-", lane, ip, target });
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "upstream fetch failed: " + e.message } }));
    }
    const text = await up.text();
    if (up.status >= 400) {                                // upstream error — surface it, don't retry
      console.error(`[err] upstream=${up.status} lane=${lane} model=${model || "-"} ${target} (json-enforce)`);
      shipError(`upstream ${up.status} ${req.method} ${req.url} (json-enforce)`, { model: model || "-", lane, ip, status: up.status, body: text });
      const rh = {}; up.headers.forEach((v, k) => { if (!HOP_RES.has(k.toLowerCase())) rh[k] = v; });
      res.writeHead(up.status, rh);
      return res.end(text);
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* upstream sent a non-JSON envelope */ }
    const msg = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message;
    // Tool/function call with no text content — response_format doesn't govern this; pass through.
    if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length && (msg.content == null || msg.content === "")) {
      return finishJson(res, wantStream, parsed, text);
    }
    const content = msg && typeof msg.content === "string" ? msg.content : null;
    const v = validateJsonContent(content);
    if (v.ok) {
      if (v.repaired) { msg.content = v.value; return finishJson(res, wantStream, parsed, JSON.stringify(parsed)); }
      return finishJson(res, wantStream, parsed, text);
    }
    lastErr = v.error; lastRaw = content == null ? "" : content;
    console.error(`[err] json-invalid lane=${lane} model=${model || "-"} attempt=${attempt + 1}/${JSON_MAX_RETRIES + 1}: ${v.error}`);
    if (attempt < JSON_MAX_RETRIES) {
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({ role: "user", content: `Your previous reply was not valid JSON and failed to parse (error: ${v.error}). Respond again with ONLY a single valid JSON value — no markdown code fences, no commentary, nothing before or after the JSON.` });
    }
  }
  shipError(`json enforcement failed after ${JSON_MAX_RETRIES + 1} attempts`, { model: model || "-", lane, ip, error: lastErr });
  res.writeHead(422, { "content-type": "application/json" });
  res.end(JSON.stringify({
    error: {
      message: `Model did not return valid JSON after ${JSON_MAX_RETRIES + 1} attempts despite response_format enforcement. Last parse error: ${lastErr}`,
      type: "invalid_response_error", code: "json_validation_failed",
    },
    last_content: lastRaw.slice(0, 4000),
  }));
}

async function mergedModels(res) {
  const local = [
    { id: "local", object: "model", owned_by: "local-lmstudio" },
    { id: E4B, object: "model", owned_by: "local-lmstudio" },
    { id: CANON, object: "model", owned_by: "local-lmstudio" },
    { id: OBLIT, object: "model", owned_by: "local-lmstudio" },
  ];
  // claudebox models (real Claude). Fetched independently so a dead crazyrouter key
  // doesn't hide them. owned_by tags the lane.
  let claude = [];
  try {
    const c = await fetch(CLAUDE_BASE + "/v1/models", { headers: { authorization: `Bearer ${CLAUDE_TOKEN}` } });
    const cj = await c.json();
    claude = ((cj && cj.data) || []).map((m) => ({ ...m, owned_by: "claudebox" }));
  } catch { /* claudebox down — skip */ }
  // crazyrouter's full catalog (may be empty if the key is dead — that's fine).
  let cloud = [];
  try {
    const u = await fetch(CRAZY + "/v1/models", { headers: { authorization: `Bearer ${KEY}` } });
    const j = await u.json();
    cloud = (j && j.data) || [];
  } catch { /* crazyrouter down — skip */ }
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify({ object: "list", data: [...local, ...claude, ...cloud] }));
}

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || "").toLowerCase();
  const path = (req.url || "/").split("?")[0];

  if (host.startsWith("docs.") || path === "/docs" || path.startsWith("/docs/") || path === "/docs/")
    return sendFile(res, DOCS_FILE, "text/html; charset=utf-8", false);
  if (path === "/prices.json" || path === "/prices")
    return sendFile(res, PRICES_FILE, "application/json", true);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
    return res.end();
  }
  if (path.startsWith("/local/")) {
    const bodyBuf = ["GET", "HEAD"].includes(req.method) ? Buffer.alloc(0) : await readBody(req);
    req.url = req.url.slice("/local".length);
    return proxy(req, res, LOCAL, { bodyBuf });
  }
  if (req.method === "GET" && (path === "/v1/models" || path === "/api/v1/models"))
    return mergedModels(res);

  const bodyBuf = ["GET", "HEAD"].includes(req.method) ? Buffer.alloc(0) : await readBody(req);
  let model = null;
  if (bodyBuf.length) { try { model = JSON.parse(bodyBuf.toString()).model; } catch { /* not json */ } }
  // Per-request attribution (no prompt bodies): who is spending and on which lane.
  const ip = req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const lane = isLocalModel(model) ? "local" : isClaudeModel(model) ? "claude" : "cloud";
  console.log(`[req] ${new Date().toISOString()} ip=${ip} ${req.method} ${path} model=${model || "-"} -> ${lane} ua="${String(req.headers["user-agent"] || "").slice(0, 50)}"`);
  // Resolve the lane into a concrete upstream route (base + auth + any model rewrite).
  let route;
  if (isClaudeModel(model)) {
    // claude.hostbun.cc claudebox — inject the wrapper's bearer token, pass model through unchanged.
    route = { base: CLAUDE_BASE, authToken: CLAUDE_TOKEN };
  } else if (isLocalModel(model)) {
    const target = localTarget(model);
    if (target === OBLIT && OBLIT_TOKEN) {
      const auth = String(req.headers["authorization"] || "");
      const xkey = String(req.headers["x-api-key"] || "");
      if (auth !== `Bearer ${OBLIT_TOKEN}` && xkey !== OBLIT_TOKEN) {
        console.error(`[err] 401 obliterated unauthorized ip=${ip}`);
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
        return res.end(JSON.stringify({ error: { message: `model '${OBLIT}' requires Authorization: Bearer <token>`, type: "invalid_request_error", code: "unauthorized" } }));
      }
    }
    route = { base: LOCAL, injectKey: false, rewriteModel: target };
  } else {
    route = { base: CRAZY, injectKey: true };
  }

  // JSON-output enforcement: only for chat completions that request a JSON response_format.
  // Everything else streams straight through unchanged.
  if (JSON_ENFORCE && req.method === "POST" && path.endsWith("/chat/completions") && bodyBuf.length) {
    let reqObj = null;
    try { reqObj = JSON.parse(bodyBuf.toString()); } catch { /* not JSON — passthrough */ }
    if (reqObj && wantsJsonFormat(reqObj)) {
      console.log(`[req] json-enforce model=${model || "-"} -> ${lane}`);
      return jsonEnforce(req, res, { ...route, model, lane, ip, bodyBuf });
    }
  }
  return proxy(req, res, route.base, { ...route, bodyBuf, model, lane });
});

server.listen(PORT, () => console.log(`llm-hostbun-proxy on :${PORT} crazy=${CRAZY} local=${LOCAL} key=${KEY ? "set" : "MISSING"}`));
