// llm.hostbun.cc — single-URL OpenAI router.
//   model "gemma" / "local" / "google/gemma-4-26b-a4b"   -> local LM Studio gemma, no key
//   model "obliterated" / "qwen3.6-27b-obliterated"      -> local LM Studio Qwen3.6-27B abliterated
//   any other model                                      -> crazyrouter.com, key injected
//   (local models JIT-swap in VRAM — both don't fit at once)
//   GET /v1/models                            -> local gemma + crazyrouter's full list (merged)
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

// Alias (lowercased) -> the exact model id sent to LM Studio. "local"/"gemma" map to the
// gemma MoE (back-compat); "obliterated" + the full id map to the Qwen3.6-27B abliterated
// model. Exact match only, so cloud models that merely start with "gemma" aren't hijacked.
// Both local models can't fit VRAM at once — LM Studio JIT-swaps between them on request.
const LOCAL_MAP = new Map([
  ["local", CANON],
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

async function proxy(req, res, base, { bodyBuf, injectKey, rewriteModel, model, lane } = {}) {
  const target = base + req.url;
  const ip = req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_REQ.has(k.toLowerCase())) headers[k] = v;
  }
  if (injectKey) headers["authorization"] = `Bearer ${KEY}`;
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

async function mergedModels(res) {
  try {
    const u = await fetch(CRAZY + "/v1/models", { headers: { authorization: `Bearer ${KEY}` } });
    const j = await u.json();
    const local = [
      { id: "local", object: "model", owned_by: "local-lmstudio" },
      { id: CANON, object: "model", owned_by: "local-lmstudio" },
      { id: OBLIT, object: "model", owned_by: "local-lmstudio" },
    ];
    j.data = [...local, ...((j && j.data) || [])];
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(j));
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "models merge failed: " + e.message } }));
  }
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
  const lane = isLocalModel(model) ? "local" : "cloud";
  console.log(`[req] ${new Date().toISOString()} ip=${ip} ${req.method} ${path} model=${model || "-"} -> ${lane} ua="${String(req.headers["user-agent"] || "").slice(0, 50)}"`);
  if (isLocalModel(model)) return proxy(req, res, LOCAL, { bodyBuf, injectKey: false, rewriteModel: localTarget(model), model, lane });
  return proxy(req, res, CRAZY, { bodyBuf, injectKey: true, model, lane });
});

server.listen(PORT, () => console.log(`llm-hostbun-proxy on :${PORT} crazy=${CRAZY} local=${LOCAL} key=${KEY ? "set" : "MISSING"}`));
