// llm.hostbun.cc — single-URL OpenAI router + admin UI.
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
//   /admin, /admin/api/*                       -> password-gated admin UI (edit routing/models/keys live)
//
// Routing is driven by a live, mutable CFG object. CFG is seeded from env defaults and then
// overlaid with /data/config.json (a Coolify-managed persistent volume) — so edits made in the
// admin UI take effect immediately AND survive restarts/reboots/redeploys. Nothing here needs a
// redeploy to change routing.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const url = require("url");
const { Readable } = require("stream");

const PORT = parseInt(process.env.PORT || "80", 10);
const DOCS_FILE = process.env.DOCS_FILE || "/srv/docs/index.html";
const ADMIN_FILE = process.env.ADMIN_FILE || "/srv/admin/index.html";
const PRICES_FILE = process.env.PRICES_FILE || "/srv/prices.json";
const CONFIG_FILE = process.env.CONFIG_FILE || "/data/config.json";
const CALLS_DB = process.env.CALLS_DB || "/data/calls.db";
// Max bytes of prompt / reply text stored per call (protects the DB from huge payloads).
const CONTENT_CAP = parseInt(process.env.CALL_CONTENT_CAP || "262144", 10); // 256 KiB

// Default local model ids (env-overridable). "local" -> small multimodal E4B; "gemma" -> 26B MoE;
// "obliterated" -> Qwen3.6-27B abliterated.
const CANON = process.env.LOCAL_MODEL || "google/gemma-4-26b-a4b";
const OBLIT = process.env.LOCAL_MODEL_2 || "qwen3.6-27b-obliterated";
const E4B = process.env.LOCAL_MODEL_3 || "gemma-4-e4b-it-obliterated";

// ── error → HyperDX (OTLP logs, service.name=llm.hostbun.cc). Auth header has NO "Bearer". ──
const HDX_KEY = process.env.HYPERDX_INGEST_API_KEY || "";
const HDX_URL = process.env.HYPERDX_OTLP_URL || "https://otel.hyperdx.hostbun.cc/v1/logs";

// ─────────────────────────────────────────────────────────────────────────────
// Live config: env defaults, then /data/config.json overlay.
// ─────────────────────────────────────────────────────────────────────────────
function envDefaults() {
  return {
    bases: {
      local: (process.env.LOCAL_BASE || "https://llm.bofrid.dev").replace(/\/$/, ""),
      crazy: (process.env.CRAZY_BASE || "https://crazyrouter.com").replace(/\/$/, ""),
      claude: (process.env.CLAUDE_BASE || "https://claude.hostbun.cc").replace(/\/$/, ""),
    },
    crazyKey: process.env.CRAZYROUTER_KEY || "",
    claudeToken: process.env.CLAUDE_TOKEN || "ddash",
    claudePrefix: "claude",
    // Bearer gate for the uncensored model(s). When oblitToken is set, requests routed to a model
    // id listed in gatedModels require Authorization: Bearer <oblitToken> (or x-api-key). Empty
    // token = open. gemma + cloud stay open so fb-bot/promopilot are unaffected.
    oblitToken: process.env.OBLIT_TOKEN || "",
    gatedModels: [OBLIT],
    // alias (lowercased) -> exact model id sent to LM Studio.
    localMap: {
      "local": E4B,
      [E4B.toLowerCase()]: E4B,
      "gemma": CANON,
      [CANON.toLowerCase()]: CANON,
      "obliterated": OBLIT,
      "obliteratus": OBLIT,
      [OBLIT.toLowerCase()]: OBLIT,
    },
    // ── flow control (admin-editable) ──
    // forceModel: when enabled, EVERY request is rewritten to this lane+model regardless of what
    // the caller asked for. The big red switch.
    forceModel: { enabled: false, lane: "claude", model: "" },
    // modelRoutes: explicit per-incoming-model overrides to ANY lane (highest priority after
    // forceModel). key = incoming model name (lowercased). value = { lane, model }.
    modelRoutes: {},
    // cloudPolicy governs models that fall through to the cloud (crazyrouter) lane:
    //   "open"      → forward anything (legacy behaviour)
    //   "allowlist" → only ids in cloudAllowlist reach crazyrouter; everything else → defaultRoute
    //   "off"       → nothing reaches crazyrouter; everything → defaultRoute
    cloudPolicy: "open",
    cloudAllowlist: [],
    // defaultRoute: where unknown / empty / cloud-blocked models go. lane "none" = reject with 400.
    defaultRoute: { lane: "none", model: "" },
    // JSON-output enforcement for chat completions that set response_format json_object/json_schema.
    jsonEnforce: (process.env.JSON_ENFORCE || "1") !== "0",
    jsonMaxRetries: parseInt(process.env.JSON_MAX_RETRIES || "2", 10),
    // Admin password (HMAC secret + login check). Weak default per request — rotate via the UI.
    adminPassword: process.env.ADMIN_PASSWORD || "ddash",
    // Call logging → SQLite at CALLS_DB. enabled: record any call metadata at all;
    // content: also store the prompt + the model's reply text (capped at CONTENT_CAP);
    // retain: keep at most this many rows (oldest pruned).
    logging: {
      enabled: (process.env.LOG_CALLS || "1") !== "0",
      content: (process.env.LOG_CONTENT || "1") !== "0",
      retain: parseInt(process.env.LOG_RETAIN || "50000", 10),
    },
  };
}

let CFG = envDefaults();

// Merge a saved overlay (from disk / admin POST) over a base, key by key, validating shapes.
function mergeConfig(base, saved) {
  const c = JSON.parse(JSON.stringify(base));
  if (!saved || typeof saved !== "object") return c;
  if (saved.bases && typeof saved.bases === "object") {
    for (const k of ["local", "crazy", "claude"]) {
      if (typeof saved.bases[k] === "string" && saved.bases[k].trim())
        c.bases[k] = saved.bases[k].trim().replace(/\/$/, "");
    }
  }
  if (saved.localMap && typeof saved.localMap === "object" && !Array.isArray(saved.localMap)) {
    const m = {};
    for (const [k, v] of Object.entries(saved.localMap)) {
      if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim())
        m[k.trim().toLowerCase()] = v.trim();
    }
    if (Object.keys(m).length) c.localMap = m;
  }
  if (Array.isArray(saved.gatedModels))
    c.gatedModels = saved.gatedModels.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  for (const k of ["crazyKey", "claudeToken", "claudePrefix", "oblitToken", "adminPassword"])
    if (typeof saved[k] === "string") c[k] = saved[k];
  if (typeof saved.jsonEnforce === "boolean") c.jsonEnforce = saved.jsonEnforce;
  if (Number.isInteger(saved.jsonMaxRetries) && saved.jsonMaxRetries >= 0 && saved.jsonMaxRetries <= 5)
    c.jsonMaxRetries = saved.jsonMaxRetries;
  // ── flow control ──
  const LANES = new Set(["local", "cloud", "claude"]);
  if (saved.forceModel && typeof saved.forceModel === "object") {
    const f = saved.forceModel;
    c.forceModel = {
      enabled: !!f.enabled,
      lane: LANES.has(f.lane) ? f.lane : "claude",
      model: typeof f.model === "string" ? f.model.trim() : "",
    };
  }
  if (saved.modelRoutes && typeof saved.modelRoutes === "object" && !Array.isArray(saved.modelRoutes)) {
    const mr = {};
    for (const [k, v] of Object.entries(saved.modelRoutes)) {
      if (typeof k === "string" && k.trim() && v && typeof v === "object" && LANES.has(v.lane))
        mr[k.trim().toLowerCase()] = { lane: v.lane, model: typeof v.model === "string" ? v.model.trim() : "" };
    }
    c.modelRoutes = mr;
  }
  if (["open", "allowlist", "off"].includes(saved.cloudPolicy)) c.cloudPolicy = saved.cloudPolicy;
  if (Array.isArray(saved.cloudAllowlist))
    c.cloudAllowlist = saved.cloudAllowlist.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  if (saved.defaultRoute && typeof saved.defaultRoute === "object") {
    const d = saved.defaultRoute;
    c.defaultRoute = {
      lane: ["none", "local", "cloud", "claude"].includes(d.lane) ? d.lane : "none",
      model: typeof d.model === "string" ? d.model.trim() : "",
    };
  }
  if (saved.logging && typeof saved.logging === "object") {
    const l = saved.logging;
    if (typeof l.enabled === "boolean") c.logging.enabled = l.enabled;
    if (typeof l.content === "boolean") c.logging.content = l.content;
    if (Number.isInteger(l.retain) && l.retain >= 100 && l.retain <= 1000000) c.logging.retain = l.retain;
  }
  if (!c.claudePrefix) c.claudePrefix = "claude";
  if (!c.adminPassword) c.adminPassword = "ddash";
  return c;
}

function loadConfig() {
  const base = envDefaults();
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    CFG = mergeConfig(base, JSON.parse(raw));
    console.log(`[cfg] loaded overrides from ${CONFIG_FILE}`);
  } catch (e) {
    CFG = base;
    if (e.code !== "ENOENT") console.error(`[cfg] load failed (${e.message}); using env defaults`);
  }
}

function persistConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(CFG, null, 2));
    return true;
  } catch (e) {
    console.error(`[cfg] persist failed: ${e.message}`);
    return false;
  }
}

loadConfig();

// ─────────────────────────────────────────────────────────────────────────────
// Call log → SQLite (node:sqlite, built in). One row per request that reaches a
// lane (incl. blocked/gated/error). Lives on the /data persistent volume so it
// survives restarts/redeploys. All DB work is wrapped so a logging failure can
// never break proxying.
// ─────────────────────────────────────────────────────────────────────────────
let db = null, insertStmt = null, pruneStmt = null, insertsSincePrune = 0;
function initDb() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    fs.mkdirSync(path.dirname(CALLS_DB), { recursive: true });
    db = new DatabaseSync(CALLS_DB);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    db.exec(`CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ip TEXT, ua TEXT, method TEXT, path TEXT,
      req_model TEXT, lane TEXT, sent_model TEXT, key_label TEXT,
      status INTEGER, duration_ms INTEGER, stream INTEGER,
      prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER,
      error TEXT, req_content TEXT, resp_content TEXT
    );`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_calls_model ON calls(req_model);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_calls_lane ON calls(lane);");
    insertStmt = db.prepare(`INSERT INTO calls
      (ts,ip,ua,method,path,req_model,lane,sent_model,key_label,status,duration_ms,stream,prompt_tokens,completion_tokens,total_tokens,error,req_content,resp_content)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    pruneStmt = db.prepare("DELETE FROM calls WHERE id NOT IN (SELECT id FROM calls ORDER BY id DESC LIMIT ?)");
    console.log(`[log] call DB ready at ${CALLS_DB}`);
  } catch (e) {
    db = null;
    console.error(`[log] call DB unavailable (${e.message}); call logging disabled`);
  }
}
initDb();

const clip = (s) => { const t = s == null ? "" : String(s); return t.length > CONTENT_CAP ? t.slice(0, CONTENT_CAP) : t; };

// Which credential a route uses (for the "which keys" view).
function keyLabel(route) {
  if (route.lane === "cloud") return "crazyKey";
  if (route.lane === "claude") return "claudeToken";
  if (route.lane === "local") return isGated(route.target) && CFG.oblitToken ? "oblitToken" : "none (open)";
  return "—";
}

// Extract the prompt text from a request body (chat messages / responses input / prompt).
function extractRequestContent(bodyBuf) {
  if (!CFG.logging.content || !bodyBuf || !bodyBuf.length) return null;
  try {
    const j = JSON.parse(bodyBuf.toString());
    if (Array.isArray(j.messages)) return clip(JSON.stringify(j.messages));
    if (j.input != null) return clip(typeof j.input === "string" ? j.input : JSON.stringify(j.input));
    if (typeof j.prompt === "string") return clip(j.prompt);
    return null;
  } catch { return null; }
}

// Pull {content, usage} from a finished upstream body (handles SSE streams + plain JSON).
function extractResponseBody(buf, isStream) {
  const out = { content: null, usage: null };
  if (!buf || !buf.length) return out;
  const text = buf.toString();
  if (isStream) {
    let content = "";
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const data = s.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (d && typeof d.content === "string") content += d.content;
        if (j.usage) out.usage = j.usage;
      } catch { /* partial / non-json chunk */ }
    }
    if (content) out.content = content;
    return out;
  }
  try {
    const j = JSON.parse(text);
    if (j.usage) out.usage = j.usage;
    const m = j.choices && j.choices[0] && j.choices[0].message;
    if (m && (m.content || m.reasoning_content)) out.content = m.content || m.reasoning_content;
    else if (Array.isArray(j.output)) out.content = JSON.stringify(j.output); // responses API
    else if (j.error) out.content = JSON.stringify(j.error);
  } catch { /* non-json envelope */ }
  return out;
}

// Persist one call. `rec` carries the request-side fields; never throws.
function recordCall(rec) {
  if (!db || !insertStmt || !CFG.logging.enabled) return;
  try {
    const u = rec.usage || {};
    insertStmt.run(
      rec.ts || Date.now(), rec.ip || null, rec.ua || null, rec.method || null, rec.path || null,
      rec.reqModel || null, rec.lane || null, rec.sentModel || null, rec.keyLabel || null,
      rec.status == null ? null : rec.status, rec.ms == null ? null : rec.ms, rec.stream ? 1 : 0,
      u.prompt_tokens ?? null, u.completion_tokens ?? null, u.total_tokens ?? null,
      rec.error || null,
      CFG.logging.content ? (rec.reqContent || null) : null,
      CFG.logging.content ? (rec.respContent == null ? null : clip(rec.respContent)) : null,
    );
    if (++insertsSincePrune >= 200) { insertsSincePrune = 0; try { pruneStmt.run(CFG.logging.retain); } catch {} }
  } catch (e) { /* never let logging break a request */ }
}

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

// ── lane resolution (reads live CFG) ──
const localTarget = (m) => (m == null ? null : CFG.localMap[String(m).toLowerCase()] || null);
const isClaudeModel = (m) => typeof m === "string" && m.toLowerCase().startsWith((CFG.claudePrefix || "claude").toLowerCase());
const isGated = (target) => Array.isArray(CFG.gatedModels) && CFG.gatedModels.includes(target);

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

function buildHeaders(req, { injectKey, authToken } = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_REQ.has(k.toLowerCase())) headers[k] = v;
  }
  if (injectKey) headers["authorization"] = `Bearer ${CFG.crazyKey}`;
  else if (authToken) headers["authorization"] = `Bearer ${authToken}`;
  return headers;
}

async function proxy(req, res, base, opts = {}) {
  const { bodyBuf, injectKey, authToken, rewriteModel, model, lane } = opts;
  const target = base + req.url;
  const ip = opts.ip || req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const t0 = Date.now();
  let stream = false;
  const headers = buildHeaders(req, { injectKey, authToken });
  let body = bodyBuf;
  if (bodyBuf && bodyBuf.length) {
    try {
      const j = JSON.parse(bodyBuf.toString());
      stream = !!j.stream;
      if (rewriteModel && j && j.model) { j.model = rewriteModel; body = Buffer.from(JSON.stringify(j)); headers["content-type"] = "application/json"; }
    } catch { /* leave body as-is */ }
  }
  // Common fields for the call-log row.
  const base_rec = {
    ts: t0, ip, ua: req.headers["user-agent"] || "", method: req.method, path: (req.url || "").split("?")[0],
    reqModel: model || null, lane: lane || "local", sentModel: rewriteModel || model || null,
    keyLabel: keyLabel({ lane: lane || "local", target: opts.target }), stream,
    reqContent: extractRequestContent(bodyBuf),
  };
  const init = { method: req.method, headers, redirect: "follow" };
  if (!["GET", "HEAD"].includes(req.method) && body && body.length) init.body = body;
  let up;
  try { up = await fetch(target, init); }
  catch (e) {
    console.error(`[err] fetch-failed lane=${lane || "?"} model=${model || "-"} ${target}: ${e.message}`);
    shipError(`upstream fetch failed: ${e.message}`, { model: model || "-", lane: lane || "?", ip, target });
    recordCall({ ...base_rec, status: 502, ms: Date.now() - t0, error: "upstream fetch failed: " + e.message });
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
  const isStream = (up.headers.get("content-type") || "").includes("text/event-stream");
  // Only chat/responses/completions calls carry content worth recording; for those we tee the
  // body (capped) to pull tokens + reply. /v1/models etc. are skipped to keep the log signal high.
  const recordThis = CFG.logging.enabled && req.method === "POST" && /\/(chat\/completions|responses|completions|messages|chat)$/.test(base_rec.path);
  if (up.body) {
    const r = Readable.fromWeb(up.body);
    if (recordThis) {
      const chunks = []; let size = 0;
      r.on("data", (d) => { if (size < CONTENT_CAP + 8192) { chunks.push(Buffer.from(d)); size += d.length; } });
      const done = () => {
        const ex = extractResponseBody(Buffer.concat(chunks), isStream);
        recordCall({ ...base_rec, status: up.status, ms: Date.now() - t0, usage: ex.usage, respContent: ex.content,
          error: up.status >= 400 ? `upstream ${up.status}` : null });
      };
      r.on("end", done); r.on("error", done);
    }
    r.pipe(res);
  } else {
    if (recordThis) recordCall({ ...base_rec, status: up.status, ms: Date.now() - t0, error: up.status >= 400 ? `upstream ${up.status}` : null });
    res.end();
  }
}

// True when the request asks the model to emit JSON (OpenAI `response_format`).
const wantsJsonFormat = (o) => {
  const rf = o && o.response_format;
  if (!rf) return false;
  const t = typeof rf === "string" ? rf : rf.type;
  return t === "json_object" || t === "json_schema";
};

function stripFences(s) {
  const m = String(s).trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : String(s).trim();
}

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

function jsonInstruction(rf) {
  let s = "Respond with ONLY a single valid JSON value — no markdown code fences, no commentary, nothing before or after the JSON.";
  const schema = rf && typeof rf === "object" && rf.type === "json_schema" && rf.json_schema && rf.json_schema.schema;
  if (schema) s += " It must conform to this JSON Schema: " + JSON.stringify(schema);
  return s;
}
function injectJsonInstruction(messages, rf) {
  const instr = jsonInstruction(rf);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && typeof messages[i].content === "string") {
      messages[i] = { ...messages[i], content: messages[i].content + "\n\n" + instr };
      return;
    }
  }
  messages.push({ role: "user", content: instr });
}

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

async function jsonEnforce(req, res, route) {
  const { base, injectKey, authToken, rewriteModel, model, lane, ip, bodyBuf } = route;
  const maxRetries = CFG.jsonMaxRetries;
  const reqObj = JSON.parse(bodyBuf.toString());           // caller already verified this parses
  const wantStream = !!reqObj.stream;
  const t0 = Date.now();
  const logRec = {
    ts: t0, ip, ua: req.headers["user-agent"] || "", method: req.method, path: (req.url || "").split("?")[0],
    reqModel: model || null, lane, sentModel: rewriteModel || model || null,
    keyLabel: keyLabel({ lane, target: route.target }), stream: wantStream,
    reqContent: extractRequestContent(bodyBuf),
  };
  const logJson = (status, parsed, error) => recordCall({ ...logRec, status, ms: Date.now() - t0,
    usage: parsed && parsed.usage, error,
    respContent: parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
      ? parsed.choices[0].message.content : null });
  reqObj.stream = false;                                   // must see the whole body to validate
  if (rewriteModel) reqObj.model = rewriteModel;
  const messages = Array.isArray(reqObj.messages) ? reqObj.messages.slice() : [];
  const rf = reqObj.response_format;
  const rfType = typeof rf === "string" ? rf : (rf && rf.type);
  if (lane === "claude" || (lane === "local" && rfType === "json_object")) {
    delete reqObj.response_format;
    injectJsonInstruction(messages, rf);
  }
  const headers = buildHeaders(req, { injectKey, authToken });
  headers["content-type"] = "application/json";
  headers["accept"] = "application/json";
  const target = base + req.url;

  let lastErr = "", lastRaw = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    reqObj.messages = messages;
    let up;
    try { up = await fetch(target, { method: req.method, headers, redirect: "follow", body: Buffer.from(JSON.stringify(reqObj)) }); }
    catch (e) {
      console.error(`[err] json-enforce fetch-failed lane=${lane} model=${model || "-"} ${target}: ${e.message}`);
      shipError(`json-enforce upstream fetch failed: ${e.message}`, { model: model || "-", lane, ip, target });
      recordCall({ ...logRec, status: 502, ms: Date.now() - t0, error: "upstream fetch failed: " + e.message });
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "upstream fetch failed: " + e.message } }));
    }
    const text = await up.text();
    if (up.status >= 400) {                                // upstream error — surface it, don't retry
      console.error(`[err] upstream=${up.status} lane=${lane} model=${model || "-"} ${target} (json-enforce)`);
      shipError(`upstream ${up.status} ${req.method} ${req.url} (json-enforce)`, { model: model || "-", lane, ip, status: up.status, body: text });
      recordCall({ ...logRec, status: up.status, ms: Date.now() - t0, error: `upstream ${up.status}`, respContent: text });
      const rh = {}; up.headers.forEach((v, k) => { if (!HOP_RES.has(k.toLowerCase())) rh[k] = v; });
      res.writeHead(up.status, rh);
      return res.end(text);
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* upstream sent a non-JSON envelope */ }
    const msg = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message;
    if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length && (msg.content == null || msg.content === "")) {
      logJson(up.status, parsed, null);
      return finishJson(res, wantStream, parsed, text);
    }
    const content = msg && typeof msg.content === "string" ? msg.content : null;
    const v = validateJsonContent(content);
    if (v.ok) {
      if (v.repaired) { msg.content = v.value; logJson(up.status, parsed, null); return finishJson(res, wantStream, parsed, JSON.stringify(parsed)); }
      logJson(up.status, parsed, null);
      return finishJson(res, wantStream, parsed, text);
    }
    lastErr = v.error; lastRaw = content == null ? "" : content;
    console.error(`[err] json-invalid lane=${lane} model=${model || "-"} attempt=${attempt + 1}/${maxRetries + 1}: ${v.error}`);
    if (attempt < maxRetries) {
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({ role: "user", content: `Your previous reply was not valid JSON and failed to parse (error: ${v.error}). Respond again with ONLY a single valid JSON value — no markdown code fences, no commentary, nothing before or after the JSON.` });
    }
  }
  shipError(`json enforcement failed after ${maxRetries + 1} attempts`, { model: model || "-", lane, ip, error: lastErr });
  recordCall({ ...logRec, status: 422, ms: Date.now() - t0, error: `json_validation_failed: ${lastErr}`, respContent: lastRaw });
  res.writeHead(422, { "content-type": "application/json" });
  res.end(JSON.stringify({
    error: {
      message: `Model did not return valid JSON after ${maxRetries + 1} attempts despite response_format enforcement. Last parse error: ${lastErr}`,
      type: "invalid_response_error", code: "json_validation_failed",
    },
    last_content: lastRaw.slice(0, 4000),
  }));
}

// Build the local-model entries for /v1/models from the live alias map (aliases + targets, deduped).
function localModelEntries() {
  const ids = new Set();
  const out = [];
  for (const [alias, target] of Object.entries(CFG.localMap)) {
    for (const id of [alias, target]) {
      if (!ids.has(id)) { ids.add(id); out.push({ id, object: "model", owned_by: "local-lmstudio" }); }
    }
  }
  return out;
}

// Fetch claudebox + crazyrouter catalogs (best-effort). Returns {claude, cloud}.
async function upstreamCatalogs() {
  let claude = [];
  try {
    const c = await fetch(CFG.bases.claude + "/v1/models", { headers: { authorization: `Bearer ${CFG.claudeToken}` } });
    const cj = await c.json();
    claude = ((cj && cj.data) || []).map((m) => ({ ...m, owned_by: "claudebox" }));
  } catch { /* claudebox down — skip */ }
  let cloud = [];
  try {
    const u = await fetch(CFG.bases.crazy + "/v1/models", { headers: { authorization: `Bearer ${CFG.crazyKey}` } });
    const j = await u.json();
    cloud = (j && j.data) || [];
  } catch { /* crazyrouter down — skip */ }
  return { claude, cloud };
}

async function mergedModels(res) {
  const local = localModelEntries();
  const { claude, cloud } = await upstreamCatalogs();
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify({ object: "list", data: [...local, ...claude, ...cloud] }));
}

// Build a concrete route for an explicit (lane, model) — used by forceModel / modelRoutes /
// defaultRoute. `model` is the id actually sent upstream (rewriteModel).
function laneRoute(lane, model, reason) {
  if (lane === "claude") return { lane: "claude", base: CFG.bases.claude, authToken: CFG.claudeToken, rewriteModel: model || undefined, reason };
  if (lane === "local") return { lane: "local", base: CFG.bases.local, rewriteModel: model, target: model, reason };
  return { lane: "cloud", base: CFG.bases.crazy, injectKey: true, rewriteModel: model || undefined, reason }; // cloud
}

// Where unknown / empty / cloud-blocked models go. lane "none" → blocked (caller gets 400).
function defaultRouteResolved(why) {
  const d = CFG.defaultRoute || { lane: "none" };
  if (!d.lane || d.lane === "none" || !d.model) return { lane: "blocked", blocked: true, why, reason: why + "; no default route" };
  return { ...laneRoute(d.lane, d.model, `default route (${why})`), via: "default" };
}

// Resolve a model name into a concrete upstream route. Priority:
//   1. forceModel (global override)  2. modelRoutes (per-model, any lane)  3. local alias map
//   4. claude prefix  5. empty model → default route  6. cloud policy (open/allowlist/off)
function resolveRoute(model) {
  const m = model == null ? "" : String(model);
  const key = m.toLowerCase();
  if (CFG.forceModel && CFG.forceModel.enabled && CFG.forceModel.model)
    return laneRoute(CFG.forceModel.lane, CFG.forceModel.model, "forced (global)");
  if (CFG.modelRoutes && CFG.modelRoutes[key])
    return laneRoute(CFG.modelRoutes[key].lane, CFG.modelRoutes[key].model || m, `override: ${key}`);
  const lt = localTarget(m);
  if (lt) return { lane: "local", base: CFG.bases.local, rewriteModel: lt, target: lt, reason: "local alias" };
  if (isClaudeModel(m)) return { lane: "claude", base: CFG.bases.claude, authToken: CFG.claudeToken, reason: "claude prefix" };
  if (!m) return defaultRouteResolved("no model specified");
  const pol = CFG.cloudPolicy || "open";
  if (pol === "open") return { lane: "cloud", base: CFG.bases.crazy, injectKey: true, reason: "cloud (open)" };
  if (pol === "allowlist" && (CFG.cloudAllowlist || []).some((x) => x.toLowerCase() === key))
    return { lane: "cloud", base: CFG.bases.crazy, injectKey: true, reason: "cloud (allowlisted)" };
  return defaultRouteResolved(pol === "off" ? "cloud lane disabled" : "not in cloud allowlist");
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin (password-gated): edit routing/models/keys, check lanes + crazyrouter.
// ─────────────────────────────────────────────────────────────────────────────
const COOKIE = "hb_admin";
const sign = (payload) => crypto.createHmac("sha256", CFG.adminPassword).update(payload).digest("hex");
function makeSession(ttlMs = 7 * 24 * 3600 * 1000) {
  const payload = `exp=${Date.now() + ttlMs}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}
function validSession(val) {
  if (!val) return false;
  const [b, sig] = String(val).split(".");
  if (!b || !sig) return false;
  let payload;
  try { payload = Buffer.from(b, "base64url").toString(); } catch { return false; }
  const expect = sign(payload);
  if (sig.length !== expect.length) return false;
  try { if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false; } catch { return false; }
  const m = payload.match(/exp=(\d+)/);
  return !!m && Date.now() < parseInt(m[1], 10);
}
function getCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
const isAuthed = (req) => validSession(getCookie(req, COOKIE));

function sendJson(res, status, obj, extraHeaders) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(extraHeaders || {}) });
  res.end(JSON.stringify(obj));
}

const mask = (s) => { const t = String(s || ""); return !t ? "" : t.length <= 6 ? "••••" : "••••" + t.slice(-4); };

// Naive per-IP login throttle: max 10 attempts / 5 min.
const loginHits = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = loginHits.get(ip) || { n: 0, reset: now + 300000 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 300000; }
  rec.n++;
  loginHits.set(ip, rec);
  if (loginHits.size > 5000) loginHits.clear();
  return rec.n > 10;
}

function adminState() {
  return {
    bases: CFG.bases,
    localMap: CFG.localMap,
    gatedModels: CFG.gatedModels,
    claudePrefix: CFG.claudePrefix,
    forceModel: CFG.forceModel,
    modelRoutes: CFG.modelRoutes,
    cloudPolicy: CFG.cloudPolicy,
    cloudAllowlist: CFG.cloudAllowlist,
    defaultRoute: CFG.defaultRoute,
    jsonEnforce: CFG.jsonEnforce,
    jsonMaxRetries: CFG.jsonMaxRetries,
    logging: CFG.logging,
    loggingDbReady: !!db,
    // secrets — never returned in clear
    crazyKeySet: !!CFG.crazyKey, crazyKeyMasked: mask(CFG.crazyKey),
    claudeTokenSet: !!CFG.claudeToken, claudeTokenMasked: mask(CFG.claudeToken),
    oblitTokenSet: !!CFG.oblitToken, oblitTokenMasked: mask(CFG.oblitToken),
    adminPasswordMasked: mask(CFG.adminPassword),
    configFile: CONFIG_FILE,
    configPersisted: fs.existsSync(CONFIG_FILE),
    knownLocalIds: { e4b: E4B, gemma: CANON, obliterated: OBLIT },
  };
}

// Probe one lane's /v1/models. Returns {up, status, ms, count?, error?}.
async function probe(base, authToken) {
  const t0 = Date.now();
  try {
    const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const r = await fetch(base + "/v1/models", { headers, signal: AbortSignal.timeout(12000) });
    let count;
    try { const j = await r.json(); count = (j && j.data && j.data.length) || undefined; } catch { /* non-json */ }
    return { up: r.ok, status: r.status, ms: Date.now() - t0, count };
  } catch (e) { return { up: false, status: 0, ms: Date.now() - t0, error: e.message }; }
}

// Check a crazyrouter key (defaults to the configured one): billing + catalog reachability.
async function crazyCheck(key) {
  const k = key || CFG.crazyKey;
  const out = { keySet: !!k, keyMasked: mask(k) };
  if (!k) return { ...out, error: "no key set" };
  const base = CFG.bases.crazy;
  const hdr = { authorization: `Bearer ${k}` };
  async function get(p) {
    try {
      const r = await fetch(base + p, { headers: hdr, signal: AbortSignal.timeout(12000) });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, ok: r.ok, json: j, text: t };
    } catch (e) { return { status: 0, ok: false, error: e.message }; }
  }
  const [sub, usage, models] = await Promise.all([
    get("/dashboard/billing/subscription"), get("/dashboard/billing/usage"), get("/v1/models"),
  ]);
  out.keyValid = models.ok && !(sub.json && sub.json.error);
  if (sub.json && typeof sub.json.hard_limit_usd === "number") out.hardLimitUsd = sub.json.hard_limit_usd;
  if (usage.json && typeof usage.json.total_usage === "number") out.totalUsageUsd = usage.json.total_usage / 100; // cents
  if (out.hardLimitUsd != null && out.totalUsageUsd != null) out.remainingUsd = Math.round((out.hardLimitUsd - out.totalUsageUsd) * 100) / 100;
  out.modelCount = (models.json && models.json.data && models.json.data.length) || 0;
  out.statuses = { subscription: sub.status, usage: usage.status, models: models.status };
  const errMsg = (sub.json && sub.json.error && sub.json.error.message) || (models.json && models.json.error && models.json.error.message);
  if (errMsg) out.message = errMsg;
  return out;
}

// Run a chat completion through current routing (admin is trusted → auto-injects the gate token).
async function adminTest(model, prompt, maxTokens) {
  const route = resolveRoute(model);
  const headers = { "content-type": "application/json" };
  if (route.lane === "cloud") headers.authorization = `Bearer ${CFG.crazyKey}`;
  else if (route.lane === "claude") headers.authorization = `Bearer ${CFG.claudeToken}`;
  else if (route.lane === "local" && isGated(route.target) && CFG.oblitToken) headers.authorization = `Bearer ${CFG.oblitToken}`;
  const sendModel = route.rewriteModel || model;
  const body = { model: sendModel, messages: [{ role: "user", content: prompt || "Reply with a short greeting." }], max_tokens: maxTokens || 256, stream: false };
  const t0 = Date.now();
  try {
    const r = await fetch(route.base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    const m = j && j.choices && j.choices[0] && j.choices[0].message;
    const content = (m && (m.content || m.reasoning_content)) || null;
    return { ok: r.ok, status: r.status, lane: route.lane, sentModel: sendModel, ms: Date.now() - t0, content, raw: content == null ? text.slice(0, 2000) : undefined };
  } catch (e) { return { ok: false, status: 0, lane: route.lane, sentModel: sendModel, ms: Date.now() - t0, error: e.message }; }
}

async function handleAdminApi(req, res, path) {
  const ip = req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const sub = path.slice("/admin/api/".length);

  // login is the only unauthenticated endpoint
  if (sub === "login" && req.method === "POST") {
    if (throttled(ip)) return sendJson(res, 429, { error: "too many attempts, wait a few minutes" });
    const body = await readBody(req);
    let pw = "";
    try { pw = JSON.parse(body.toString()).password || ""; } catch {}
    const ok = pw.length === CFG.adminPassword.length &&
      (() => { try { return crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(CFG.adminPassword)); } catch { return false; } })();
    if (!ok) { console.error(`[admin] bad login ip=${ip}`); return sendJson(res, 401, { error: "wrong password" }); }
    const cookie = `${COOKIE}=${makeSession()}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=${7 * 24 * 3600}`;
    console.log(`[admin] login ok ip=${ip}`);
    return sendJson(res, 200, { ok: true }, { "set-cookie": cookie });
  }
  if (sub === "logout") {
    return sendJson(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0` });
  }

  if (!isAuthed(req)) return sendJson(res, 401, { error: "unauthorized" });

  if (sub === "state" && req.method === "GET") return sendJson(res, 200, adminState());

  if (sub === "config" && req.method === "POST") {
    const body = await readBody(req);
    let patch = null;
    try { patch = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "invalid JSON body" }); }
    // Secret fields: omit/undefined = keep; "" = clear; value = set. Start from current CFG.
    const next = JSON.parse(JSON.stringify(CFG));
    if (patch.bases) Object.assign(next.bases, patch.bases);
    if (patch.localMap) next.localMap = patch.localMap;
    if (patch.gatedModels) next.gatedModels = patch.gatedModels;
    if (typeof patch.claudePrefix === "string") next.claudePrefix = patch.claudePrefix;
    if (patch.forceModel) next.forceModel = patch.forceModel;
    if (patch.modelRoutes) next.modelRoutes = patch.modelRoutes;
    if (patch.cloudPolicy) next.cloudPolicy = patch.cloudPolicy;
    if (patch.cloudAllowlist) next.cloudAllowlist = patch.cloudAllowlist;
    if (patch.defaultRoute) next.defaultRoute = patch.defaultRoute;
    if (typeof patch.jsonEnforce === "boolean") next.jsonEnforce = patch.jsonEnforce;
    if (patch.jsonMaxRetries !== undefined) next.jsonMaxRetries = patch.jsonMaxRetries;
    if (patch.logging && typeof patch.logging === "object") Object.assign(next.logging, patch.logging);
    for (const k of ["crazyKey", "claudeToken", "oblitToken", "adminPassword"])
      if (typeof patch[k] === "string") next[k] = patch[k];
    const merged = mergeConfig(envDefaults(), next);
    if (!merged.adminPassword || merged.adminPassword.length < 3)
      return sendJson(res, 400, { error: "admin password must be at least 3 chars" });
    CFG = merged;
    const persisted = persistConfig();
    console.log(`[admin] config updated ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, state: adminState() });
  }

  if (sub === "reset" && req.method === "POST") {
    try { fs.unlinkSync(CONFIG_FILE); } catch {}
    CFG = envDefaults();
    console.log(`[admin] config reset to env defaults ip=${ip}`);
    return sendJson(res, 200, { ok: true, state: adminState() });
  }

  if (sub === "health" && req.method === "GET") {
    const [local, claude, cloud] = await Promise.all([
      probe(CFG.bases.local), probe(CFG.bases.claude, CFG.claudeToken), probe(CFG.bases.crazy, CFG.crazyKey),
    ]);
    return sendJson(res, 200, { local, claude, cloud });
  }

  if (sub === "models" && req.method === "GET") {
    const { claude, cloud } = await upstreamCatalogs();
    return sendJson(res, 200, { local: localModelEntries(), claude, cloud });
  }

  if (sub === "crazyrouter" && req.method === "GET") return sendJson(res, 200, await crazyCheck());
  if (sub === "crazyrouter/test" && req.method === "POST") {
    const body = await readBody(req); let key = "";
    try { key = JSON.parse(body.toString()).key || ""; } catch {}
    return sendJson(res, 200, await crazyCheck(key));
  }

  if (sub === "test" && req.method === "POST") {
    const body = await readBody(req); let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "invalid JSON body" }); }
    if (!p.model) return sendJson(res, 400, { error: "model required" });
    return sendJson(res, 200, await adminTest(p.model, p.prompt, p.max_tokens));
  }

  // Dry-run: show exactly where a model name routes, without calling upstream.
  if (sub === "resolve" && req.method === "POST") {
    const body = await readBody(req); let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "invalid JSON body" }); }
    const r = resolveRoute(p.model);
    const sent = r.rewriteModel || (r.lane === "local" ? r.target : p.model) || p.model || "";
    const gated = r.lane === "local" && isGated(r.target) && !!CFG.oblitToken;
    return sendJson(res, 200, {
      input: p.model || "", lane: r.lane, sentModel: sent, reason: r.reason || "",
      blocked: !!r.blocked, why: r.why, gated,
      base: r.base || (r.lane === "local" ? CFG.bases.local : r.lane === "claude" ? CFG.bases.claude : r.lane === "cloud" ? CFG.bases.crazy : ""),
    });
  }

  // ── call log ──
  if (sub === "calls" && req.method === "GET") {
    if (!db) return sendJson(res, 200, { rows: [], total: 0, dbReady: false });
    const q = url.parse(req.url, true).query;
    const where = [], params = [];
    if (q.lane) { where.push("lane = ?"); params.push(String(q.lane)); }
    if (q.model) { where.push("req_model = ?"); params.push(String(q.model)); }
    if (q.key) { where.push("key_label = ?"); params.push(String(q.key)); }
    if (q.status === "error") where.push("status >= 400");
    else if (q.status === "ok") where.push("status < 400");
    else if (q.status) { where.push("status = ?"); params.push(parseInt(q.status, 10)); }
    if (q.since) { where.push("ts >= ?"); params.push(parseInt(q.since, 10)); }
    if (q.q) { where.push("(req_model LIKE ? OR sent_model LIKE ? OR ip LIKE ? OR ua LIKE ? OR req_content LIKE ? OR resp_content LIKE ?)");
      const like = "%" + String(q.q) + "%"; params.push(like, like, like, like, like, like); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.min(parseInt(q.limit, 10) || 100, 500);
    const offset = parseInt(q.offset, 10) || 0;
    try {
      const total = db.prepare(`SELECT COUNT(*) n FROM calls ${w}`).get(...params).n;
      // List view: omit big content blobs; send short previews instead.
      const rows = db.prepare(`SELECT id,ts,ip,ua,method,path,req_model,lane,sent_model,key_label,status,duration_ms,stream,
        prompt_tokens,completion_tokens,total_tokens,error,
        substr(req_content,1,160) AS req_preview, substr(resp_content,1,200) AS resp_preview
        FROM calls ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      return sendJson(res, 200, { rows, total, limit, offset, dbReady: true });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (sub === "call" && req.method === "GET") {
    if (!db) return sendJson(res, 404, { error: "no db" });
    const q = url.parse(req.url, true).query;
    const id = parseInt(q.id, 10);
    if (!id) return sendJson(res, 400, { error: "id required" });
    try {
      const row = db.prepare("SELECT * FROM calls WHERE id = ?").get(id);
      return row ? sendJson(res, 200, row) : sendJson(res, 404, { error: "not found" });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (sub === "stats" && req.method === "GET") {
    if (!db) return sendJson(res, 200, { dbReady: false });
    try {
      const day = Date.now() - 86400000;
      const total = db.prepare("SELECT COUNT(*) n FROM calls").get().n;
      const last24 = db.prepare("SELECT COUNT(*) n FROM calls WHERE ts >= ?").get(day).n;
      const errors24 = db.prepare("SELECT COUNT(*) n FROM calls WHERE ts >= ? AND status >= 400").get(day).n;
      const tokens24 = db.prepare("SELECT COALESCE(SUM(total_tokens),0) t FROM calls WHERE ts >= ?").get(day).t;
      const byLane = db.prepare("SELECT lane, COUNT(*) n, COALESCE(SUM(total_tokens),0) tok FROM calls GROUP BY lane ORDER BY n DESC").all();
      const byKey = db.prepare("SELECT key_label, COUNT(*) n FROM calls GROUP BY key_label ORDER BY n DESC").all();
      const byModel = db.prepare("SELECT req_model, lane, COUNT(*) n, COALESCE(SUM(total_tokens),0) tok, ROUND(AVG(duration_ms)) avg_ms FROM calls GROUP BY req_model ORDER BY n DESC LIMIT 30").all();
      const oldest = db.prepare("SELECT MIN(ts) t FROM calls").get().t;
      return sendJson(res, 200, { dbReady: true, total, last24, errors24, tokens24, byLane, byKey, byModel, oldest, retain: CFG.logging.retain });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (sub === "calls/clear" && req.method === "POST") {
    if (!db) return sendJson(res, 200, { ok: true, dbReady: false });
    try { db.exec("DELETE FROM calls;"); console.log(`[admin] call log cleared ip=${ip}`); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  return sendJson(res, 404, { error: "unknown admin endpoint" });
}

// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || "").toLowerCase();
  const path = (req.url || "/").split("?")[0];

  // Admin (only on the main host, never docs.*)
  if (!host.startsWith("docs.")) {
    if (path === "/admin" || path === "/admin/") return sendFile(res, ADMIN_FILE, "text/html; charset=utf-8", false);
    if (path.startsWith("/admin/api/")) return handleAdminApi(req, res, path);
    if (path.startsWith("/admin/")) return sendFile(res, ADMIN_FILE, "text/html; charset=utf-8", false);
  }

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
    return proxy(req, res, CFG.bases.local, { bodyBuf });
  }
  if (req.method === "GET" && (path === "/v1/models" || path === "/api/v1/models"))
    return mergedModels(res);

  const bodyBuf = ["GET", "HEAD"].includes(req.method) ? Buffer.alloc(0) : await readBody(req);
  let model = null;
  if (bodyBuf.length) { try { model = JSON.parse(bodyBuf.toString()).model; } catch { /* not json */ } }
  const ip = req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const route = resolveRoute(model);
  const lane = route.lane;
  console.log(`[req] ${new Date().toISOString()} ip=${ip} ${req.method} ${path} model=${model || "-"} -> ${lane}${route.rewriteModel ? "(" + route.rewriteModel + ")" : ""} ua="${String(req.headers["user-agent"] || "").slice(0, 50)}"`);

  // Flow policy blocked this model (cloud off / not allowlisted / unknown with no default route).
  if (route.blocked) {
    console.error(`[err] 400 blocked ip=${ip} model=${model || "-"} (${route.why})`);
    recordCall({ ts: Date.now(), ip, ua: req.headers["user-agent"] || "", method: req.method, path,
      reqModel: model || null, lane: "blocked", sentModel: null, keyLabel: "—", status: 400, ms: 0,
      error: `not routable: ${route.why}`, reqContent: extractRequestContent(bodyBuf) });
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: `model '${model || ""}' is not routable: ${route.why}. Set a model override, cloud allowlist entry, or default route in /admin.`, type: "invalid_request_error", code: "model_not_routable" } }));
  }

  // Bearer gate for the uncensored local model(s).
  if (lane === "local" && isGated(route.target) && CFG.oblitToken) {
    const auth = String(req.headers["authorization"] || "");
    const xkey = String(req.headers["x-api-key"] || "");
    if (auth !== `Bearer ${CFG.oblitToken}` && xkey !== CFG.oblitToken) {
      console.error(`[err] 401 gated model unauthorized ip=${ip} model=${route.target}`);
      recordCall({ ts: Date.now(), ip, ua: req.headers["user-agent"] || "", method: req.method, path,
        reqModel: model || null, lane: "local", sentModel: route.target, keyLabel: "oblitToken", status: 401, ms: 0,
        error: "gate: missing/invalid token", reqContent: extractRequestContent(bodyBuf) });
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      return res.end(JSON.stringify({ error: { message: `model '${route.target}' requires Authorization: Bearer <token>`, type: "invalid_request_error", code: "unauthorized" } }));
    }
  }

  // JSON-output enforcement: only for chat completions that request a JSON response_format.
  if (CFG.jsonEnforce && req.method === "POST" && path.endsWith("/chat/completions") && bodyBuf.length) {
    let reqObj = null;
    try { reqObj = JSON.parse(bodyBuf.toString()); } catch { /* not JSON — passthrough */ }
    if (reqObj && wantsJsonFormat(reqObj)) {
      console.log(`[req] json-enforce model=${model || "-"} -> ${lane}`);
      return jsonEnforce(req, res, { ...route, model, lane, ip, bodyBuf });
    }
  }
  return proxy(req, res, route.base, { ...route, bodyBuf, model, lane });
});

server.listen(PORT, () => console.log(`llm-hostbun-proxy on :${PORT} crazy=${CFG.bases.crazy} local=${CFG.bases.local} key=${CFG.crazyKey ? "set" : "MISSING"} admin=/admin`));
