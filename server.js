// llm.hostbun.cc — single-URL OpenAI router + admin UI.
//
// THREE PROVIDERS (lanes):
//   • local       -> LM Studio @ llm.bofrid.dev (gemma / qwen, no key; obliterated optionally gated)
//   • crazyrouter -> crazyrouter.com cloud relay (CRAZYROUTER_KEY injected server-side)
//   • wrappy      -> claudebox / claude-code OpenAI shim @ claude.hostbun.cc (wrappyToken injected)
//
//   model "local"                                        -> local gemma-4-e4b-it-obliterated (DEFAULT, multimodal, open)
//   model "gemma-4-e4b-it-obliterated"                   -> same (full id)
//   model "gemma" / "google/gemma-4-26b-a4b"             -> local gemma 26B MoE, no key
//   model "obliterated" / "qwen3.6-27b-obliterated"      -> local Qwen3.6-27B abliterated (Bearer-gated if OBLIT_TOKEN set)
//   model "claude*" (e.g. claude-sonnet-4-6)             -> wrappy (claudebox), token injected
//   any other model                                      -> crazyrouter, key injected
//   (local models JIT-swap in VRAM — they don't all fit at once)
//   GET /v1/models                            -> local + wrappy + crazyrouter list (merged)
//   /docs, docs.<host>                         -> docs page
//   /prices(.json)                             -> computed price feed (CORS *)
//   /local/*                                   -> kept for back-compat (strips /local -> llm.bofrid.dev)
//   /admin, /admin/api/*                       -> password-gated admin UI (edit routing/models/keys live)
//
// Routing is driven by a live, mutable CFG object. CFG is seeded from env defaults and then
// overlaid with /data/config.json (a Coolify-managed persistent volume) — so edits made in the
// admin UI take effect immediately AND survive restarts/reboots/redeploys. Nothing here needs a
// redeploy to change routing.
//
// LANE NAMING: canonical lane ids are `local`, `crazyrouter`, `wrappy`. Legacy ids `cloud`
// (=crazyrouter) and `claude` (=wrappy) are still accepted on input and migrated, so older
// /data/config.json files and call-log rows keep working without a reset.
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
// Lane taxonomy. The three providers, plus legacy-id normalization.
// ─────────────────────────────────────────────────────────────────────────────
const LANES = ["local", "crazyrouter", "wrappy"];
const LANE_SET = new Set(LANES);
const LEGACY_LANE = { cloud: "crazyrouter", claude: "wrappy" };
// Normalize any lane id (legacy or canonical) to a canonical one; returns "" if unrecognized.
function normLane(l) {
  const s = String(l || "").trim().toLowerCase();
  const c = LEGACY_LANE[s] || s;
  return LANE_SET.has(c) ? c : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Live config: env defaults, then /data/config.json overlay.
// ─────────────────────────────────────────────────────────────────────────────
function envDefaults() {
  return {
    bases: {
      local: (process.env.LOCAL_BASE || "https://llm.bofrid.dev").replace(/\/$/, ""),
      crazyrouter: (process.env.CRAZYROUTER_BASE || process.env.CRAZY_BASE || "https://crazyrouter.com").replace(/\/$/, ""),
      wrappy: (process.env.WRAPPY_BASE || process.env.CLAUDE_BASE || "https://claude.hostbun.cc").replace(/\/$/, ""),
    },
    crazyrouterKey: process.env.CRAZYROUTER_KEY || "",
    wrappyToken: process.env.WRAPPY_TOKEN || process.env.CLAUDE_TOKEN || "ddash",
    // models starting with this prefix (lowercased) route to the wrappy lane.
    wrappyPrefix: process.env.WRAPPY_PREFIX || "claude",
    // ── wrappy → crazyrouter failover ──
    // When the wrappy lane (claudebox) errors or is unreachable, automatically retry the SAME
    // request on the crazyrouter lane. crazyrouter exposes the identical claude-* ids, so by
    // default we resend the caller's model unchanged (model: "" = pass-through). Set model to a
    // specific crazyrouter id to pin the fallback. Triggers on: fetch failure, HTTP >=500, 429,
    // 401, 403 (token died). One shot per request — never loops.
    wrappyFallback: {
      enabled: (process.env.WRAPPY_FALLBACK || "1") !== "0",
      model: process.env.WRAPPY_FALLBACK_MODEL || "",
    },
    // Bearer gate for the uncensored model(s). When oblitToken is set, requests routed to a model
    // id listed in gatedModels require Authorization: Bearer <oblitToken> (or x-api-key). Empty
    // token = open. gemma + crazyrouter stay open so fb-bot/promopilot are unaffected.
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
    forceModel: { enabled: false, lane: "wrappy", model: "" },
    // modelRoutes: explicit per-incoming-model overrides to ANY lane (highest priority after
    // forceModel). key = incoming model name (lowercased). value = { lane, model }.
    modelRoutes: {},
    // cloudPolicy governs models that fall through to the crazyrouter lane:
    //   "open"      → forward anything (legacy behaviour)
    //   "allowlist" → only ids in cloudAllowlist reach crazyrouter; everything else → defaultRoute
    //   "off"       → nothing reaches crazyrouter; everything → defaultRoute
    cloudPolicy: "open",
    cloudAllowlist: [],
    // defaultRoute: where unknown / empty / crazyrouter-blocked models go. lane "none" = reject 400.
    defaultRoute: { lane: "none", model: "" },
    // JSON-output enforcement for chat completions that set response_format json_object/json_schema.
    jsonEnforce: (process.env.JSON_ENFORCE || "1") !== "0",
    jsonMaxRetries: parseInt(process.env.JSON_MAX_RETRIES || "2", 10),
    // Project attribution. When requireProject is on, inference calls must declare a project via the
    // X-Project header (or body project/metadata.project/user) or they're rejected 400. Off = the
    // project is still recorded when supplied, just not mandatory.
    requireProject: (process.env.REQUIRE_PROJECT || "1") === "1",
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
// Accepts both new keys (crazyrouter/wrappy/...) and legacy keys (crazy/claude/crazyKey/claudeToken/
// claudePrefix) so older config files migrate transparently.
function mergeConfig(base, saved) {
  const c = JSON.parse(JSON.stringify(base));
  if (!saved || typeof saved !== "object") return c;
  if (saved.bases && typeof saved.bases === "object") {
    const b = saved.bases;
    const pick = (...keys) => { for (const k of keys) if (typeof b[k] === "string" && b[k].trim()) return b[k].trim().replace(/\/$/, ""); return null; };
    const loc = pick("local"); if (loc) c.bases.local = loc;
    const cr = pick("crazyrouter", "crazy"); if (cr) c.bases.crazyrouter = cr;
    const wr = pick("wrappy", "claude"); if (wr) c.bases.wrappy = wr;
  }
  if (saved.localMap && typeof saved.localMap === "object" && !Array.isArray(saved.localMap)) {
    const m = {};
    for (const [k, v] of Object.entries(saved.localMap)) {
      if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim())
        m[k.trim().toLowerCase()] = v.trim();
    }
    c.localMap = m; // allow an explicit empty map to fully disable the local lane
  }
  if (Array.isArray(saved.gatedModels))
    c.gatedModels = saved.gatedModels.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  // Secrets / scalars, with legacy aliases.
  if (typeof saved.crazyrouterKey === "string") c.crazyrouterKey = saved.crazyrouterKey;
  else if (typeof saved.crazyKey === "string") c.crazyrouterKey = saved.crazyKey;
  if (typeof saved.wrappyToken === "string") c.wrappyToken = saved.wrappyToken;
  else if (typeof saved.claudeToken === "string") c.wrappyToken = saved.claudeToken;
  if (typeof saved.wrappyPrefix === "string") c.wrappyPrefix = saved.wrappyPrefix;
  else if (typeof saved.claudePrefix === "string") c.wrappyPrefix = saved.claudePrefix;
  for (const k of ["oblitToken", "adminPassword"])
    if (typeof saved[k] === "string") c[k] = saved[k];
  if (typeof saved.jsonEnforce === "boolean") c.jsonEnforce = saved.jsonEnforce;
  if (Number.isInteger(saved.jsonMaxRetries) && saved.jsonMaxRetries >= 0 && saved.jsonMaxRetries <= 5)
    c.jsonMaxRetries = saved.jsonMaxRetries;
  if (typeof saved.requireProject === "boolean") c.requireProject = saved.requireProject;
  // ── flow control ──
  if (saved.forceModel && typeof saved.forceModel === "object") {
    const f = saved.forceModel;
    c.forceModel = {
      enabled: !!f.enabled,
      lane: normLane(f.lane) || "wrappy",
      model: typeof f.model === "string" ? f.model.trim() : "",
    };
  }
  if (saved.wrappyFallback && typeof saved.wrappyFallback === "object") {
    const f = saved.wrappyFallback;
    c.wrappyFallback = {
      enabled: !!f.enabled,
      model: typeof f.model === "string" ? f.model.trim() : "",
    };
  }
  if (saved.modelRoutes && typeof saved.modelRoutes === "object" && !Array.isArray(saved.modelRoutes)) {
    const mr = {};
    for (const [k, v] of Object.entries(saved.modelRoutes)) {
      const lane = v && typeof v === "object" ? normLane(v.lane) : "";
      if (typeof k === "string" && k.trim() && lane)
        mr[k.trim().toLowerCase()] = { lane, model: typeof v.model === "string" ? v.model.trim() : "" };
    }
    c.modelRoutes = mr;
  }
  if (["open", "allowlist", "off"].includes(saved.cloudPolicy)) c.cloudPolicy = saved.cloudPolicy;
  if (Array.isArray(saved.cloudAllowlist))
    c.cloudAllowlist = saved.cloudAllowlist.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  if (saved.defaultRoute && typeof saved.defaultRoute === "object") {
    const d = saved.defaultRoute;
    const dl = String(d.lane || "").toLowerCase() === "none" ? "none" : normLane(d.lane);
    c.defaultRoute = {
      lane: dl || "none",
      model: typeof d.model === "string" ? d.model.trim() : "",
    };
  }
  if (saved.logging && typeof saved.logging === "object") {
    const l = saved.logging;
    if (typeof l.enabled === "boolean") c.logging.enabled = l.enabled;
    if (typeof l.content === "boolean") c.logging.content = l.content;
    if (Number.isInteger(l.retain) && l.retain >= 100 && l.retain <= 1000000) c.logging.retain = l.retain;
  }
  if (!c.wrappyPrefix) c.wrappyPrefix = "claude";
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
      error TEXT, req_content TEXT, resp_content TEXT, project TEXT
    );`);
    // Migrate older DBs that predate the project column (idempotent — throws if it already exists).
    try { db.exec("ALTER TABLE calls ADD COLUMN project TEXT;"); } catch { /* already there */ }
    db.exec("CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_calls_model ON calls(req_model);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_calls_lane ON calls(lane);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_calls_project ON calls(project);");
    insertStmt = db.prepare(`INSERT INTO calls
      (ts,ip,ua,method,path,req_model,lane,sent_model,key_label,status,duration_ms,stream,prompt_tokens,completion_tokens,total_tokens,error,req_content,resp_content,project)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
  if (route.lane === "crazyrouter") return "crazyrouterKey";
  if (route.lane === "wrappy") return "wrappyToken";
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

// Which project a call belongs to. Apps declare it via the `X-Project` header (preferred);
// we also accept `X-Project-Id`, a body `project`/`metadata.project` field, or the OpenAI
// `user` field as fallbacks. Normalised to a short lowercase slug. Returns "" if unset.
function extractProject(req, bodyBuf) {
  let p = req.headers["x-project"] || req.headers["x-project-id"] || "";
  if (!p && bodyBuf && bodyBuf.length) {
    try {
      const j = JSON.parse(bodyBuf.toString());
      p = j.project || (j.metadata && j.metadata.project) || j.user || "";
    } catch { /* not json */ }
  }
  return String(p || "").trim().toLowerCase().slice(0, 64);
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
      rec.project || null,
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
const isWrappyModel = (m) => typeof m === "string" && m.toLowerCase().startsWith((CFG.wrappyPrefix || "claude").toLowerCase());
const isGated = (target) => Array.isArray(CFG.gatedModels) && CFG.gatedModels.includes(target);

// ── wrappy → crazyrouter failover ──
// True when a wrappy upstream result should trigger fallback (transport dead or server-side fail).
const isWrappyFailure = (status, threw) => threw || status >= 500 || status === 429 || status === 401 || status === 403;
// claudebox quota/system-notice leak: the wrapper returns HTTP 200 but the message *content* is a
// human notice ("You've hit your weekly limit · resets 2am (UTC)") instead of a real completion.
// Status-based failover can't see this, so we sniff the content. Kept conservative to avoid eating
// legit replies that merely discuss limits. Treated as a wrappy failure → fail over to crazyrouter.
function isClaudeboxNotice(content) {
  if (typeof content !== "string") return false;
  const s = content.trim();
  if (!s || s.length > 300) return false;          // real completions are longer; notices are short
  return /you'?ve hit your (weekly |session |usage |rate )?limit/i.test(s) ||
         /\bresets?\b.*\bUTC\b/i.test(s) ||
         /(usage|rate|weekly|session) limit (reached|exceeded)/i.test(s);
}
// ── wrappy circuit breaker ──
// After consecutive quota/error hits we skip wrappy entirely for CIRCUIT_TTL_MS to avoid paying
// 12-27 seconds per call just to get a quota notice back. Resets automatically on TTL expiry.
const CIRCUIT_TTL_MS = 20 * 60 * 1000;   // stay open 20 min — covers the time until the hourly reset
const CIRCUIT_THRESHOLD = 3;              // consecutive failures before opening
const wrappyCircuit = { failures: 0, openUntil: 0 };
function wrappyCircuitOpen() { return Date.now() < wrappyCircuit.openUntil; }
function wrappyCircuitTrip() {
  wrappyCircuit.failures++;
  if (wrappyCircuit.failures >= CIRCUIT_THRESHOLD && !wrappyCircuitOpen()) {
    wrappyCircuit.openUntil = Date.now() + CIRCUIT_TTL_MS;
    const resetAt = new Date(wrappyCircuit.openUntil).toISOString();
    console.warn(`[circuit] wrappy circuit OPEN (${wrappyCircuit.failures} failures) — bypassing wrappy until ${resetAt}`);
  }
}
function wrappyCircuitReset() {
  if (wrappyCircuit.failures > 0) {
    console.log("[circuit] wrappy circuit CLOSED — upstream healthy again");
    wrappyCircuit.failures = 0; wrappyCircuit.openUntil = 0;
  }
}

// Build the crazyrouter route to retry a failed wrappy call on. `model` = caller's original model.
// Returns null when fallback is disabled or no usable model. crazyrouter mirrors the claude-* ids,
// so an empty configured model means "resend the caller's model unchanged".
function wrappyFallbackRoute(model) {
  const fb = CFG.wrappyFallback;
  if (!fb || !fb.enabled) return null;
  const fbModel = (fb.model && fb.model.trim()) || (model == null ? "" : String(model));
  if (!fbModel) return null;
  return { lane: "crazyrouter", base: CFG.bases.crazyrouter, injectKey: true, rewriteModel: fbModel, reason: "wrappy fallback -> crazyrouter" };
}

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
  if (injectKey) headers["authorization"] = `Bearer ${CFG.crazyrouterKey}`;
  else if (authToken) headers["authorization"] = `Bearer ${authToken}`;
  return headers;
}

async function proxy(req, res, base, opts = {}) {
  const { bodyBuf, injectKey, authToken, rewriteModel, model, lane, project } = opts;
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
    reqContent: extractRequestContent(bodyBuf), project: project || null,
  };
  let curTarget = target, curLane = lane;
  let curInit = { method: req.method, headers, redirect: "follow" };
  if (!["GET", "HEAD"].includes(req.method) && body && body.length) curInit.body = body;
  let up = null, threw = false, fetchErr = null;
  try { up = await fetch(curTarget, curInit); }
  catch (e) { threw = true; fetchErr = e; }

  // wrappy → crazyrouter failover (one shot). Decided before any client bytes are sent, so it is
  // safe even for streaming responses — nothing has been written to `res` yet. Re-fires the request
  // at crazyrouter and updates up/curLane/base_rec in place. Returns true if it ran.
  let failedOver = false;
  async function doFailover(why) {
    if (failedOver) return false;
    const fb = wrappyFallbackRoute(model);
    if (!fb) return false;
    console.warn(`[fallback] wrappy ${why} -> crazyrouter model=${fb.rewriteModel} ${target}`);
    shipError(`wrappy fallback -> crazyrouter`, { from: "wrappy", reason: why, model: model || "-", fbModel: fb.rewriteModel, ip });
    const fbHeaders = buildHeaders(req, { injectKey: true });
    let fbBody = bodyBuf;
    if (bodyBuf && bodyBuf.length) {
      try { const j = JSON.parse(bodyBuf.toString()); j.model = fb.rewriteModel; fbBody = Buffer.from(JSON.stringify(j)); fbHeaders["content-type"] = "application/json"; } catch { /* leave body as-is */ }
    }
    curTarget = fb.base + req.url; curLane = "crazyrouter";
    base_rec.lane = "crazyrouter"; base_rec.sentModel = fb.rewriteModel; base_rec.keyLabel = "crazyrouterKey";
    curInit = { method: req.method, headers: fbHeaders, redirect: "follow" };
    if (!["GET", "HEAD"].includes(req.method) && fbBody && fbBody.length) curInit.body = fbBody;
    up = null; threw = false; fetchErr = null;
    try { up = await fetch(curTarget, curInit); }
    catch (e) { threw = true; fetchErr = e; }
    failedOver = true;
    return true;
  }

  if (lane === "wrappy" && isWrappyFailure(up ? up.status : 0, threw)) {
    wrappyCircuitTrip();
    await doFailover(threw ? `fetch-failed (${fetchErr.message})` : `status ${up.status}`);
  }

  // claudebox quota notice leaked as a 200 (status-based failover can't see it). Sniff non-stream
  // wrappy bodies; if it's a wrapper notice, fail over to crazyrouter. `preBuf` holds the bytes we
  // already read so the non-quota case can still be forwarded without re-fetching.
  let preBuf = null;
  if (!threw && !failedOver && curLane === "wrappy" && up && up.status < 400 && up.body &&
      !(up.headers.get("content-type") || "").includes("text/event-stream")) {
    preBuf = Buffer.from(await up.arrayBuffer());
    if (isClaudeboxNotice(extractResponseBody(preBuf, false).content)) {
      preBuf = null;
      wrappyCircuitTrip();
      await doFailover("quota notice (200 body)");
    } else {
      wrappyCircuitReset(); // wrappy returned a real response — it's healthy
    }
  }

  if (threw) {
    console.error(`[err] fetch-failed lane=${curLane || "?"} model=${model || "-"} ${curTarget}: ${fetchErr.message}`);
    shipError(`upstream fetch failed: ${fetchErr.message}`, { model: model || "-", lane: curLane || "?", ip, target: curTarget });
    recordCall({ ...base_rec, status: 502, ms: Date.now() - t0, error: "upstream fetch failed: " + fetchErr.message });
    res.writeHead(502, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "upstream fetch failed: " + fetchErr.message } }));
  }
  if (up.status >= 400) {
    console.error(`[err] upstream=${up.status} lane=${curLane || "?"} model=${model || "-"} ${curTarget}`);
    up.clone().text().then((t) => shipError(`upstream ${up.status} ${req.method} ${req.url}`, { model: model || "-", lane: curLane || "?", ip, status: up.status, body: t })).catch(() => {});
  }
  const rh = {};
  up.headers.forEach((v, k) => { if (!HOP_RES.has(k.toLowerCase())) rh[k] = v; });
  res.writeHead(up.status, rh);
  const isStream = (up.headers.get("content-type") || "").includes("text/event-stream");
  // Only chat/responses/completions calls carry content worth recording; for those we tee the
  // body (capped) to pull tokens + reply. /v1/models etc. are skipped to keep the log signal high.
  const recordThis = CFG.logging.enabled && req.method === "POST" && /\/(chat\/completions|responses|completions|messages|chat)$/.test(base_rec.path);
  if (preBuf) {
    // Body already fully read during the quota sniff (non-quota wrappy reply) — forward the bytes.
    if (recordThis) {
      const ex = extractResponseBody(preBuf, isStream);
      recordCall({ ...base_rec, status: up.status, ms: Date.now() - t0, usage: ex.usage, respContent: ex.content,
        error: up.status >= 400 ? `upstream ${up.status}` : null });
    }
    res.end(preBuf);
  } else if (up.body) {
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
  const { base, injectKey, authToken, rewriteModel, model, lane, ip, bodyBuf, project } = route;
  const maxRetries = CFG.jsonMaxRetries;
  const reqObj = JSON.parse(bodyBuf.toString());           // caller already verified this parses
  const wantStream = !!reqObj.stream;
  const t0 = Date.now();
  const logRec = {
    ts: t0, ip, ua: req.headers["user-agent"] || "", method: req.method, path: (req.url || "").split("?")[0],
    reqModel: model || null, lane, sentModel: rewriteModel || model || null,
    keyLabel: keyLabel({ lane, target: route.target }), stream: wantStream,
    reqContent: extractRequestContent(bodyBuf), project: project || null,
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
  // wrappy (claudebox) and local json_object don't honour response_format natively → strip it and
  // steer with a plain instruction instead.
  if (lane === "wrappy" || (lane === "local" && rfType === "json_object")) {
    delete reqObj.response_format;
    injectJsonInstruction(messages, rf);
  }
  let headers = buildHeaders(req, { injectKey, authToken });
  headers["content-type"] = "application/json";
  headers["accept"] = "application/json";
  let target = base + req.url;

  // wrappy → crazyrouter failover: re-point this enforced call at crazyrouter once. The messages
  // were already steered with a JSON instruction (wrappy path strips response_format above), so the
  // crazyrouter model still returns JSON we can validate. One shot, guarded by `fellBack`.
  let curLane = lane, fellBack = false;
  function switchWrappyToCrazy() {
    const fb = wrappyFallbackRoute(model);
    if (!fb) return false;
    curLane = "crazyrouter";
    target = fb.base + req.url;
    headers = buildHeaders(req, { injectKey: true });
    headers["content-type"] = "application/json";
    headers["accept"] = "application/json";
    reqObj.model = fb.rewriteModel;
    logRec.lane = "crazyrouter"; logRec.sentModel = fb.rewriteModel; logRec.keyLabel = "crazyrouterKey";
    fellBack = true;
    wrappyCircuitTrip();
    console.warn(`[fallback] wrappy(json-enforce) -> crazyrouter model=${fb.rewriteModel}`);
    shipError(`wrappy fallback -> crazyrouter (json-enforce)`, { from: "wrappy", model: model || "-", fbModel: fb.rewriteModel, ip });
    return true;
  }

  let lastErr = "", lastRaw = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    reqObj.messages = messages;
    let up;
    try { up = await fetch(target, { method: req.method, headers, redirect: "follow", body: Buffer.from(JSON.stringify(reqObj)) }); }
    catch (e) {
      // wrappy unreachable → fall back to crazyrouter and retry this attempt.
      if (curLane === "wrappy" && !fellBack && switchWrappyToCrazy()) { attempt--; continue; }
      console.error(`[err] json-enforce fetch-failed lane=${curLane} model=${model || "-"} ${target}: ${e.message}`);
      shipError(`json-enforce upstream fetch failed: ${e.message}`, { model: model || "-", lane: curLane, ip, target });
      recordCall({ ...logRec, status: 502, ms: Date.now() - t0, error: "upstream fetch failed: " + e.message });
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "upstream fetch failed: " + e.message } }));
    }
    const text = await up.text();
    if (up.status >= 400) {                                // upstream error
      // wrappy server-side failure → fall back to crazyrouter and retry this attempt.
      if (curLane === "wrappy" && !fellBack && isWrappyFailure(up.status, false)) { wrappyCircuitTrip(); if (switchWrappyToCrazy()) { attempt--; continue; } }
      console.error(`[err] upstream=${up.status} lane=${curLane} model=${model || "-"} ${target} (json-enforce)`);
      shipError(`upstream ${up.status} ${req.method} ${req.url} (json-enforce)`, { model: model || "-", lane: curLane, ip, status: up.status, body: text });
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
    // claudebox quota notice leaked as a 200 → wrappy is effectively down. Fail over to crazyrouter
    // (one shot) instead of burning JSON retries against a model that will never answer.
    if (curLane === "wrappy" && !fellBack && isClaudeboxNotice(content)) { wrappyCircuitTrip(); if (switchWrappyToCrazy()) { attempt--; continue; } }
    const v = validateJsonContent(content);
    if (v.ok) {
      if (curLane !== "crazyrouter") wrappyCircuitReset(); // healthy wrappy response
      if (v.repaired) { msg.content = v.value; logJson(up.status, parsed, null); return finishJson(res, wantStream, parsed, JSON.stringify(parsed)); }
      logJson(up.status, parsed, null);
      return finishJson(res, wantStream, parsed, text);
    }
    lastErr = v.error; lastRaw = content == null ? "" : content;
    console.error(`[err] json-invalid lane=${lane} model=${model || "-"} attempt=${attempt + 1}/${maxRetries + 1}: ${v.error}`);
    if (attempt < maxRetries) {
      // Neutral, non-accusatory wording: claude-haiku reads "your reply failed / do it again" as a
      // prompt-injection attempt and refuses harder. Just restate the format requirement plainly.
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({ role: "user", content: `Please reformat that as a single valid JSON value only — no markdown code fences and no text before or after the JSON.` });
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
      if (!ids.has(id)) { ids.add(id); out.push({ id, object: "model", owned_by: "local" }); }
    }
  }
  return out;
}

// Fetch wrappy + crazyrouter catalogs (best-effort). Returns {wrappy, crazyrouter}.
async function upstreamCatalogs() {
  let wrappy = [];
  try {
    const c = await fetch(CFG.bases.wrappy + "/v1/models", { headers: { authorization: `Bearer ${CFG.wrappyToken}` } });
    const cj = await c.json();
    wrappy = ((cj && cj.data) || []).map((m) => ({ ...m, owned_by: "wrappy" }));
  } catch { /* wrappy down — skip */ }
  let crazyrouter = [];
  const seen = new Set();
  try {
    const u = await fetch(CFG.bases.crazyrouter + "/v1/models", { headers: { authorization: `Bearer ${CFG.crazyrouterKey}` } });
    const j = await u.json();
    for (const m of (j && j.data) || []) { if (m && m.id && !seen.has(m.id)) { seen.add(m.id); crazyrouter.push(m); } }
  } catch { /* crazyrouter /v1/models down — fall back to the price feed below */ }
  // crazyrouter.com/v1/models only lists a sliver of the catalog for some keys, while the price
  // feed (gen-prices.sh → /api/pricing) carries the full ~250. Merge in any priced ids we don't
  // already have so /v1/models reflects everything that's actually routable.
  try {
    const pj = JSON.parse(fs.readFileSync(PRICES_FILE, "utf8"));
    for (const m of (pj && pj.models) || []) {
      const id = m && m.model;
      if (id && !seen.has(id)) { seen.add(id); crazyrouter.push({ id, object: "model", owned_by: "crazyrouter" }); }
    }
  } catch { /* no price feed yet — keep whatever the live catalog returned */ }
  return { wrappy, crazyrouter };
}

async function mergedModels(res) {
  const local = localModelEntries();
  const { wrappy, crazyrouter } = await upstreamCatalogs();
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify({ object: "list", data: [...local, ...wrappy, ...crazyrouter] }));
}

// Build a concrete route for an explicit (lane, model) — used by forceModel / modelRoutes /
// defaultRoute. `model` is the id actually sent upstream (rewriteModel).
function laneRoute(lane, model, reason) {
  const l = normLane(lane) || "crazyrouter";
  if (l === "wrappy") return { lane: "wrappy", base: CFG.bases.wrappy, authToken: CFG.wrappyToken, rewriteModel: model || undefined, reason };
  if (l === "local") return { lane: "local", base: CFG.bases.local, rewriteModel: model, target: model, reason };
  return { lane: "crazyrouter", base: CFG.bases.crazyrouter, injectKey: true, rewriteModel: model || undefined, reason };
}

// Where unknown / empty / crazyrouter-blocked models go. lane "none" → blocked (caller gets 400).
function defaultRouteResolved(why) {
  const d = CFG.defaultRoute || { lane: "none" };
  if (!d.lane || d.lane === "none" || !d.model) return { lane: "blocked", blocked: true, why, reason: why + "; no default route" };
  return { ...laneRoute(d.lane, d.model, `default route (${why})`), via: "default" };
}

// Resolve a model name into a concrete upstream route. Priority:
//   1. forceModel (global override)  2. modelRoutes (per-model, any lane)  3. local alias map
//   4. wrappy prefix  5. empty model → default route  6. cloud policy (open/allowlist/off)
function resolveRoute(model) {
  const m = model == null ? "" : String(model);
  const key = m.toLowerCase();
  if (CFG.forceModel && CFG.forceModel.enabled && CFG.forceModel.model)
    return laneRoute(CFG.forceModel.lane, CFG.forceModel.model, "forced (global)");
  if (CFG.modelRoutes && CFG.modelRoutes[key])
    return laneRoute(CFG.modelRoutes[key].lane, CFG.modelRoutes[key].model || m, `override: ${key}`);
  const lt = localTarget(m);
  if (lt) return { lane: "local", base: CFG.bases.local, rewriteModel: lt, target: lt, reason: "local alias" };
  if (isWrappyModel(m)) {
    if (wrappyCircuitOpen()) {
      // Circuit is open — route directly to the fallback without touching wrappy.
      const fb = wrappyFallbackRoute(m);
      if (fb) return { ...fb, reason: "wrappy circuit open → crazyrouter" };
    }
    return { lane: "wrappy", base: CFG.bases.wrappy, authToken: CFG.wrappyToken, reason: "wrappy prefix" };
  }
  if (!m) return defaultRouteResolved("no model specified");
  const pol = CFG.cloudPolicy || "open";
  if (pol === "open") return { lane: "crazyrouter", base: CFG.bases.crazyrouter, injectKey: true, reason: "crazyrouter (open)" };
  if (pol === "allowlist" && (CFG.cloudAllowlist || []).some((x) => x.toLowerCase() === key))
    return { lane: "crazyrouter", base: CFG.bases.crazyrouter, injectKey: true, reason: "crazyrouter (allowlisted)" };
  return defaultRouteResolved(pol === "off" ? "crazyrouter lane disabled" : "not in crazyrouter allowlist");
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
    lanes: LANES,
    bases: CFG.bases,
    localMap: CFG.localMap,
    gatedModels: CFG.gatedModels,
    wrappyPrefix: CFG.wrappyPrefix,
    wrappyFallback: CFG.wrappyFallback,
    forceModel: CFG.forceModel,
    modelRoutes: CFG.modelRoutes,
    cloudPolicy: CFG.cloudPolicy,
    cloudAllowlist: CFG.cloudAllowlist,
    defaultRoute: CFG.defaultRoute,
    jsonEnforce: CFG.jsonEnforce,
    jsonMaxRetries: CFG.jsonMaxRetries,
    requireProject: CFG.requireProject,
    logging: CFG.logging,
    loggingDbReady: !!db,
    // secrets — never returned in clear
    crazyrouterKeySet: !!CFG.crazyrouterKey, crazyrouterKeyMasked: mask(CFG.crazyrouterKey),
    wrappyTokenSet: !!CFG.wrappyToken, wrappyTokenMasked: mask(CFG.wrappyToken),
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
  const k = key || CFG.crazyrouterKey;
  const out = { keySet: !!k, keyMasked: mask(k) };
  if (!k) return { ...out, error: "no key set" };
  const base = CFG.bases.crazyrouter;
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
  if (route.lane === "crazyrouter") headers.authorization = `Bearer ${CFG.crazyrouterKey}`;
  else if (route.lane === "wrappy") headers.authorization = `Bearer ${CFG.wrappyToken}`;
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
    if (patch.bases) {
      if (typeof patch.bases.local === "string") next.bases.local = patch.bases.local;
      if (typeof (patch.bases.crazyrouter ?? patch.bases.crazy) === "string") next.bases.crazyrouter = patch.bases.crazyrouter ?? patch.bases.crazy;
      if (typeof (patch.bases.wrappy ?? patch.bases.claude) === "string") next.bases.wrappy = patch.bases.wrappy ?? patch.bases.claude;
    }
    if (patch.localMap) next.localMap = patch.localMap;
    if (patch.gatedModels) next.gatedModels = patch.gatedModels;
    if (typeof (patch.wrappyPrefix ?? patch.claudePrefix) === "string") next.wrappyPrefix = patch.wrappyPrefix ?? patch.claudePrefix;
    if (patch.wrappyFallback && typeof patch.wrappyFallback === "object") next.wrappyFallback = patch.wrappyFallback;
    if (patch.forceModel) next.forceModel = patch.forceModel;
    if (patch.modelRoutes) next.modelRoutes = patch.modelRoutes;
    if (patch.cloudPolicy) next.cloudPolicy = patch.cloudPolicy;
    if (patch.cloudAllowlist) next.cloudAllowlist = patch.cloudAllowlist;
    if (patch.defaultRoute) next.defaultRoute = patch.defaultRoute;
    if (typeof patch.jsonEnforce === "boolean") next.jsonEnforce = patch.jsonEnforce;
    if (patch.jsonMaxRetries !== undefined) next.jsonMaxRetries = patch.jsonMaxRetries;
    if (typeof patch.requireProject === "boolean") next.requireProject = patch.requireProject;
    if (patch.logging && typeof patch.logging === "object") Object.assign(next.logging, patch.logging);
    if (typeof (patch.crazyrouterKey ?? patch.crazyKey) === "string") next.crazyrouterKey = patch.crazyrouterKey ?? patch.crazyKey;
    if (typeof (patch.wrappyToken ?? patch.claudeToken) === "string") next.wrappyToken = patch.wrappyToken ?? patch.claudeToken;
    for (const k of ["oblitToken", "adminPassword"])
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
    const [local, wrappy, crazyrouter] = await Promise.all([
      probe(CFG.bases.local), probe(CFG.bases.wrappy, CFG.wrappyToken), probe(CFG.bases.crazyrouter, CFG.crazyrouterKey),
    ]);
    return sendJson(res, 200, { local, wrappy, crazyrouter });
  }

  if (sub === "models" && req.method === "GET") {
    const { wrappy, crazyrouter } = await upstreamCatalogs();
    return sendJson(res, 200, { local: localModelEntries(), wrappy, crazyrouter });
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
      base: r.base || (r.lane === "local" ? CFG.bases.local : r.lane === "wrappy" ? CFG.bases.wrappy : r.lane === "crazyrouter" ? CFG.bases.crazyrouter : ""),
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
    if (q.project) { where.push(q.project === "(none)" ? "(project IS NULL OR project = '')" : "project = ?"); if (q.project !== "(none)") params.push(String(q.project).toLowerCase()); }
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
        prompt_tokens,completion_tokens,total_tokens,error,project,
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
      const q = url.parse(req.url, true).query;
      // time window: '15m','1h','6h','24h','7d','30d' or 'all'. Default 24h.
      const WINDOWS = { "15m": 900000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
      const winKey = (q.window in WINDOWS || q.window === "all") ? q.window : "24h";
      const since = winKey === "all" ? 0 : Date.now() - WINDOWS[winKey];
      const W = "ts >= ?"; // window predicate, bound to `since`
      const total = db.prepare("SELECT COUNT(*) n FROM calls").get().n;
      const windowCalls = db.prepare(`SELECT COUNT(*) n FROM calls WHERE ${W}`).get(since).n;
      const windowErrors = db.prepare(`SELECT COUNT(*) n FROM calls WHERE ${W} AND status >= 400`).get(since).n;
      const windowTokens = db.prepare(`SELECT COALESCE(SUM(total_tokens),0) t FROM calls WHERE ${W}`).get(since).t;
      const byLane = db.prepare(`SELECT lane, COUNT(*) n, COALESCE(SUM(total_tokens),0) tok FROM calls WHERE ${W} GROUP BY lane ORDER BY n DESC`).all(since);
      const byKey = db.prepare(`SELECT key_label, COUNT(*) n FROM calls WHERE ${W} GROUP BY key_label ORDER BY n DESC`).all(since);
      const byModel = db.prepare(`SELECT req_model, lane, COUNT(*) n, COALESCE(SUM(total_tokens),0) tok, ROUND(AVG(duration_ms)) avg_ms FROM calls WHERE ${W} GROUP BY req_model ORDER BY n DESC LIMIT 30`).all(since);
      const byProject = db.prepare(`SELECT COALESCE(NULLIF(project,''),'(none)') project, COUNT(*) n,
        COALESCE(SUM(total_tokens),0) tok, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) errors
        FROM calls WHERE ${W} GROUP BY COALESCE(NULLIF(project,''),'(none)') ORDER BY n DESC LIMIT 50`).all(since);
      const oldest = db.prepare("SELECT MIN(ts) t FROM calls").get().t;
      return sendJson(res, 200, { dbReady: true, window: winKey, total, windowCalls, windowErrors, windowTokens, byLane, byKey, byModel, byProject, oldest, retain: CFG.logging.retain });
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
    return proxy(req, res, CFG.bases.local, { bodyBuf, lane: "local" });
  }
  if (req.method === "GET" && (path === "/v1/models" || path === "/api/v1/models"))
    return mergedModels(res);

  const bodyBuf = ["GET", "HEAD"].includes(req.method) ? Buffer.alloc(0) : await readBody(req);
  let model = null;
  if (bodyBuf.length) { try { model = JSON.parse(bodyBuf.toString()).model; } catch { /* not json */ } }
  const ip = req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const project = extractProject(req, bodyBuf);
  const route = resolveRoute(model);
  const lane = route.lane;
  console.log(`[req] ${new Date().toISOString()} ip=${ip} ${req.method} ${path} model=${model || "-"} -> ${lane}${route.rewriteModel ? "(" + route.rewriteModel + ")" : ""} project=${project || "-"} ua="${String(req.headers["user-agent"] || "").slice(0, 50)}"`);

  // Project attribution gate: when on, inference POSTs must declare a project.
  const isInference = req.method === "POST" && bodyBuf.length && /\/(chat\/completions|responses|completions|messages|chat)$/.test(path);
  if (CFG.requireProject && isInference && !project) {
    console.error(`[err] 400 missing project ip=${ip} model=${model || "-"}`);
    recordCall({ ts: Date.now(), ip, ua: req.headers["user-agent"] || "", method: req.method, path,
      reqModel: model || null, lane: "blocked", sentModel: null, keyLabel: "—", status: 400, ms: 0,
      error: "missing project", reqContent: extractRequestContent(bodyBuf), project: null });
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "missing project attribution: send an 'X-Project' header (or a 'project' body field) identifying the calling app.", type: "invalid_request_error", code: "project_required" } }));
  }

  // Flow policy blocked this model (crazyrouter off / not allowlisted / unknown with no default route).
  if (route.blocked) {
    console.error(`[err] 400 blocked ip=${ip} model=${model || "-"} (${route.why})`);
    // Only log real inference attempts as blocked — not scanner GETs to /openapi.json, /favicon, etc.
    if (req.method === "POST" && bodyBuf.length)
      recordCall({ ts: Date.now(), ip, ua: req.headers["user-agent"] || "", method: req.method, path,
        reqModel: model || null, lane: "blocked", sentModel: null, keyLabel: "—", status: 400, ms: 0,
        error: `not routable: ${route.why}`, reqContent: extractRequestContent(bodyBuf), project });
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: `model '${model || ""}' is not routable: ${route.why}. Set a model override, crazyrouter allowlist entry, or default route in /admin.`, type: "invalid_request_error", code: "model_not_routable" } }));
  }

  // Bearer gate for the uncensored local model(s).
  if (lane === "local" && isGated(route.target) && CFG.oblitToken) {
    const auth = String(req.headers["authorization"] || "");
    const xkey = String(req.headers["x-api-key"] || "");
    if (auth !== `Bearer ${CFG.oblitToken}` && xkey !== CFG.oblitToken) {
      console.error(`[err] 401 gated model unauthorized ip=${ip} model=${route.target}`);
      recordCall({ ts: Date.now(), ip, ua: req.headers["user-agent"] || "", method: req.method, path, project,
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
      return jsonEnforce(req, res, { ...route, model, lane, ip, bodyBuf, project });
    }
  }
  return proxy(req, res, route.base, { ...route, bodyBuf, model, lane, project });
});

server.listen(PORT, () => console.log(`llm-hostbun-proxy on :${PORT} crazyrouter=${CFG.bases.crazyrouter} wrappy=${CFG.bases.wrappy} local=${CFG.bases.local} key=${CFG.crazyrouterKey ? "set" : "MISSING"} admin=/admin`));
