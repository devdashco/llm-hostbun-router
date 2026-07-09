// llm.hostbun.cc — single-URL OpenAI router + admin UI.
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
//   /admin, /admin/api/*                       -> password-gated admin UI (edit routing/models/keys live)
//
// Routing is driven by a live, mutable CFG object. CFG is seeded from env defaults and then
// overlaid with /data/config.json (a Coolify-managed persistent volume) — so edits made in the
// admin UI take effect immediately AND survive restarts/reboots/redeploys. Nothing here needs a
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
//   src/claudecode.js  the Anthropic catalog and per-account probes
//   src/admin.js       the control-plane API behind the password cookie
//   src/telemetry.js   call-log row shaping + HyperDX error shipping
//   src/pricing.js     USD estimates (crazyrouter only; the rest are flat or free)
//   translate.js       OpenAI <-> Anthropic, pure functions, unit-tested
const http = require("node:http");

const { CFG, loadConfig, UI_ROUTES } = require("./src/config");
const { initDb, primeAcctCacheSoon, recordCall } = require("./src/db");
const { extractProject, parseConsumer, authenticate, consumerEntry, startKeyUseFlush } = require("./src/identity");
const { resolveRoute, accountFor, usageVerdict, sleep } = require("./src/routing");
const { readBody, sendFile, proxy } = require("./src/http");
const { mergedModels, refreshClaudecodeModels, CLAUDECODE_MODEL_REFRESH_MS } = require("./src/claudecode");
const { handleAdminApi } = require("./src/admin");
const { PRICES_FILE } = require("./src/pricing");

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
const ADMIN_FILE = process.env.ADMIN_FILE || "/srv/admin/index.html";

// Config first: every module below reads CFG, and the key index must exist before the first request.
loadConfig();
initDb();
primeAcctCacheSoon();
startKeyUseFlush();

// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || "").toLowerCase();
  const path = (req.url || "/").split("?")[0];

  // The control-plane UI (only on the main host, never docs.*).
  //
  // There is no /admin page any more — the site root IS the panel, and the whole of it sits behind
  // the password (the SPA renders <Login/> until /api/state stops 401'ing). /admin* survives only
  // as a 308 to /, so old bookmarks and the deploy's health check don't 404.
  //
  // The JSON API keeps its /admin/api/* prefix on purpose: claudectl's proxy_* tools hardcode those
  // paths (see claudectl/server/claudectl_server.py). /api/* is the new alias; both hit the same
  // handler, so the rename can happen on claudectl's schedule, not ours.
  if (!host.startsWith("docs.")) {
    if (path.startsWith("/admin/api/")) return handleAdminApi(req, res, path, "/admin/api/");
    if (path.startsWith("/api/") && !path.startsWith("/api/v1/") && path !== "/api/pricing")
      return handleAdminApi(req, res, path, "/api/");
    if (path === "/admin" || path.startsWith("/admin/")) {
      res.writeHead(308, { location: "/" });
      return res.end();
    }
    // The SPA pushes /calls, /accounts, … so those must serve the shell on a hard refresh.
    // Enumerated, never a catch-all: a catch-all at the root would shadow /v1/*, /local/*, and
    // every future inference path, turning a routing bug into "the model endpoint returns HTML".
    if (req.method === "GET" && (path === "/" || UI_ROUTES.has(path.replace(/\/$/, ""))))
      return sendFile(res, ADMIN_FILE, "text/html; charset=utf-8", false);
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
  const keyFail = (why) => {
    console.error(`[err] 401 ${why} ip=${ip} model=${model || "-"}`);
    recordCall({ ts: Date.now(), ip, ua: req.headers["user-agent"] || "", method: req.method, path,
      reqModel: model || null, provider: "blocked", sentModel: null, keyLabel: "—", status: 401, ms: 0,
      error: why, reqContent: extractRequestContent(bodyBuf), project: null });
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer realm="llm.hostbun.cc"` });
    return res.end(JSON.stringify({ error: {
      type: "invalid_api_key", code: "invalid_api_key", message: why,
      hint: "send `Authorization: Bearer sk-llm-…` (or `x-api-key`). Issue one in /admin → Consumers.",
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
    return res.end(JSON.stringify({ error: { message: "missing project attribution: send an 'X-Project' header (or a 'project' body field) identifying the calling app.", type: "invalid_request_error", code: "project_required" } }));
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
      message: `consumer "${consumer}" is not registered`,
      hint: "register it in /admin (Consumers), as kind 'dev' (a person's machine) or 'app' (deployed code)",
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
    return res.end(JSON.stringify({ error: { message: `model '${model || ""}' is not routable: ${route.why}. Set a model override, crazyrouter allowlist entry, or default route in /admin.`, type: "invalid_request_error", code: "model_not_routable" } }));
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
        return res.end(JSON.stringify({ error: { message: `project '${project}' has hit its ${v.lim.window} usage limit (${pctI}% of ${capStr}). Requests are blocked until usage rolls off the window, or raise the limit in /admin.`, type: "rate_limit_error", code: "usage_limit_exceeded" } }));
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
  // project, the pin lives in /admin, and the client Bearer is overridden regardless. An unpinned
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
        message: `project "${project || "(none)"}" is not pinned to a Claude Code account`,
        hint: "pin it in /admin (projectAccounts), or set defaultAccount",
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
});
