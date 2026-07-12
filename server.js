// llm.hostbun.cc — single-URL OpenAI router + control panel.
//
// PROVIDERS — where a request is actually served. Three, and that is the whole taxonomy:
//   • local        -> llama.cpp on the pbox GPU (OpenAI-native; base + ids from config.json)
//   • claudecode   -> the claudecode-account-pool (our Claude Max logins) -> api.anthropic.com
//   • crazyrouter  -> crazyrouter.com cloud relay (CRAZYROUTER_KEY injected server-side)
//
//   model "local" / "qwen3.5-9b"                -> local (pbox GPU)
//   model "claude*" (e.g. claude-sonnet-4-6)    -> claudecode, the pinned account's token injected
//   any other model                             -> crazyrouter, key injected
//   model "imagegen"  +  POST /v1/images/*      -> image generation (SD-Turbo on the pbox GPU)
//   GET /v1/models                              -> local + claudecode + crazyrouter (merged)
//   /docs, docs.<host>                         -> docs page
//   /prices(.json)                             -> computed price feed (CORS *)
//   /local/*                                   -> back-compat: strips /local, proxies to the local provider (pbox)
//   /  and /api/*                              -> password-gated control panel + its JSON API
//
// Routing is driven by a live, mutable CFG object. CFG is seeded from env defaults and then
// overlaid with /data/config.json (a Coolify-managed persistent volume) — so edits made in the
// panel take effect immediately AND survive restarts/reboots/redeploys. Nothing here needs a
// redeploy to change routing.
//
// NAMING: canonical provider ids are `local`, `crazyrouter`, `claudecode`. The legacy ids `cloud`
// (=crazyrouter), `claude`, `anthropic`, and the retired wrapper's id all normalize to
// one of those on input, so older /data/config.json files and call-log rows keep working without a
// reset. A few internals still spell the field `provider`; it means provider.
//
// LAYOUT — this file is the HTTP layer and nothing else. The router proper lives in src/:
//   src/config.js      live CFG (env + /data/config.json), sanitizers, key index
//   src/identity.js    who is calling: consumer/job paths, API keys, authenticate()
//   src/routing.js     where it goes: pins, allowlists, groups, usage limits, account pinning
//   src/http.js        the wire: readBody, buildHeaders, proxy(), JSON enforcement
//   src/db.js          the call log (Postgres) and harvested account headroom
//   src/claudecode.js  the Anthropic model catalog
//   src/admin.js       the control-plane API (/api/*) behind the password cookie
//   src/telemetry.js   call-log row shaping + HyperDX error shipping
//   src/pricing.js     USD estimates (crazyrouter only; the rest are flat or free)
//   translate.js       OpenAI <-> Anthropic, pure functions, unit-tested
const http = require("node:http");
const nodePath = require("node:path");

const { CFG, loadConfig, UI_ROUTES } = require("./src/config");
const { initDb, primeAcctCacheSoon, recordCall } = require("./src/db");
const { extractProject, parseConsumer, authenticate, consumerEntry, startKeyUseFlush } = require("./src/identity");
const { resolveRoute, accountFor, usageVerdict, sleep, isGated } = require("./src/routing");
const { readBody, sendFile, proxy, headroomCompress, HEADROOM_URL, jsonEnforce, wantsJsonFormat } = require("./src/http");
const { mergedModels, refreshClaudecodeModels, refreshAccountLimits, CLAUDECODE_MODEL_REFRESH_MS } = require("./src/claudecode");
const { handleAdminApi } = require("./src/admin");
const { PRICES_FILE } = require("./src/pricing");
// Used on every refusal path (missing project, unknown consumer, bad key, unpinned account) and by
// the upstream-error shipper. Unbound since the split, so each gate 502'd instead of refusing.
const { extractRequestContent, shipError } = require("./src/telemetry");

// A single malformed request must NEVER take down the whole proxy. This is a
// stateless per-request router, so a thrown error in one handler is isolated —
// log it and keep serving every other provider. (Root cause this guards: the retired
// quota-sniff consumes up.body via arrayBuffer(); on a failover path that left
// up.body locked, Readable.fromWeb(up.body) threw ERR_INVALID_STATE and
// crash-looped the container ~150x, 308/502'ing every provider incl. funnel-articles.)
process.on("uncaughtException", (err) => {
  console.error(`[fatal-guard] uncaughtException: ${err && err.stack ? err.stack : err}`);
});
process.on("unhandledRejection", (err) => {
  console.error(`[fatal-guard] unhandledRejection: ${err && err.stack ? err.stack : err}`);
});

const PORT = parseInt(process.env.PORT || "80", 10);
const DOCS_FILE = process.env.DOCS_FILE || "/srv/docs/index.html";
// The docsify markdown and its vendored bundle sit beside the shell, in both dev and the container.
const DOCS_DIR = nodePath.dirname(DOCS_FILE);
const ADMIN_FILE = process.env.ADMIN_FILE || "/srv/admin/index.html";
// Every refusal carries this. A 4xx that does not say where the answer lives just becomes a Slack
// message to whoever wrote the router.
const DOCS_URL = process.env.DOCS_URL || "https://docs.llm.hostbun.cc/";
// The panel's modules live next to its shell, so a dev run (ADMIN_FILE=./admin/index.html) and the
// container (/srv/admin/index.html) both resolve without a second env var to forget.
const UI_DIR = nodePath.join(nodePath.dirname(ADMIN_FILE), "ui");

// Config first: every module below reads CFG, and the key index must exist before the first request.
loadConfig();
initDb();
// The identity registry (developers → machines, and projects) lives in Postgres and is projected
// into CFG. Boot must not BLOCK on a cross-internet DB, so this runs in the background: until it
// lands, CFG holds the /data/config.json mirror, which is a valid — if possibly stale — registry.
// A DB that never answers therefore degrades to "last known good", not to "nobody can authenticate".
require("./src/registry").initRegistry()
  .then(() => console.log(`[registry] ${Object.keys(CFG.consumers || {}).length} consumer(s) loaded`))
  .catch((e) => console.error(`[registry] init failed, serving the config mirror: ${e.message}`));
primeAcctCacheSoon();
startKeyUseFlush();

// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || "").toLowerCase();
  const path = (req.url || "/").split("?")[0];

  // The control-plane UI (only on the main host, never docs.*).
  //
  // There is no /admin anything. The site root IS the panel, behind the password (the SPA renders
  // <Login/> until /api/state stops 401'ing), and its JSON API is /api/*. The old /admin/api/*
  // prefix and the /admin -> / redirect are GONE: claudectl, the statusline and the cccc TUI were
  // repointed at /api/* first, because deleting a prefix your own tooling still calls is how a
  // cleanup becomes an outage.
  //
  // The two carve-outs below are load-bearing. /api/v1/* is the OpenAI-compatible surface (a caller
  // that sets base_url=https://llm.hostbun.cc/api reaches /api/v1/chat/completions), and /api/pricing
  // is public. Routing either into the cookie-gated admin handler would 401 real inference traffic.
  if (!host.startsWith("docs.")) {
    if (path.startsWith("/api/") && !path.startsWith("/api/v1/") && path !== "/api/pricing")
      return handleAdminApi(req, res, path, "/api/");
    // A tombstone, not a route. Without it /admin/* falls through to the model router and a stale
    // `POST /admin/api/login` is read as an inference request — answered "model_not_routable" and
    // written to the call log as blocked traffic. 404 with a pointer is the honest answer.
    if (path === "/admin" || path.startsWith("/admin/")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: {
        type: "gone", code: "admin_prefix_removed",
        message: "the /admin prefix was removed; the panel is at / and its JSON API at /api/*",
      } }));
    }
    // The panel's own ES modules and stylesheet. Served from a fixed directory beside ADMIN_FILE,
    // and the path is REJECTED unless it matches [a-z0-9-]+(/[a-z0-9-]+)?\.(js|css) — no "..", no
    // absolute paths, no arbitrary reads off the container's filesystem.
    if (req.method === "GET" && path.startsWith("/ui/")) {
      const rel = path.slice(4);
      if (!/^[a-z0-9-]+(\/[a-z0-9-]+)?\.(js|css)$/.test(rel)) {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("not found");
      }
      const type = rel.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
      return sendFile(res, nodePath.join(UI_DIR, rel), type, false, "no-cache");
    }
    // The SPA pushes /calls, /accounts, … so those must serve the shell on a hard refresh.
    // Enumerated, never a catch-all: a catch-all at the root would shadow /v1/*, /local/*, and
    // every future inference path, turning a routing bug into "the model endpoint returns HTML".
    if (req.method === "GET" && (path === "/" || UI_ROUTES.has(path.replace(/\/$/, ""))))
      return sendFile(res, ADMIN_FILE, "text/html; charset=utf-8", false, "no-cache");
  }

  // Docs. A docsify site: one shell plus markdown, both served out of DOCS_DIR. It is reachable two
  // ways — docs.<host> at the root, and /docs/ on the router — so the shell's asset paths are
  // RELATIVE, and /docs must redirect to /docs/ or `vendor/docsify.js` resolves to /vendor/docsify.js
  // and the page renders "loading…" forever.
  if (path === "/docs") {
    res.writeHead(301, { location: "/docs/" });
    return res.end();
  }
  if (host.startsWith("docs.") || path.startsWith("/docs/")) {
    const rel = (host.startsWith("docs.") ? path : path.slice("/docs".length)).replace(/^\/+/, "");
    if (!rel) return sendFile(res, DOCS_FILE, "text/html; charset=utf-8", false);
    // Allowlisted by extension and shape. `_sidebar.md` needs the leading underscore; nothing here
    // needs "..", an absolute path, or any other extension.
    if (!/^[a-z0-9_-]+(\/[a-z0-9_.-]+)?\.(md|js|css)$/i.test(rel)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    const type = rel.endsWith(".css") ? "text/css; charset=utf-8"
      : rel.endsWith(".js") ? "text/javascript; charset=utf-8"
      : "text/markdown; charset=utf-8";
    return sendFile(res, nodePath.join(DOCS_DIR, rel), type, false);
  }
  if (path === "/prices.json" || path === "/prices")
    return sendFile(res, PRICES_FILE, "application/json", true);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
    return res.end();
  }
  if (path.startsWith("/local/")) {
    const bodyBuf = ["GET", "HEAD"].includes(req.method) ? Buffer.alloc(0) : await readBody(req);
    req.url = req.url.slice("/local".length);
    return proxy(req, res, CFG.bases.local, { bodyBuf, provider: "local" });
  }
  if (req.method === "GET" && (path === "/v1/models" || path === "/api/v1/models"))
    return mergedModels(res);

  // Image generation → SD-Turbo (pbox GPU). Routed by path, not model name; the upstream bearer
  // is injected server-side. No project gate / model routing applies.
  if (req.method === "POST" && /\/images\/(generations|edits|variations)$/.test(path)) {
    let imgBody = await readBody(req);
    // SDXL VAE downsamples ×8 to latent space; non-multiples of 8 crash upstream with bare 500.
    try {
      const j = JSON.parse(imgBody.toString());
      if (j.size && typeof j.size === "string") {
        const m = j.size.match(/^(\d+)x(\d+)$/i);
        if (m) {
          const w = Math.floor(+m[1] / 8) * 8;
          const h = Math.floor(+m[2] / 8) * 8;
          if (+m[1] !== w || +m[2] !== h) { j.size = `${w}x${h}`; imgBody = Buffer.from(JSON.stringify(j)); }
        }
      }
    } catch { /* leave body as-is */ }
    return proxy(req, res, CFG.bases.images, { bodyBuf: imgBody, provider: "images", authToken: CFG.imageToken, project: extractProject(req, imgBody) });
  }
  // Image-service catalog endpoints (templates + LoRAs) — proxy GETs straight through.
  if (req.method === "GET" && (path === "/v1/templates" || path === "/v1/loras")) {
    return proxy(req, res, CFG.bases.images, { bodyBuf: Buffer.alloc(0), provider: "images", authToken: CFG.imageToken });
  }

  let bodyBuf = ["GET", "HEAD"].includes(req.method) ? Buffer.alloc(0) : await readBody(req);
  let model = null;
  if (bodyBuf.length) { try { model = JSON.parse(bodyBuf.toString()).model; } catch { /* not json */ } }
  const ip = req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  // Identity. A valid key OUTRANKS anything the caller says about itself: the consumer comes from
  // the key, and only the job half of X-Project (or an X-Job header) is still taken on trust — a job
  // is a label inside an already-authenticated consumer, so it cannot be used to bill someone else.
  const authMode = (CFG.auth && CFG.auth.mode) || "optional";
  const auth = authMode === "off" ? null : authenticate(req);
  let project;
  if (auth && auth.ok) {
    const job = String(req.headers["x-job"] || "").trim().toLowerCase() || parseConsumer(extractProject(req, bodyBuf)).job;
    project = job ? `${auth.consumer}:${job}` : auth.consumer;
  } else {
    project = extractProject(req, bodyBuf);
  }
  const route = resolveRoute(model, project);
  const provider = route.provider;
  console.log(`[req] ${new Date().toISOString()} ip=${ip} ${req.method} ${path} model=${model || "-"} -> ${provider}${route.rewriteModel ? "(" + route.rewriteModel + ")" : ""} project=${project || "-"} ua="${String(req.headers["user-agent"] || "").slice(0, 50)}"`);

  const isInference = req.method === "POST" && bodyBuf.length && /\/(chat\/completions|responses|completions|messages|chat)$/.test(path);

  // A key that was PRESENTED and is bad is always an error, in every mode above "off". Falling back
  // to the header there would mean a revoked key silently keeps working under its old name.
  // A 401 is read by a machine at 3am and by a person who has never seen this router. It should say
  // what happened, where the fix lives, and the exact bytes to change — not "unauthorized".
  //
  // `claimed` is the name the caller asserted (X-Project / user field). When it looks like a real
  // consumer, name its keyvault path outright: that is the single most useful sentence we can emit.
  const keyFail = (why) => {
    const claimed = parseConsumer(extractProject(req, bodyBuf)).consumer;
    const known = claimed && consumerEntry(claimed);
    console.error(`[err] 401 ${why} ip=${ip} model=${model || "-"} claimed=${claimed || "-"}`);
    recordCall({ ts: Date.now(), ip, ua: req.headers["user-agent"] || "", method: req.method, path,
      reqModel: model || null, provider: "blocked", sentModel: null, keyLabel: "—", status: 401, ms: 0,
      error: why, reqContent: extractRequestContent(bodyBuf), project: claimed || null });
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer realm="llm.hostbun.cc"` });
    return res.end(JSON.stringify({ error: {
      type: "invalid_api_key", code: "invalid_api_key",
      message: `${why}. This router requires an API key: send it as \`Authorization: Bearer sk-llm-…\` (any OpenAI client) or \`x-api-key\` (Anthropic SDK). The key identifies you — no X-Project header is needed.`,
      docs: `${DOCS_URL}#/identity?id=authenticating`,
      your_key: known
        ? `keyvault: llm/${claimed}/API_KEY   (you sent X-Project: ${claimed}, which is no longer an identity)`
        : "keyvault: llm/<your-consumer>/API_KEY — ask in #eng if you do not know your consumer name",
      example: "curl https://llm.hostbun.cc/v1/chat/completions -H 'Authorization: Bearer sk-llm-…' -H 'content-type: application/json' -d '{\"model\":\"claude-haiku-4-5\",\"messages\":[…]}'",
      no_key_yet: "POST /api/consumers/keys {\"name\":\"<consumer>\"} from the panel at https://llm.hostbun.cc/ → Consumers",
    } }));
  };
  if (auth && !auth.ok && isInference) return keyFail(auth.why);
  // `required`: no key, no service. This is the mode where the self-asserted X-Project header stops
  // being an identity and becomes a mere label.
  if (authMode === "required" && isInference && !(auth && auth.ok)) return keyFail("missing API key");

  // Project attribution gate: when on, inference POSTs must declare a project.
  if (CFG.requireProject && isInference && !project) {
    console.error(`[err] 400 missing project ip=${ip} model=${model || "-"}`);
    recordCall({ ts: Date.now(), ip, ua: req.headers["user-agent"] || "", method: req.method, path,
      reqModel: model || null, provider: "blocked", sentModel: null, keyLabel: "—", status: 400, ms: 0,
      error: "missing project", reqContent: extractRequestContent(bodyBuf), project: null });
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: {
      type: "invalid_request_error", code: "project_required",
      message: "no identity on this request. Send your API key as `Authorization: Bearer sk-llm-…` — it identifies you.",
      docs: `${DOCS_URL}#/identity?id=authenticating`,
    } }));
  }

  // Registration gate: a name must be one we agreed on, not one the caller invented. Without this
  // a typo becomes a new "consumer" with its own usage row, and `totally-made-up-xyz` bills whoever
  // it happens to resolve to. Registration is by CONSUMER — the job half of the path is free.
  // NOTE: this is still not authentication. The name remains self-asserted; a caller who knows a
  // registered name can claim it. Per-consumer API keys are what close that (see "Open work").
  if (CFG.requireRegisteredConsumer && isInference && project && !consumerEntry(project)) {
    const { consumer } = parseConsumer(project);
    const known = Object.keys(CFG.consumers || {}).sort();
    console.error(`[err] 403 unknown consumer "${consumer}" ip=${ip} model=${model || "-"}`);
    recordCall({ ts: Date.now(), ip, ua: req.headers["user-agent"] || "", method: req.method, path,
      reqModel: model || null, provider: "blocked", sentModel: null, keyLabel: "—", status: 403, ms: 0,
      error: "unknown_consumer", reqContent: extractRequestContent(bodyBuf), project });
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: {
      type: "unknown_consumer",
      message: `consumer "${consumer}" is not registered. Register it as a machine (belongs to a developer) or a project (deployed code), then use its API key.`,
      docs: `${DOCS_URL}#/identity`,
      how: "POST /api/consumers/keys {\"name\":\"<consumer>\",\"kind\":\"app\"} — issuing a key registers it in one call",
      registered: known,
    } }));
  }

  // Flow policy blocked this model (crazyrouter off / not allowlisted / unknown with no default route).
  if (route.blocked) {
    console.error(`[err] 400 blocked ip=${ip} model=${model || "-"} (${route.why})`);
    // Only log real inference attempts as blocked — not scanner GETs to /openapi.json, /favicon, etc.
    if (req.method === "POST" && bodyBuf.length)
      recordCall({ ts: Date.now(), ip, ua: req.headers["user-agent"] || "", method: req.method, path,
        reqModel: model || null, provider: "blocked", sentModel: null, keyLabel: "—", status: 400, ms: 0,
        error: `not routable: ${route.why}`, reqContent: extractRequestContent(bodyBuf), project });
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: `model '${model || ""}' is not routable: ${route.why}. Set a model override, crazyrouter allowlist entry, or default route in the panel.`, type: "invalid_request_error", code: "model_not_routable" } }));
  }

  // Per-project usage limits (rolling-window quota): warn → slow (throttle) → block (429).
  // Headers set here survive proxy/jsonEnforce writeHead (Node merges setHeader values).
  if (isInference && project) {
    const v = await usageVerdict(project);
    if (v) {
      const pctI = Math.round(v.pct * 100), capStr = v.lim.tokens > 0 ? `${v.lim.tokens.toLocaleString()} tok` : `${v.lim.calls.toLocaleString()} calls`;
      res.setHeader("x-usage-percent", String(pctI));
      res.setHeader("x-usage-window", v.lim.window);
      res.setHeader("x-usage-limit", capStr);
      if (v.action === "block") {
        console.warn(`[usage] BLOCK ${project} ${pctI}% of ${v.lim.window} cap (${capStr})`);
        shipError("usage limit block", { from: "usage", project, pct: pctI, window: v.lim.window, ip });
        recordCall({ ts: Date.now(), ip, ua: req.headers["user-agent"] || "", method: req.method, path, project,
          reqModel: model || null, provider: "blocked", sentModel: null, keyLabel: "—", status: 429, ms: 0,
          error: `usage_limit: ${pctI}% of ${v.lim.window} cap`, reqContent: extractRequestContent(bodyBuf) });
        res.writeHead(429, { "content-type": "application/json", "retry-after": "60",
          "x-usage-percent": String(pctI), "x-usage-window": v.lim.window, "x-usage-limit": capStr });
        return res.end(JSON.stringify({ error: { message: `project '${project}' has hit its ${v.lim.window} usage limit (${pctI}% of ${capStr}). Requests are blocked until usage rolls off the window, or raise the limit in the panel.`, type: "rate_limit_error", code: "usage_limit_exceeded" } }));
      }
      if (v.action === "warn" || v.action === "slow") res.setHeader("x-usage-warning", `${pctI}% of ${v.lim.window} limit`);
      if (v.action === "slow") {
        res.setHeader("x-usage-throttled-ms", String(v.lim.slowMs));
        console.warn(`[usage] SLOW ${project} ${pctI}% → +${v.lim.slowMs}ms`);
        await sleep(v.lim.slowMs);
      } else if (v.action === "warn") {
        console.warn(`[usage] WARN ${project} ${pctI}% of ${v.lim.window} cap`);
      }
    }
  }

  // Bearer gate for the uncensored local model(s).
  if (provider === "local" && isGated(route.target) && CFG.oblitToken) {
    const auth = String(req.headers["authorization"] || "");
    const xkey = String(req.headers["x-api-key"] || "");
    if (auth !== `Bearer ${CFG.oblitToken}` && xkey !== CFG.oblitToken) {
      console.error(`[err] 401 gated model unauthorized ip=${ip} model=${route.target}`);
      recordCall({ ts: Date.now(), ip, ua: req.headers["user-agent"] || "", method: req.method, path, project,
        reqModel: model || null, provider: "local", sentModel: route.target, keyLabel: "oblitToken", status: 401, ms: 0,
        error: "gate: missing/invalid token", reqContent: extractRequestContent(bodyBuf) });
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      return res.end(JSON.stringify({ error: { message: `model '${route.target}' requires Authorization: Bearer <token>`, type: "invalid_request_error", code: "unauthorized" } }));
    }
  }

  // Optional context compression (headroom sidecar). Off unless HEADROOM_URL is set; fast-fails to
  // the original body so it can never block or break inference. Runs before json-enforce/proxy so
  // both forward the compressed bytes.
  if (HEADROOM_URL && isInference) {
    const hc = await headroomCompress(bodyBuf, model, provider);
    bodyBuf = hc.buf;
    if (hc.stats && hc.stats.tokens_saved > 0)
      console.log(`[headroom] ${path} model=${model || "-"} provider=${provider} ${hc.stats.tokens_before}->${hc.stats.tokens_after} saved=${hc.stats.tokens_saved} (${Math.round(100 * hc.stats.tokens_saved / Math.max(1, hc.stats.tokens_before))}%)`);
  }

  // Max-account provider: the account is PINNED to the project, server-side (see accountFor).
  // No `X-Account` / `X-CCC-Account` / `X-Consumer` header is consulted — identity comes from the
  // project, the pin lives in the panel, and the client Bearer is overridden regardless. An unpinned
  // project is a configuration bug, so we say so loudly rather than silently billing someone.
  if (provider === "claudecode" && CFG.claudecodeAccountPool && CFG.claudecodeAccountPool.length) {
    const acct = accountFor(project);
    if (!acct) {
      const pins = CFG.projectAccounts || CFG.consumerAccounts || {};
      const known = Object.keys(pins).sort().join(", ") || "none";
      console.warn(`[account] REFUSED project="${project || "(none)"}" — no pin and no defaultAccount. pinned projects: ${known}`);
      // Log the refusal. A project that is being turned away spends nothing, so it would otherwise
      // leave no trace at all — and "why is promopilot getting nothing?" becomes unanswerable.
      recordCall({ ts: Date.now(), ip, ua: req.headers["user-agent"] || "", method: req.method, path, project,
        reqModel: model || null, provider: "blocked", sentModel: null, keyLabel: "—", status: 403, ms: 0,
        error: "no_account_for_project", reqContent: extractRequestContent(bodyBuf) });
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: {
        type: "no_account_for_project",
        message: `consumer "${project || "(none)"}" is not pinned to a Claude Max account, so there is no subscription to bill. The router never guesses whose plan to spend.`,
        docs: `${DOCS_URL}#/routing`,
        hint: "pin it in the panel (Accounts → pins), or POST /api/pins {project,account}",
        pinned_projects: Object.keys(pins).sort(),
      } }));
    }
    route.authToken = acct.token;
    route.account = acct.name;
  }

  // Terminal dispatch: json-enforce path (JSON response_format) or plain proxy.
  const dispatch = () => {
    if (CFG.jsonEnforce && req.method === "POST" && path.endsWith("/chat/completions") && bodyBuf.length) {
      let reqObj = null;
      try { reqObj = JSON.parse(bodyBuf.toString()); } catch { /* not JSON — passthrough */ }
      if (reqObj && wantsJsonFormat(reqObj)) {
        console.log(`[req] json-enforce model=${model || "-"} -> ${provider}`);
        return jsonEnforce(req, res, { ...route, model, provider, ip, bodyBuf, project });
      }
    }
    const translate = provider === "claudecode" && path.endsWith("/chat/completions");
    return proxy(req, res, route.base, { ...route, bodyBuf, model, provider, project, translate });
  };

  // No admission control: there is no subprocess to stampede. api.anthropic.com handles its own
  // concurrency, and its 429 is a real signal we surface rather than absorb.
  return dispatch();
});

server.listen(PORT, () => {
  console.log(
    `llm-gateway on :${PORT} | providers: local=${CFG.bases.local || "off"} claudecode=${CFG.bases.claudecode}`
    + ` (${(CFG.claudecodeAccountPool || []).length} accounts) crazyrouter=${CFG.bases.crazyrouter}`
    + ` | key=${CFG.crazyrouterKey ? "set" : "MISSING"} | claude models=${CFG.claudecodeModels.length} (seed)`
    + ` | ui=/`);
  // Reconcile the Claude catalog against Anthropic. Fire-and-forget: boot must not block on it,
  // and a failure leaves the seed in place rather than an empty list.
  refreshClaudecodeModels("boot").catch((e) => console.error(`[models] boot refresh: ${e.message}`));
  setInterval(() => refreshClaudecodeModels("interval").catch(() => {}), CLAUDECODE_MODEL_REFRESH_MS).unref();
  // Auto account selection orders on each account's weekly reset, but the passive harvest only
  // learns from accounts that serve traffic — with a single selected account, everyone else's
  // reading would freeze. Sweep the pool (one 1-token haiku ping each, serial) so reset7 stays
  // honest. Gated per tick, so flipping the strategy in the panel starts/stops it without a deploy.
  const sweepLimits = async () => { for (const a of CFG.claudecodeAccountPool || []) await refreshAccountLimits(a); };
  setTimeout(() => { if (CFG.accountStrategy === "soonest-weekly-reset") sweepLimits().catch(() => {}); }, 5000).unref();
  setInterval(() => { if (CFG.accountStrategy === "soonest-weekly-reset") sweepLimits().catch(() => {}); }, 30 * 60 * 1000).unref();
});
