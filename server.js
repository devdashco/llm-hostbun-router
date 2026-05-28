// llm.hostbun.cc — single-URL OpenAI router.
//   model "gemma" / "google/gemma-4-26b-a4b"  -> local LM Studio (llm.bofrid.dev), no key
//   any other model                           -> crazyrouter.com, key injected
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

const LOCAL_NAMES = new Set([CANON.toLowerCase(), "gemma", "gemma-local", "local"]);
const isLocalModel = (m) => {
  if (!m) return false;
  const s = String(m).toLowerCase();
  return LOCAL_NAMES.has(s) || s.startsWith("gemma");
};

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

async function proxy(req, res, base, { bodyBuf, injectKey, rewriteLocal } = {}) {
  const target = base + req.url;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_REQ.has(k.toLowerCase())) headers[k] = v;
  }
  if (injectKey) headers["authorization"] = `Bearer ${KEY}`;
  let body = bodyBuf;
  if (rewriteLocal && bodyBuf && bodyBuf.length) {
    try {
      const j = JSON.parse(bodyBuf.toString());
      if (j && j.model) { j.model = CANON; body = Buffer.from(JSON.stringify(j)); headers["content-type"] = "application/json"; }
    } catch { /* leave body as-is */ }
  }
  const init = { method: req.method, headers, redirect: "follow" };
  if (!["GET", "HEAD"].includes(req.method) && body && body.length) init.body = body;
  let up;
  try { up = await fetch(target, init); }
  catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "upstream fetch failed: " + e.message } }));
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
      { id: CANON, object: "model", owned_by: "local-lmstudio" },
      { id: "gemma", object: "model", owned_by: "local-lmstudio" },
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
  if (isLocalModel(model)) return proxy(req, res, LOCAL, { bodyBuf, injectKey: false, rewriteLocal: true });
  return proxy(req, res, CRAZY, { bodyBuf, injectKey: true });
});

server.listen(PORT, () => console.log(`llm-hostbun-proxy on :${PORT} crazy=${CRAZY} local=${LOCAL} key=${KEY ? "set" : "MISSING"}`));
