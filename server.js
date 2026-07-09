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
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const url = require("url");
const { Readable } = require("stream");
const TR = require("./translate");   // OpenAI <-> Anthropic

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
// Every model `GET api.anthropic.com/v1/models` returned on 2026-07-09, oldest last.
// This is a FLOOR, not the source of truth: refreshClaudecodeModels() overwrites CFG from the
// live Anthropic catalog at boot and every 6h, so a new id ships without a deploy. The seed is
// what keeps /v1/models from advertising NOTHING when config.json is empty (the old default) or
// Anthropic is unreachable at boot — which is how the catalog silently lost four ids.
const CLAUDECODE_MODEL_SEED = Object.freeze([
  "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6",
  "claude-opus-4-6", "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929",
]);
// Undated aliases that Anthropic SERVES but does not LIST. `claude-haiku-4-5` is the id bluebut and
// every other caller actually sends, and until now /v1/models never mentioned it — a client that
// enumerated our catalog could not find the one model that works. Requests route on the `claude`
// prefix, not on this list, so they always worked; they were just invisible.
//
// Verified one id at a time against api.anthropic.com (2026-07-09), NOT derived by stripping the
// date: `claude-opus-4-1` 404s while `claude-opus-4-1-20250805` serves, and `claude-opus-4-8-20260528`
// 404s while the undated `claude-opus-4-8` serves. The mapping is not mechanical. Re-verify with
// POST /admin/api/claudecode/probe before adding one — a 404 here advertises a model that does not exist.
const CLAUDECODE_MODEL_ALIASES = Object.freeze([
  "claude-haiku-4-5",    // 200 on a live account
  "claude-sonnet-4-5",   // 429 = exists, quota-dry
  "claude-opus-4-5",     // 429 = exists, quota-dry
]);
const CLAUDECODE_MODEL_REFRESH_MS = 6 * 3600 * 1000;
// Client-side routes of the control panel (its NAV slugs). Kept in sync with admin/index.html by
// hand — a missing entry only costs a hard-refresh 404 on that tab, never a mis-served API path.
const UI_ROUTES = new Set(["/overview", "/calls", "/consumers", "/stats", "/accounts", "/routing",
  "/models", "/crazyrouter", "/secrets"].map((s) => s));
const PRICES_FILE = process.env.PRICES_FILE || "/srv/prices.json";
const CONFIG_FILE = process.env.CONFIG_FILE || "/data/config.json";
// API-key lookup: key id -> {consumer, rec}. Declared here, far from reindexKeys()/authenticate()
// below, because loadConfig() reindexes at module scope — a `let` beside those functions would still
// be in its temporal dead zone when that first call runs, and the process dies on boot.
let KEY_INDEX = new Map();
// Call log lives in the `llmrouter` Postgres, NOT on the container's volume. Unset ⇒ logging off;
// the router still proxies. Set in Coolify env, never in git — it carries the DB password.
const DATABASE_URL = process.env.DATABASE_URL || "";
// Max bytes of prompt / reply text stored per call (protects the DB from huge payloads).
const CONTENT_CAP = parseInt(process.env.CALL_CONTENT_CAP || "0", 10); // 0 = uncapped (store full prompt+reply)

// Default local model ids (env-overridable). "local" -> small multimodal E4B; "gemma" -> 26B MoE;
// "obliterated" -> Qwen3.6-27B abliterated.
const CANON = process.env.LOCAL_MODEL || "google/gemma-4-26b-a4b";
const OBLIT = process.env.LOCAL_MODEL_2 || "qwen3.6-27b-obliterated";
const E4B = process.env.LOCAL_MODEL_3 || "gemma-4-e4b-it-obliterated";

// ── error → HyperDX (OTLP logs, service.name=llm.hostbun.cc). Auth header has NO "Bearer". ──
const HDX_KEY = process.env.HYPERDX_INGEST_API_KEY || "";
const HDX_URL = process.env.HYPERDX_OTLP_URL || "https://otel.hyperdx.hostbun.cc/v1/logs";

// ── optional context compression via the headroom-compress sidecar. OFF unless HEADROOM_URL is
// set. Every call fast-fails to the original body (timeout / non-200 / parse error) so the
// compressor can never block or break inference. ──
const HEADROOM_URL = (process.env.HEADROOM_URL || "").replace(/\/$/, "");
const HEADROOM_TOKEN = process.env.HEADROOM_TOKEN || ""; // bearer for the compress sidecar (if gated)
const HEADROOM_TIMEOUT_MS = parseInt(process.env.HEADROOM_TIMEOUT_MS || "4000", 10);
const HEADROOM_MIN_CHARS = parseInt(process.env.HEADROOM_MIN_CHARS || "2000", 10); // skip small bodies
// Compression NEVER applies to claudecode: it rewrites the prompt, which misses the prompt cache
// (a cache read is ~10x cheaper than a fresh input token). Compressing to save tokens there costs
// more than it saves. Hard-coded out of the default; adding it back via env is a mistake.
const HEADROOM_PROVIDERS = new Set(
  (process.env.HEADROOM_PROVIDERS || "local,crazyrouter").split(",").map((s) => s.trim()).filter(Boolean)
);

// ─────────────────────────────────────────────────────────────────────────────
// Providers. Where a request is actually served. There are three, and that's the whole taxonomy.
// ─────────────────────────────────────────────────────────────────────────────
//   local        pbox llama.cpp. Speaks OpenAI natively.
//   claudecode   the claudecode-account-pool (our Claude Max logins) → api.anthropic.com.
//                Native /v1/messages is forwarded verbatim; OpenAI /v1/chat/completions is
//                translated (translate.js). The account is PINNED per project — never rotated.
//   crazyrouter  cloud relay (gemini etc). Opt-in by model id. Never an automatic fallback.
//
// `provider` is the field name. `lane` was the old word for the same thing and is still accepted
// on input so existing /data/config.json keeps working.
const PROVIDERS = ["local", "crazyrouter", "claudecode"];
// The image provider is deliberately absent from PROVIDERS: it is not a routing target. It is picked
// by path (`/v1/images/*`), it speaks its own shape, and it bills GPU seconds rather than tokens.
const IMAGE_MODEL_ID = "imagegen";
const PROVIDER_SET = new Set(PROVIDERS);
// Legacy ids → canonical. The retired wrapper's id and `anthropic` named one thing:
// "serve this from a Claude Max subscription". They collapse into `claudecode`.
const LEGACY_PROVIDER = { cloud: "crazyrouter", claude: "claudecode", wrappy: "claudecode", anthropic: "claudecode" };
// Normalize any provider id (legacy or canonical); returns "" if unrecognized.
function normProvider(l) {
  const s = String(l || "").trim().toLowerCase();
  const c = LEGACY_PROVIDER[s] || s;
  return PROVIDER_SET.has(c) ? c : "";
}
// A saved route is `{provider, model}` today and `{lane, model}` in every config.json written before
// the rename. Read both — dropping the legacy key silently empties modelRoutes/projectRoutes on boot.
const providerOf = (v) => normProvider(v && (v.provider || v.lane));

const LIMIT_WINDOWS = ["1h", "6h", "24h", "7d", "30d"];
const WINDOW_MS = { "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
// Sanitize a usage-limit object from untrusted config. Returns a normalized limit or null.
function sanitizeLimit(v) {
  if (!v || typeof v !== "object") return null;
  const num = (x, d) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? n : d; };
  const clampPct = (x, d) => Math.max(0, Math.min(100, num(x, d)));
  return {
    window: LIMIT_WINDOWS.includes(v.window) ? v.window : "24h",
    tokens: Math.round(num(v.tokens, 0)),
    calls: Math.round(num(v.calls, 0)),
    warnPct: clampPct(v.warnPct, 80),
    slowPct: clampPct(v.slowPct, 95),
    slowMs: Math.min(60000, Math.round(num(v.slowMs, 1500))),
    hard: ["block", "slow", "warn"].includes(v.hard) ? v.hard : "block",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live config: env defaults, then /data/config.json overlay.
// ─────────────────────────────────────────────────────────────────────────────
function envDefaults() {
  return {
    bases: {
      // local llama.cpp provider on the pbox GPU. The live base is supplied by config.json in prod
      // (the old hosted backend is gone) — default empty so a bare deploy points at nothing.
      local: (process.env.LOCAL_BASE || "").replace(/\/$/, ""),
      crazyrouter: (process.env.CRAZYROUTER_BASE || process.env.CRAZY_BASE || "https://crazyrouter.com").replace(/\/$/, ""),
      // claudecode → the real Anthropic API, called with a pinned account's Max token. The old
      // old subprocess-wrapper base is GONE.
      claudecode: (process.env.ANTHROPIC_BASE || "https://api.anthropic.com").replace(/\/$/, ""),
      // image generation provider (SD-Turbo on the pbox GPU). Routed by path, not model name.
      images: (process.env.IMAGE_BASE || "https://sdturbo.bofrid.dev").replace(/\/$/, ""),
    },
    crazyrouterKey: process.env.CRAZYROUTER_KEY || "",
    // claudecodeAccountPool: our Claude Max logins, [{name, org, token}] with token = sk-ant-oat…
    // (setup-tokens, ~1yr, no refresh). A project is PINNED to one of these (projectAccounts); the
    // gateway never rotates between them. Seed via ANTHROPIC_POOL env or the admin config; tokens
    // are masked in adminState. `anthropicPool` is the old name and is still read.
    claudecodeAccountPool: (() => { try { return JSON.parse(process.env.ANTHROPIC_POOL || "[]"); } catch { return []; } })(),
    // bearer injected toward the image upstream (SD-Turbo API_TOKEN). Empty = send nothing.
    imageToken: process.env.IMAGE_TOKEN || "",
    // models starting with this prefix (lowercased) are served by the claudecode provider.
    claudePrefix: process.env.CLAUDE_PREFIX || process.env.WRAPPY_PREFIX || "claude",
    // claudecodeModels: the ids /v1/models advertises for the claudecode provider. Anthropic ships
    // new ids without asking us, so this self-heals from their catalog (refreshClaudecodeModels).
    // Seeded rather than empty: an empty list advertises no Claude at all, and nothing complains.
    claudecodeModels: (() => {
      const env = (process.env.CLAUDECODE_MODELS || "").split(",").map((x) => x.trim()).filter(Boolean);
      return env.length ? env : [...CLAUDECODE_MODEL_SEED, ...CLAUDECODE_MODEL_ALIASES];
    })(),
    // Bearer gate for the uncensored model(s). When oblitToken is set, requests routed to a model
    // id listed in gatedModels require Authorization: Bearer <oblitToken> (or x-api-key). Empty
    // token = open. gemma + crazyrouter stay open so fb-bot/promopilot are unaffected.
    oblitToken: process.env.OBLIT_TOKEN || "",
    gatedModels: [OBLIT],
    // localMap: alias -> local-model-id (resolves the local provider). The old hosted backend is
    // gone; the env seed ships this EMPTY (local provider off by default) and the legacy ids
    // ("local"/"gemma"/"obliterated"/...) fall through to claudecode via modelRoutes below. Production
    // re-enables the provider via config.json — it points bases.local at the live llama.cpp server on
    // the pbox GPU and maps e.g. "local"/"qwen3.5-9b" -> qwen3.5-9b there.
    localMap: {},
    // ── flow control (admin-editable) ──
    // forceModel: when enabled, EVERY request is rewritten to this provider+model regardless of what
    // the caller asked for. The big red switch.
    forceModel: { enabled: false, provider: "claudecode", model: "" },
    // modelRoutes: explicit per-incoming-model overrides to ANY provider (highest priority after
    // forceModel). key = incoming model name (lowercased). value = { provider, model }.
    // The legacy local model ids are redirected here to claudecode (claude-sonnet-4-6 is multimodal),
    // so requests that still ask for "local"/"gemma"/"obliterated" — including image analysis —
    // are served by Claude instead of the retired hosted backend.
    modelRoutes: Object.fromEntries(
      ["local", "gemma", "gemma-4-e4b-it-obliterated", "google/gemma-4-26b-a4b",
       "obliterated", "obliteratus", "qwen3.6-27b-obliterated"]
        .map((id) => [id, { provider: "claudecode", model: "claude-sonnet-4-6" }])
    ),
    // projectRoutes: per-PROJECT overrides to ANY provider (highest priority of all — beats forceModel
    // and modelRoutes). Lets you steer a single app (e.g. promopilot) off gemini onto claudecode without
    // touching anyone else. key = project name (lowercased). value = { provider, model } (model "" = keep
    // the caller's model id, just switch provider) — OR { block: true } to reject every call from that
    // project so it consumes zero tokens.
    projectRoutes: {},
    // projectAccounts: the server-side PIN, project → Max account name. This is the ONLY way an
    // account is chosen (see accountFor). No headers, no sticky, no rotation. Edit live in /admin.
    // A project with no pin (and no defaultAccount) is REFUSED with 403 rather than billed to a
    // guess. `consumerAccounts` is the old name, still read for back-compat.
    projectAccounts: {},
    consumerAccounts: {},
    // defaultAccount: the one named account unpinned projects fall back to. "" = refuse instead.
    // Explicit by design — an empty default means a misconfigured caller fails loudly, not silently.
    defaultAccount: process.env.DEFAULT_ACCOUNT || "",
    // projectGroups: bundle many projects (e.g. all seoul:* providers) under one rule. Each entry is
    // { name, prefixes:[...], provider?, model?, block? }. A project matches when its slug equals or
    // starts with any prefix (so "seoul:" catches seoul:probe, seoul:l1_metadata, …). block:true
    // rejects all matching calls (zero tokens); otherwise provider/model reroute them. An exact
    // projectRoutes entry always wins over a group (lets you exempt one project from a group block).
    projectGroups: [],
    // ── per-project usage limits (rolling-window quotas) ──
    // projectLimits[<project>] = { window, tokens, calls, warnPct, slowPct, slowMs, hard }
    //   window  rolling count window: 1h|6h|24h|7d|30d (default 24h)
    //   tokens  token cap in window (0 = no token cap)   calls  call cap (0 = none)
    //   warnPct ≥this% of cap → warn (X-Usage-Warning header + log)   default 80
    //   slowPct ≥this% → throttle: sleep slowMs before forwarding      default 95
    //   slowMs  delay added per request while throttling (ms)          default 1500
    //   hard    at ≥100%: "block" (429) | "slow" (keep throttling) | "warn" (never block)
    // An exact projectLimits entry is authoritative (even all-zero = exempt). Else a matching
    // group's .limit, else projectLimitDefault (applied to every attributed project when its
    // tokens/calls > 0). Usage is summed from the call log over the window; nothing persisted.
    projectLimits: {},
    projectLimitDefault: { window: "24h", tokens: 0, calls: 0, warnPct: 80, slowPct: 95, slowMs: 1500, hard: "block" },
    // cloudPolicy governs models that fall through to the crazyrouter provider:
    //   "open"      → forward anything (legacy behaviour)
    //   "allowlist" → only ids in cloudAllowlist reach crazyrouter; everything else → defaultRoute
    //   "off"       → nothing reaches crazyrouter; everything → defaultRoute
    cloudPolicy: "open",
    cloudAllowlist: [],
    // defaultRoute: where unknown / empty / crazyrouter-blocked models go. provider "none" = reject 400.
    defaultRoute: { provider: "none", model: "" },
    // JSON-output enforcement for chat completions that set response_format json_object/json_schema.
    jsonEnforce: (process.env.JSON_ENFORCE || "1") !== "0",
    jsonMaxRetries: parseInt(process.env.JSON_MAX_RETRIES || "2", 10),
    // Project attribution. When requireProject is on, inference calls must declare a project via the
    // X-Project header (or body project/metadata.project/user) or they're rejected 400. Off = the
    // project is still recorded when supplied, just not mandatory.
    requireProject: (process.env.REQUIRE_PROJECT || "1") === "1",
    // The consumer registry. A consumer is WHO is calling, and there are exactly two kinds:
    //   dev — a developer's machine, or a daemon on it (Claude Code, autofix). Has an `owner`: a person.
    //   app — code we deployed. Has NO owner; it is not a person, and pretending it is muddies the bill.
    // Identity is a path: `<consumer>[:<job>]`. `promopilot:generatetext` is consumer promopilot,
    // job generatetext. Only the CONSUMER is registered — jobs are free, so a new workload needs no
    // config change. That is what keeps this sustainable.
    //   consumers[name] = { kind, owner?, note?, keys: [{id, hash, created, lastUsed, revoked}] }
    consumers: {},
    // When on, an inference call whose consumer is not in the registry is refused 403. Ships OFF so
    // that merely deploying this code cannot black out an unregistered caller; turn it on once the
    // registry is seeded. `requireProject` only checks a name was SUPPLIED — this checks it is a name
    // we agreed on. Neither is authentication: the name is still self-asserted.
    requireRegisteredConsumer: (process.env.REQUIRE_REGISTERED_CONSUMER || "0") === "1",
    // API-key auth. THIS is what makes a name mean something, and it is ONE artifact instead of two:
    // the key is the identity AND the credential, carried in the field every OpenAI client already
    // sends. Issuing a key IS registering the consumer — there is no separate "register" step.
    //   off      — keys ignored; the self-asserted X-Project header is the only identity.
    //   optional — a valid key wins and is trusted; no key falls back to X-Project. Migration mode.
    //   required — no valid key, no service (401). A self-asserted header stops being an identity.
    // Ships "optional": going straight to "required" would 401 every caller not yet handed a key.
    auth: { mode: process.env.AUTH_MODE || "optional" },
    // Admin password (HMAC secret + login check). Weak default per request — rotate via the UI.
    adminPassword: process.env.ADMIN_PASSWORD || "ddash",
    // Call logging → the `llmrouter` Postgres (DATABASE_URL). enabled: record any call metadata at all;
    // content: also store the prompt + the model's reply text (uncapped unless CONTENT_CAP > 0);
    // retain: keep at most this many rows (oldest pruned). 0 = keep every row forever, no pruning.
    logging: {
      enabled: (process.env.LOG_CALLS || "1") !== "0",
      content: (process.env.LOG_CONTENT || "1") !== "0",
      retain: parseInt(process.env.LOG_RETAIN || "0", 10),
    },
  };
}

let CFG = envDefaults();

// Merge a saved overlay (from disk / admin POST) over a base, key by key, validating shapes.
// Accepts both new keys (crazyrouter/claudecode/...) and legacy keys (crazy/claude/crazyKey/
// claudePrefix) so older config files migrate transparently.
function mergeConfig(base, saved) {
  const c = JSON.parse(JSON.stringify(base));
  if (!saved || typeof saved !== "object") return c;
  if (saved.bases && typeof saved.bases === "object") {
    const b = saved.bases;
    const pick = (...keys) => { for (const k of keys) if (typeof b[k] === "string" && b[k].trim()) return b[k].trim().replace(/\/$/, ""); return null; };
    const loc = pick("local"); if (loc) c.bases.local = loc;
    const cr = pick("crazyrouter", "crazy"); if (cr) c.bases.crazyrouter = cr;
    const an = pick("claudecode", "anthropic"); if (an) c.bases.claudecode = an;
  }
  if (saved.localMap && typeof saved.localMap === "object" && !Array.isArray(saved.localMap)) {
    const m = {};
    for (const [k, v] of Object.entries(saved.localMap)) {
      if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim())
        m[k.trim().toLowerCase()] = v.trim();
    }
    c.localMap = m; // allow an explicit empty map to fully disable the local provider
  }
  if (Array.isArray(saved.gatedModels))
    c.gatedModels = saved.gatedModels.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  // Secrets / scalars, with legacy aliases.
  if (typeof saved.crazyrouterKey === "string") c.crazyrouterKey = saved.crazyrouterKey;
  else if (typeof saved.crazyKey === "string") c.crazyrouterKey = saved.crazyKey;
  // The account pool. `claudecodeAccountPool` is the name; `anthropicPool` is what the live
  // /data/config.json still calls it. Read either, keep both in sync so a rollback still boots.
  {
    const raw = Array.isArray(saved.claudecodeAccountPool) ? saved.claudecodeAccountPool
      : Array.isArray(saved.anthropicPool) ? saved.anthropicPool : null;
    if (raw) {
      c.claudecodeAccountPool = raw
        .filter((a) => a && typeof a.token === "string" && a.token.trim())
        .map((a) => ({ name: String(a.name || "acct").trim(), org: String(a.org || "").trim(), token: a.token.trim() }));
    }
  }
  // UNION, not replace. The live /data/config.json predates four of these ids, and a plain
  // overwrite would silently un-advertise them on every boot — the exact way the catalog drifted
  // to five. The seed is a floor; refreshClaudecodeModels() then reconciles against Anthropic.
  if (Array.isArray(saved.claudecodeModels)) {
    const savedIds = saved.claudecodeModels.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
    c.claudecodeModels = [...new Set([...savedIds, ...CLAUDECODE_MODEL_SEED, ...CLAUDECODE_MODEL_ALIASES])];
  }
  if (typeof saved.claudePrefix === "string") c.claudePrefix = saved.claudePrefix;
  else if (typeof saved.wrappyPrefix === "string") c.claudePrefix = saved.wrappyPrefix;
  for (const k of ["oblitToken", "adminPassword"])
    if (typeof saved[k] === "string") c[k] = saved[k];
  if (typeof saved.jsonEnforce === "boolean") c.jsonEnforce = saved.jsonEnforce;
  if (Number.isInteger(saved.jsonMaxRetries) && saved.jsonMaxRetries >= 0 && saved.jsonMaxRetries <= 5)
    c.jsonMaxRetries = saved.jsonMaxRetries;
  if (typeof saved.requireProject === "boolean") c.requireProject = saved.requireProject;
  if (typeof saved.requireRegisteredConsumer === "boolean") c.requireRegisteredConsumer = saved.requireRegisteredConsumer;
  if (saved.auth && typeof saved.auth === "object" && ["off", "optional", "required"].includes(saved.auth.mode))
    c.auth = { mode: saved.auth.mode };
  if (saved.consumers && typeof saved.consumers === "object" && !Array.isArray(saved.consumers)) {
    c.consumers = {};
    for (const [k, v] of Object.entries(saved.consumers)) {
      const name = String(k || "").trim().toLowerCase();
      if (!name || !v || typeof v !== "object") continue;
      const kind = v.kind === "dev" ? "dev" : "app";
      const e = { kind };
      // owner is a person, and only a dev has one. An app is not a person; giving it an owner is how
      // "what do my developers cost" quietly starts including cron jobs.
      if (kind === "dev" && typeof v.owner === "string" && v.owner.trim()) e.owner = v.owner.trim().toLowerCase();
      if (typeof v.note === "string" && v.note.trim()) e.note = v.note.trim();
      // Only the hash is ever stored. A `keys` entry without one is not a key, it is a way to lock
      // yourself out of a consumer while believing it is authenticated — drop it.
      e.keys = Array.isArray(v.keys) ? v.keys.filter((x) => x && typeof x.id === "string" && typeof x.hash === "string")
        .map((x) => ({ id: x.id, hash: x.hash, created: Number(x.created) || 0,
          lastUsed: Number(x.lastUsed) || 0, revoked: !!x.revoked, note: x.note || undefined })) : [];
      c.consumers[name] = e;
    }
  }
  // ── flow control ──
  if (saved.forceModel && typeof saved.forceModel === "object") {
    const f = saved.forceModel;
    c.forceModel = {
      enabled: !!f.enabled,
      provider: providerOf(f) || "claudecode",
      model: typeof f.model === "string" ? f.model.trim() : "",
    };
  }
  // The old wrapper-fallback block is intentionally NOT read any more. Silent cross-provider
  // failover is gone: a failure is reported, never papered over with a different model.
  if (saved.modelRoutes && typeof saved.modelRoutes === "object" && !Array.isArray(saved.modelRoutes)) {
    const mr = {};
    for (const [k, v] of Object.entries(saved.modelRoutes)) {
      const provider = v && typeof v === "object" ? providerOf(v) : "";
      if (typeof k === "string" && k.trim() && provider)
        mr[k.trim().toLowerCase()] = { provider, model: typeof v.model === "string" ? v.model.trim() : "" };
    }
    c.modelRoutes = mr;
  }
  if (saved.projectRoutes && typeof saved.projectRoutes === "object" && !Array.isArray(saved.projectRoutes)) {
    const pr = {};
    for (const [k, v] of Object.entries(saved.projectRoutes)) {
      if (typeof k !== "string" || !k.trim() || !v || typeof v !== "object") continue;
      if (v.block) { pr[k.trim().toLowerCase()] = { block: true }; continue; }
      const provider = providerOf(v);
      if (provider) pr[k.trim().toLowerCase()] = { provider, model: typeof v.model === "string" ? v.model.trim() : "" };
    }
    c.projectRoutes = pr;
  }
  // The account pin. `projectAccounts` is the name; `consumerAccounts` is its predecessor and is
  // migrated in (new name wins on conflict). Both land in c.projectAccounts so accountFor sees one map.
  {
    const pins = {};
    for (const src of [saved.consumerAccounts, saved.projectAccounts]) {
      if (!src || typeof src !== "object" || Array.isArray(src)) continue;
      for (const [k, v] of Object.entries(src)) {
        if (typeof k === "string" && k.trim() && typeof v === "string" && v.trim())
          pins[k.trim().toLowerCase()] = v.trim();
      }
    }
    if (Object.keys(pins).length) { c.projectAccounts = pins; c.consumerAccounts = pins; }
  }
  if (typeof saved.defaultAccount === "string") c.defaultAccount = saved.defaultAccount.trim();
  if (Array.isArray(saved.projectGroups)) {
    const pg = [];
    const seen = new Set();
    for (const g of saved.projectGroups) {
      if (!g || typeof g !== "object") continue;
      const name = typeof g.name === "string" ? g.name.trim() : "";
      const prefixes = Array.isArray(g.prefixes)
        ? [...new Set(g.prefixes.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().toLowerCase()))]
        : [];
      const nkey = name.toLowerCase();
      if (!name || !prefixes.length || seen.has(nkey)) continue;
      seen.add(nkey);
      const limit = sanitizeLimit(g.limit);
      if (g.block) { pg.push({ name, prefixes, block: true, ...(limit ? { limit } : {}) }); continue; }
      const provider = providerOf(g);
      if (provider || limit) pg.push({ name, prefixes, ...(provider ? { provider, model: typeof g.model === "string" ? g.model.trim() : "" } : {}), ...(limit ? { limit } : {}) });
    }
    c.projectGroups = pg;
  }
  if (saved.projectLimits && typeof saved.projectLimits === "object" && !Array.isArray(saved.projectLimits)) {
    const pl = {};
    for (const [k, v] of Object.entries(saved.projectLimits)) {
      if (typeof k !== "string" || !k.trim()) continue;
      const lim = sanitizeLimit(v);
      if (lim) pl[k.trim().toLowerCase()] = lim;
    }
    c.projectLimits = pl;
  }
  if (saved.projectLimitDefault && typeof saved.projectLimitDefault === "object") {
    const d = sanitizeLimit(saved.projectLimitDefault);
    if (d) c.projectLimitDefault = d;
  }
  if (["open", "allowlist", "off"].includes(saved.cloudPolicy)) c.cloudPolicy = saved.cloudPolicy;
  if (Array.isArray(saved.cloudAllowlist))
    c.cloudAllowlist = saved.cloudAllowlist.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  if (saved.defaultRoute && typeof saved.defaultRoute === "object") {
    const d = saved.defaultRoute;
    const dRaw = String((d.provider || d.lane) || "").toLowerCase();
    const dl = dRaw === "none" ? "none" : providerOf(d);
    c.defaultRoute = {
      provider: dl || "none",
      model: typeof d.model === "string" ? d.model.trim() : "",
    };
  }
  if (saved.logging && typeof saved.logging === "object") {
    const l = saved.logging;
    if (typeof l.enabled === "boolean") c.logging.enabled = l.enabled;
    if (typeof l.content === "boolean") c.logging.content = l.content;
    if (Number.isInteger(l.retain) && (l.retain === 0 || (l.retain >= 100 && l.retain <= 1000000))) c.logging.retain = l.retain;
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
    // Every write is a potential key change (issue, revoke, delete a consumer). Rebuilding the index
    // here means no caller has to remember to, and a stale index can never authenticate a dead key.
    reindexKeys();
    return true;
  } catch (e) {
    console.error(`[cfg] persist failed: ${e.message}`);
    return false;
  }
}

loadConfig();
reindexKeys();   // loadConfig() replaces CFG wholesale, so the key index must be rebuilt after it

// ── pricing (for usage cost estimates in the admin stats view) ──────────────
// PRICES_FILE is the crazyrouter pricing snapshot ({models:[{model,input_per_1m,
// output_per_1m}]}). Cached + mtime-invalidated. Returns { id -> {in,out} } in
// USD per 1M tokens. Only crazyrouter ids are priced; claudecode (Max subscription, flat
// subscription) and local providers have no metered cost → treated as $0.
let _priceCache = { mtime: 0, map: {} };
function priceMap() {
  try {
    const st = fs.statSync(PRICES_FILE);
    if (st.mtimeMs !== _priceCache.mtime) {
      const j = JSON.parse(fs.readFileSync(PRICES_FILE, "utf8"));
      const map = {};
      for (const m of (j.models || [])) if (m && m.model && m.type === "token")
        map[m.model] = { in: +m.input_per_1m || 0, out: +m.output_per_1m || 0 };
      _priceCache = { mtime: st.mtimeMs, map };
    }
  } catch { /* no prices file → empty map, everything reads as $0 */ }
  return _priceCache.map;
}
// Cost in USD for one (sentModel, provider, ptok, ctok) aggregate. claudecode/local = flat → 0.
function costUsd(prices, sentModel, provider, ptok, ctok) {
  // Allowlist, not denylist. crazyrouter is the ONLY metered provider, so it is the only one that can
  // cost anything. Naming the free providers instead meant a NULL or legacy provider value fell
  // through and got priced from the crazyrouter feed — a Claude model id matches that feed, so rows
  // written on a Max subscription reported real dollars. Unknown provider ⇒ $0, never a guess.
  if (provider !== "crazyrouter") return 0;   // Max subscription / local GPU / unknown = no metered cost
  const p = prices[sentModel]; if (!p) return 0;
  return (ptok || 0) / 1e6 * p.in + (ctok || 0) / 1e6 * p.out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Call log → Postgres (`llmrouter` DB on the pbox cluster; DATABASE_URL).
// One row per request that reaches a provider, refusals included.
//
// It used to be a SQLite file on the container's volume. That volume has no backup and dies with
// the app, and a rolling deploy put two containers on the same file — which is how logging silently
// disabled itself for a whole container lifetime. The log now lives in a real project database.
//
// `pg` is the router's ONLY dependency. Every DB call here is wrapped or fire-and-forget: losing the
// call log must never break proxying, which is the one job this process actually has.
// ─────────────────────────────────────────────────────────────────────────────
const { Pool, types: pgTypes } = require("pg");
// pg returns BIGINT (oid 20) as a STRING, because a 64-bit int can exceed Number.MAX_SAFE_INTEGER.
// Every bigint here is an epoch-ms timestamp, a row id, or a token count — all far inside that
// range. Left as strings they break `ts` arithmetic, JSON shapes the admin UI expects, and any
// SUM(). Parse them as numbers once, globally, instead of converting at 30 call sites.
pgTypes.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8
pgTypes.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric (SUM of ints)
let pool = null, insertsSincePrune = 0;
const dbUp = () => !!pool;

function initDb() {
  if (!DATABASE_URL) {
    console.error("[log] DATABASE_URL not set; call logging disabled");
    return;
  }
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    // The router is on hostbun and the DB is on pbox, so every query crosses the public internet.
    // A hung socket must not wedge a request handler.
    statement_timeout: 20_000,
    query_timeout: 20_000,
  });
  // A pool error (upstream restart, network blip) is emitted on the pool, not the query. Without a
  // listener Node treats it as an unhandled 'error' event and kills the process — taking the router
  // down because its *logging* backend hiccuped.
  pool.on("error", (e) => console.error(`[log] pg pool error: ${e.message}`));
  console.log(`[log] call DB → postgres ${DATABASE_URL.replace(/\/\/[^@]*@/, "//***@")}`);
  // acct_limits is keyed by Anthropic org-id, which is opaque — nothing in the row said WHICH of our
  // logins it belongs to, so the panel could only ever show accounts that had recently answered.
  // The table already exists in prod, so a CREATE TABLE IF NOT EXISTS would no-op here: it has to
  // be an explicit ADD COLUMN. Fire-and-forget, like every other write.
  dbWrite("ALTER TABLE acct_limits ADD COLUMN IF NOT EXISTS account TEXT", []);
}
initDb();

// Fire-and-forget write. Never awaited on the hot path: an inference request must not wait on, or
// fail because of, a cross-internet INSERT.
function dbWrite(sql, params) {
  if (!pool) return;
  pool.query(sql, params).catch((e) => console.warn(`[log] write failed: ${e.message}`));
}
// Awaited read, used by the admin API. Returns [] rather than throwing so one bad panel can't 500
// the whole dashboard.
async function dbRows(sql, params = []) {
  if (!pool) return [];
  try { return (await pool.query(sql, params)).rows; }
  catch (e) { console.warn(`[log] query failed: ${e.message}`); return []; }
}
const dbRow = async (sql, params = []) => (await dbRows(sql, params))[0] || null;

// Latest rate-limit snapshot per Anthropic org, held in memory so acctHealth() can stay synchronous.
// recordLimits() refreshes it on every call that carries the headers; this primes it once at boot so
// a freshly restarted container still shows real headroom before the first Anthropic response lands.
const ACCT_CACHE = new Map();
// Distinct-value lists for the call-log filter dropdowns. 30s TTL — see `calls/facets`.
const FACET_CACHE = { at: 0, val: null };
// account name → Anthropic org-id, learned off response headers. Lets the accounts view join a pool
// entry to its acct_limits row without the caller having to know the opaque org id.
const ORG_OF_ACCOUNT = new Map();
// account name → last probe result ({checkedAt, usable, results}). A probe costs a max_tokens:1 ping
// per model, so it is never automatic — but the last answer is worth keeping and showing.
const PROBE_CACHE = new Map();
async function primeAcctCache() {
  for (const r of await dbRows("SELECT org_id,u5,u7,s5,s7,ts,account FROM acct_limits")) {
    ACCT_CACHE.set(r.org_id, { u5: r.u5, u7: r.u7, s5: r.s5, s7: r.s7, ts: Number(r.ts) || 0 });
    if (r.account) ORG_OF_ACCOUNT.set(r.account, r.org_id);
  }
  if (ACCT_CACHE.size) console.log(`[log] primed headroom for ${ACCT_CACHE.size} account(s)`);
}
setTimeout(() => { primeAcctCache().catch(() => {}); }, 1000).unref();

// Ping every advertised model on one account with a max_tokens:1 message. This is the ONLY honest
// answer to "what will this subscription serve": a 429 from Anthropic carries no rate-limit headers,
// so the harvested acct_limits row keeps reporting its last good reading while the account is dry.
// 404 = the model id does not exist. 429 = it exists and the subscription is exhausted.
async function probeAccount(acct) {
  const ids = CFG.claudecodeModels || [];
  const results = await Promise.all(ids.map(async (id) => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${CFG.bases.claudecode}/v1/messages`, {
        method: "POST", headers: TR.anthropicHeaders(acct.token), signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ model: id, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
      let errType = null;
      if (!r.ok) { try { errType = ((await r.json()).error || {}).type || null; } catch {} }
      return { id, status: r.status, ok: r.ok, error: errType, ms: Date.now() - t0 };
    } catch (e) { return { id, status: 0, ok: false, error: e.message, ms: Date.now() - t0 }; }
  }));
  const usable = results.filter((r) => r.ok).map((r) => r.id);
  console.log(`[models] probe ${acct.name}: ${usable.length}/${ids.length} usable (${usable.join(",") || "none"})`);
  const out = { account: acct.name, checkedAt: Date.now(), usable, results };
  PROBE_CACHE.set(acct.name, out);
  return out;
}

const clip = (s) => { const t = s == null ? "" : String(s); return (CONTENT_CAP > 0 && t.length > CONTENT_CAP) ? t.slice(0, CONTENT_CAP) : t; };

// Which credential a route uses (for the "which keys" view).
function keyLabel(route) {
  if (route.provider === "crazyrouter") return "crazyrouterKey";
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
function extractReqMeta(bodyBuf) {
  const out = { toolCount: null, mcpTools: null, toolServers: null, toolsKb: null, msgCount: null, systemKb: null };
  if (!bodyBuf || !bodyBuf.length) return out;
  try {
    const j = JSON.parse(bodyBuf.toString());
    if (Array.isArray(j.tools) && j.tools.length) {
      const s = toolsSummary(j.tools);
      out.toolCount = s.count;
      out.mcpTools = s.mcp;
      out.toolServers = (s.servers || []).join(",") || null;
      out.toolsKb = Math.round(JSON.stringify(j.tools).length / 1024);
    }
    if (Array.isArray(j.messages)) out.msgCount = j.messages.length;
    if (j.system != null) out.systemKb = Math.round(JSON.stringify(j.system).length / 1024);
  } catch { /* not json */ }
  return out;
}

function extractRequestContent(bodyBuf, full) {
  if (!CFG.logging.content || !bodyBuf || !bodyBuf.length) return null;
  try {
    const j = JSON.parse(bodyBuf.toString());
    // Full local-dev save: the conversation verbatim + a compact tools SUMMARY (not the schemas).
    if (full) return JSON.stringify({ model: j.model, system: j.system, messages: j.messages, tools: toolsSummary(j.tools) });
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
  let p = req.headers["x-project"] || req.headers["x-consumer"] || req.headers["x-project-id"] || "";
  if (!p && bodyBuf && bodyBuf.length) {
    try {
      const j = JSON.parse(bodyBuf.toString());
      p = j.project || (j.metadata && j.metadata.project) || j.user || "";
    } catch { /* not json */ }
  }
  return String(p || "").trim().toLowerCase().slice(0, 64);
}

// A caller's identity is a path, not a flat name: `<consumer>[:<job>]`. `promopilot:generatetext`
// has always been two levels — the router just never read it that way, so `promopilot` looked like
// 4 calls when its three workloads had ~30k between them. Splitting on the FIRST colon only means a
// job may itself contain colons; the consumer never can.
function parseConsumer(project) {
  const s = String(project || "").trim().toLowerCase();
  if (!s) return { consumer: "", job: null };
  const i = s.indexOf(":");
  return i < 0 ? { consumer: s, job: null } : { consumer: s.slice(0, i), job: s.slice(i + 1) || null };
}

// Registry lookup, consumer-level. A job never needs registering.
function consumerEntry(project) {
  const { consumer } = parseConsumer(project);
  const reg = CFG.consumers || {};
  return consumer && Object.prototype.hasOwnProperty.call(reg, consumer) ? { name: consumer, ...reg[consumer] } : null;
}

// ── API keys ───────────────────────────────────────────────────────────────
// Wire format: sk-llm-<id>-<secret>.  `id` is a public, non-secret handle so a lookup is a map hit
// rather than a scan over every hash; `secret` is never stored, only its sha256. The consumer name
// is deliberately NOT in the key: it would leak who we are to anyone who sees a truncated key, and
// a name containing '-' (pmac-claude) makes the key unparseable.
const KEY_PREFIX = "sk-llm-";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function mintKey() {
  const id = crypto.randomBytes(4).toString("hex");        // 8 chars, public
  const secret = crypto.randomBytes(24).toString("base64url"); // 32 chars, shown once
  return { id, secret, raw: `${KEY_PREFIX}${id}-${secret}` };
}

function reindexKeys() {
  const ix = new Map();
  for (const [consumer, e] of Object.entries(CFG.consumers || {})) {
    for (const k of (e.keys || [])) if (!k.revoked) ix.set(k.id, { consumer, rec: k });
  }
  KEY_INDEX = ix;
}

// Read the key from either dialect: OpenAI clients send `Authorization: Bearer`, the Anthropic SDK
// sends `x-api-key`. Both reach us on native /v1/messages, so both must work.
function rawApiKey(req) {
  const a = req.headers["authorization"];
  if (a && /^bearer\s+/i.test(a)) {
    const t = a.replace(/^bearer\s+/i, "").trim();
    if (t.startsWith(KEY_PREFIX)) return t;
  }
  const x = req.headers["x-api-key"];
  if (x && String(x).startsWith(KEY_PREFIX)) return String(x).trim();
  return null;
}

// null           → no key presented
// {ok:false,…}   → a key was presented and is bad (unknown id, wrong secret, revoked, orphaned)
// {ok:true,…}    → authenticated; `consumer` is now asserted by us, not by the caller
function authenticate(req) {
  const raw = rawApiKey(req);
  if (!raw) return null;
  const rest = raw.slice(KEY_PREFIX.length);
  const dash = rest.indexOf("-");
  if (dash < 0) return { ok: false, why: "malformed key" };
  const id = rest.slice(0, dash), secret = rest.slice(dash + 1);
  const hit = KEY_INDEX.get(id);
  if (!hit) return { ok: false, why: "unknown or revoked key" };
  const want = Buffer.from(hit.rec.hash, "hex");
  const got = Buffer.from(sha256(secret), "hex");
  // Length is fixed (sha256), so timingSafeEqual cannot throw here — but compare in constant time
  // regardless: a fast-fail on the first differing byte leaks the hash a byte at a time.
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, why: "bad key" };
  const e = (CFG.consumers || {})[hit.consumer];
  if (!e) return { ok: false, why: "key belongs to a deleted consumer" };
  hit.rec.lastUsed = Date.now(); KEY_USE_DIRTY = true;   // flushed to disk lazily, see below
  return { ok: true, consumer: hit.consumer, entry: e, keyId: id };
}

// lastUsed changes on every request. Persisting it inline would mean a disk write per inference, so
// it is flushed on a timer and is therefore approximate — never treat it as an audit trail.
let KEY_USE_DIRTY = false;
setInterval(() => { if (KEY_USE_DIRTY) { KEY_USE_DIRTY = false; persistConfig(); } }, 300000).unref();

// Pull the model-behaviour knobs out of a request body so the call log shows HOW a
// call was asked to run, not just which model. Covers both dialects:
//   OpenAI  → reasoning_effort | reasoning.effort (low/medium/high/...), max_tokens|max_completion_tokens, temperature
//   Anthropic /v1/messages → thinking.budget_tokens (extended thinking), max_tokens, temperature
// thinkingTokens: budget when thinking is enabled, 0 when explicitly disabled, null when absent.
function extractReqParams(bodyBuf) {
  const out = { effort: null, thinkingTokens: null, maxTokens: null, temperature: null, userId: null };
  if (!bodyBuf || !bodyBuf.length) return out;
  try {
    const j = JSON.parse(bodyBuf.toString());
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
  } catch { /* not json */ }
  return out;
}

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
function recordLimits(headers, project, model, account) {
  if (!dbUp() || !headers) return;
  try {
    const h = (k) => headers.get(k);
    const org = h("anthropic-organization-id");
    const u5 = h("anthropic-ratelimit-unified-5h-utilization");
    const u7 = h("anthropic-ratelimit-unified-7d-utilization");
    if (!org || (u5 == null && u7 == null)) return;               // not an Anthropic-native reply
    if (account) ORG_OF_ACCOUNT.set(account, org);
    const num = (v) => (v == null || v === "" ? null : Number(v));
    dbWrite(
      `INSERT INTO acct_limits (org_id,ts,u5,u7,reset5,reset7,status,s5,s7,project,model,account)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (org_id) DO UPDATE SET
         ts=EXCLUDED.ts, u5=EXCLUDED.u5, u7=EXCLUDED.u7, reset5=EXCLUDED.reset5, reset7=EXCLUDED.reset7,
         status=EXCLUDED.status, s5=EXCLUDED.s5, s7=EXCLUDED.s7, project=EXCLUDED.project, model=EXCLUDED.model,
         account=COALESCE(EXCLUDED.account, acct_limits.account)`,
      [org, Date.now(), num(u5), num(u7),
        num(h("anthropic-ratelimit-unified-5h-reset")), num(h("anthropic-ratelimit-unified-7d-reset")),
        h("anthropic-ratelimit-unified-status") || null,
        h("anthropic-ratelimit-unified-5h-status") || null, h("anthropic-ratelimit-unified-7d-status") || null,
        project || null, model || null, account || null],
    );
    // Keep the in-process snapshot warm so acctHealth() stays synchronous (adminState is not async).
    ACCT_CACHE.set(org, { u5: num(u5), u7: num(u7), s5: h("anthropic-ratelimit-unified-5h-status") || null,
      s7: h("anthropic-ratelimit-unified-7d-status") || null, ts: Date.now() });
  } catch { /* never let limit-harvest break a request */ }
}

const CALL_COLS = "ts,ip,ua,method,path,req_model,provider,sent_model,key_label,status,duration_ms,stream," +
  "prompt_tokens,completion_tokens,total_tokens,error,req_content,resp_content,project,effort," +
  "thinking_tokens,max_tokens,temperature,user_id,cache_read,cache_write,stop_reason,tool_count," +
  "mcp_tools,tool_servers,tools_kb,msg_count,system_kb";
const CALL_PLACEHOLDERS = Array.from({ length: 33 }, (_, i) => `$${i + 1}`).join(",");

function recordCall(rec) {
  if (!dbUp() || !CFG.logging.enabled) return;
  try {
    const u = rec.usage || {};
    dbWrite(`INSERT INTO calls (${CALL_COLS}) VALUES (${CALL_PLACEHOLDERS})`, [
      rec.ts || Date.now(), rec.ip || null, rec.ua || null, rec.method || null, rec.path || null,
      rec.reqModel || null, rec.provider || null, rec.sentModel || null, rec.keyLabel || null,
      rec.status == null ? null : rec.status, rec.ms == null ? null : rec.ms, !!rec.stream,
      u.prompt_tokens ?? null, u.completion_tokens ?? null, u.total_tokens ?? null,
      rec.error || null,
      CFG.logging.content ? (rec.reqContent || null) : null,
      CFG.logging.content ? (rec.respContent == null ? null : (rec.full ? String(rec.respContent) : clip(rec.respContent))) : null,
      rec.project || null,
      rec.effort || null,
      rec.thinkingTokens == null ? null : rec.thinkingTokens,
      rec.maxTokens == null ? null : rec.maxTokens,
      rec.temperature == null ? null : rec.temperature,
      rec.userId || null,
      u.cache_read_input_tokens == null ? null : u.cache_read_input_tokens,
      u.cache_creation_input_tokens == null ? null : u.cache_creation_input_tokens,
      rec.stopReason || null,
      rec.toolCount == null ? null : rec.toolCount,
      rec.mcpTools == null ? null : rec.mcpTools,
      rec.toolServers || null,
      rec.toolsKb == null ? null : rec.toolsKb,
      rec.msgCount == null ? null : rec.msgCount,
      rec.systemKb == null ? null : rec.systemKb,
    ]);
    // retain=0 → keep every row forever (no pruning on any provider). Claude Code chats are exempt
    // and kept regardless; match both the pre- and post-rename provider names or one becomes prunable.
    if (CFG.logging.retain > 0 && ++insertsSincePrune >= 200) {
      insertsSincePrune = 0;
      dbWrite(
        `DELETE FROM calls WHERE provider NOT IN ('anthropic','claudecode')
           AND id NOT IN (SELECT id FROM calls WHERE provider NOT IN ('anthropic','claudecode')
                          ORDER BY id DESC LIMIT $1)`,
        [CFG.logging.retain]);
    }
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

// ── provider resolution (reads live CFG) ──

// qwen3.5-9b thinks by default: it fills `reasoning_content` and leaves `content` empty until the
// thought ends, so a normal token budget runs out mid-thought and the caller is billed for an empty
// string with finish_reason:"length". Thinking is off unless the caller asks for it.
//
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

const localTarget = (m) => (m == null ? null : CFG.localMap[String(m).toLowerCase()] || null);
// A `claude*` model id means the claudecode provider (our Max account pool → api.anthropic.com).
const isClaudeModel = (m) => typeof m === "string" && m.toLowerCase().startsWith((CFG.claudePrefix || "claude").toLowerCase());
const isGated = (target) => Array.isArray(CFG.gatedModels) && CFG.gatedModels.includes(target);

// ── DELETED: the entire subprocess-wrapper support apparatus ───────────────
// The wrapper spawned a `claude` CLI subprocess per request, so it needed a concurrency gate, a
// circuit breaker, a half-open prober, a 200-with-a-quota-notice body sniffer, and a silent
// cross-provider failover to crazyrouter. All of that existed to babysit ONE upstream.
//
// The gateway now speaks to api.anthropic.com directly. There is no subprocess to stampede, so
// there is nothing to gate; a 429 is a real 429 and is returned as such. Nothing silently reroutes
// a Claude request to a different model on a different provider behind your back — that swapped the
// answer, blew the prompt cache, and spent money invisibly. If the pinned account is out of quota
// you get told, and you re-pin.
//
// Removed with it: the failure classifier, the quota-notice body sniffer, the circuit breaker and
// its half-open prober, the crazyrouter fallback route, the admission gate + queue, the max_tokens
// floor, and the one-shot failover.

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

// True if any message carries image (multimodal) content. OpenAI/Anthropic put images in an array
// `content` as parts like {type:"image_url"...} / {type:"image", source} / {type:"input_image"}.
function hasImageContent(messages) {
  for (const m of messages) {
    const c = m && m.content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (p && typeof p === "object" &&
          (String(p.type || "").includes("image") || p.image_url || p.image || p.source)) return true;
    }
  }
  return false;
}

// Run the request's `messages` through the headroom-compress sidecar before forwarding upstream.
// Returns { buf, stats }. On ANY problem it returns the original bytes and stats=null, so a slow or
// dead compressor never blocks inference. Only touches chat/messages bodies that carry a messages[].
async function headroomCompress(bodyBuf, model, provider) {
  if (!HEADROOM_URL || !bodyBuf || bodyBuf.length < HEADROOM_MIN_CHARS) return { buf: bodyBuf, stats: null };
  if (HEADROOM_PROVIDERS.size && provider && !HEADROOM_PROVIDERS.has(provider)) return { buf: bodyBuf, stats: null };
  // HARD GUARD — never compress cache-optimized / tool-using requests (Claude Code, agents).
  // Rewriting messages breaks the byte-identical cached prefix → a cache MISS costs ~12x
  // (cache_read 0.1x vs cache_write 1.25x), dwarfing any compression saving, and can corrupt
  // tool_use/tool_result pairing. The prompt cache is the better, lossless compression here.
  // This is deliberately independent of HEADROOM_PROVIDERS so a misconfig can't tax agentic traffic.
  const rawStr = bodyBuf.toString();
  if (rawStr.includes('"cache_control"') || rawStr.includes('"tools"')) return { buf: bodyBuf, stats: null };
  let obj;
  try { obj = JSON.parse(rawStr); } catch { return { buf: bodyBuf, stats: null }; }
  if (!Array.isArray(obj.messages) || !obj.messages.length) return { buf: bodyBuf, stats: null };
  // Skip multimodal/image requests: headroom can't shrink base64 (0 savings) and shipping a multi-MB
  // image to the sidecar and back just adds latency + bandwidth. The image passes through untouched.
  if (hasImageContent(obj.messages)) return { buf: bodyBuf, stats: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEADROOM_TIMEOUT_MS);
  try {
    const hdrs = { "content-type": "application/json" };
    if (HEADROOM_TOKEN) hdrs["authorization"] = `Bearer ${HEADROOM_TOKEN}`;
    const r = await fetch(HEADROOM_URL + "/compress", {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ messages: obj.messages, model: model || obj.model || undefined }),
      signal: ctrl.signal,
    });
    if (!r.ok) return { buf: bodyBuf, stats: null };
    const j = await r.json();
    if (!j || !Array.isArray(j.messages)) return { buf: bodyBuf, stats: null };
    obj.messages = j.messages;
    return { buf: Buffer.from(JSON.stringify(obj)), stats: j.stats || null };
  } catch { return { buf: bodyBuf, stats: null }; }
  finally { clearTimeout(timer); }
}

async function proxy(req, res, base, opts = {}) {
  const { bodyBuf, injectKey, authToken, rewriteModel, model, provider, project } = opts;
  let target = base + req.url;
  const ip = opts.ip || req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const t0 = Date.now();
  let stream = false;
  let headers = buildHeaders(req, { injectKey, authToken });
  let body = bodyBuf;

  // Does this call need OpenAI→Anthropic translation? Only when an OpenAI-shaped request is being
  // served by the claudecode provider. A native /v1/messages caller (Claude Code) is forwarded
  // byte-for-byte — translating it would only lose fidelity and bust its prompt cache.
  const wantsTranslate = !!opts.translate;

  if (bodyBuf && bodyBuf.length) {
    try {
      const j = JSON.parse(bodyBuf.toString());
      stream = !!j.stream;
      if (rewriteModel && j && j.model) j.model = rewriteModel;
      if (provider === "local" && isChatCompletions(req.url)) applyLocalThinkingDefault(j);
      if (wantsTranslate) {
        const a = TR.openaiToAnthropic(j);
        body = Buffer.from(JSON.stringify(a));
        target = base + "/v1/messages";                     // OpenAI path does not exist upstream
      } else {
        body = Buffer.from(JSON.stringify(j));
      }
      headers["content-type"] = "application/json";
    } catch { /* not JSON — leave body as-is */ }
  }

  // The claudecode provider ALWAYS gets synthesized auth headers. A Max setup-token is rejected by
  // Anthropic without `anthropic-beta: oauth-2025-04-20` + a claude-cli UA; trusting the caller to
  // supply them is exactly why only real Claude Code ever worked on this path.
  if (provider === "claudecode" && authToken) {
    headers = {
      ...TR.anthropicHeaders(authToken, { extraBeta: req.headers["anthropic-beta"] || "" }),
      accept: stream ? "text/event-stream" : "application/json",
    };
  }

  // Common fields for the call-log row. claudecode chats are saved in full (uncapped).
  const fullContent = (provider === "claudecode");
  const base_rec = {
    ts: t0, ip, ua: req.headers["user-agent"] || "", method: req.method, path: (req.url || "").split("?")[0],
    reqModel: model || null, provider: provider || "local", sentModel: rewriteModel || model || null,
    keyLabel: opts.account ? `claudecode:${opts.account}` : keyLabel({ provider: provider || "local", target: opts.target }), stream, full: fullContent,
    reqContent: extractRequestContent(bodyBuf, fullContent), project: project || null,
    ...extractReqParams(bodyBuf),
    ...extractReqMeta(bodyBuf),
  };
  let curTarget = target, curProvider = provider;
  let curInit = { method: req.method, headers, redirect: "follow" };
  if (!["GET", "HEAD"].includes(req.method) && body && body.length) curInit.body = body;
  let up = null, threw = false, fetchErr = null;
  try { up = await fetch(curTarget, curInit); }
  catch (e) { threw = true; fetchErr = e; }

  // NOTE: there is no failover. Not to another account, not to another provider. A 429 means the
  // project's pinned account is out of quota and the caller is told so; a 5xx means the upstream
  // failed and the caller is told so. Silently re-answering with a different model on someone
  // else's bill is what the old wrapper→crazyrouter path did, and it hid both cost and truth.
  if (provider === "claudecode" && !threw && up && up.status === 429 && opts.account) {
    recordLimits(up.headers, base_rec.project, base_rec.sentModel || base_rec.reqModel, opts.account);
    console.warn(`[account] 429 on ${opts.account} (project=${base_rec.project || "-"}) — no auto-switch, returning 429 to caller`);
  }

  if (threw) {
    console.error(`[err] fetch-failed provider=${curProvider || "?"} model=${model || "-"} ${curTarget}: ${fetchErr.message}`);
    shipError(`upstream fetch failed: ${fetchErr.message}`, { model: model || "-", provider: curProvider || "?", ip, target: curTarget });
    recordCall({ ...base_rec, status: 502, ms: Date.now() - t0, error: "upstream fetch failed: " + fetchErr.message });
    res.writeHead(502, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "upstream fetch failed: " + fetchErr.message } }));
  }
  if (up.status >= 400) {
    console.error(`[err] upstream=${up.status} provider=${curProvider || "?"} model=${model || "-"} ${curTarget}`);
    up.clone().text().then((t) => shipError(`upstream ${up.status} ${req.method} ${req.url}`, { model: model || "-", provider: curProvider || "?", ip, status: up.status, body: t })).catch(() => {});
  }
  // Image provider: upstream errors arrive as bare text; convert to OpenAI JSON error envelope.
  if (curProvider === "images" && up.status >= 400) {
    const errText = await up.text().catch(() => "");
    const msg = errText.trim() || `image generation failed (${up.status})`;
    res.writeHead(up.status, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: msg, type: "upstream_error", param: null } }));
  }
  // Free rate-limit harvest: snapshot this account's live 5h/7d headroom off the response headers
  // (no probe, zero tokens). Fires for any Anthropic-native reply; a no-op for other providers.
  recordLimits(up.headers, base_rec.project, base_rec.sentModel || base_rec.reqModel, opts.account);
  const isStream = (up.headers.get("content-type") || "").includes("text/event-stream");
  // Only chat/responses/completions calls carry content worth recording; for those we tee the
  // body (capped) to pull tokens + reply. /v1/models etc. are skipped to keep the log signal high.
  // Image generation is billed in GPU time, not tokens, so it carries no `usage` — but an unlogged
  // call is an unattributable one, and `imagegen` went 100% invisible in the call log until 2026-07-09.
  const recordThis = CFG.logging.enabled && req.method === "POST" && /\/(chat\/completions|responses|completions|messages|chat|images\/(generations|edits|variations))$/.test(base_rec.path);

  // ── translated responses (OpenAI caller, claudecode provider) ──
  // The upstream spoke Anthropic; the caller expects OpenAI. Rewrite the body, and DON'T forward
  // upstream's content-length (the translated body is a different size).
  if (wantsTranslate && up.body && up.status < 400) {
    if (isStream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const tr = TR.createSseTranslator({ model: base_rec.sentModel || base_rec.reqModel || "", includeUsage: true });
      const raw = [];
      for await (const chunk of Readable.fromWeb(up.body)) {
        const s = Buffer.from(chunk).toString();
        if (recordThis) raw.push(s);
        const out = tr.push(s);
        if (out) res.write(out);
      }
      res.end();
      if (recordThis) {
        const u = tr.usage ? TR.usageToOpenai(tr.usage) : null;
        recordCall({ ...base_rec, status: up.status, ms: Date.now() - t0,
          usage: u && { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens },
          respContent: raw.join("").slice(0, 20000), stopReason: null, error: null });
      }
      return;
    }
    const buf = Buffer.from(await up.arrayBuffer());
    let out;
    try {
      out = TR.anthropicToOpenai(JSON.parse(buf.toString()), { model: base_rec.sentModel || base_rec.reqModel || "" });
    } catch (e) {
      console.error(`[translate] bad upstream body: ${e.message}`);
      res.writeHead(502, { "content-type": "application/json" });
      recordCall({ ...base_rec, status: 502, ms: Date.now() - t0, error: "translate failed: " + e.message });
      return res.end(JSON.stringify({ error: { message: "translate failed: " + e.message, type: "bad_upstream" } }));
    }
    const outBuf = Buffer.from(JSON.stringify(out));
    res.writeHead(up.status, { "content-type": "application/json" });
    if (recordThis) {
      recordCall({ ...base_rec, status: up.status, ms: Date.now() - t0, usage: out.usage,
        respContent: clip(out.choices?.[0]?.message?.content || ""), stopReason: out.choices?.[0]?.finish_reason || null, error: null });
    }
    return res.end(outBuf);
  }

  const rh = {};
  up.headers.forEach((v, k) => { if (!HOP_RES.has(k.toLowerCase())) rh[k] = v; });
  res.writeHead(up.status, rh);
  if (up.body && !up.bodyUsed) {
    const r = Readable.fromWeb(up.body);
    if (recordThis) {
      // An image reply is multi-MB of base64 with no `usage` and nothing worth reading back. Buffer
      // none of it (cap 0) — the row is worth having, the payload is not.
      const isImage = provider === "images";
      const chunks = []; let size = 0;
      const cap = isImage ? 0 : (base_rec.full ? Infinity : CONTENT_CAP + 8192); // local-dev keeps the full streamed reply
      r.on("data", (d) => { if (size < cap) { chunks.push(Buffer.from(d)); size += d.length; } });
      const done = () => {
        const ex = isImage ? { usage: null, content: null, stopReason: null }
                           : extractResponseBody(Buffer.concat(chunks), isStream);
        recordCall({ ...base_rec, status: up.status, ms: Date.now() - t0, usage: ex.usage, respContent: ex.content,
          stopReason: ex.stopReason, error: up.status >= 400 ? `upstream ${up.status}` : null });
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
  const { base, injectKey, authToken, rewriteModel, model, provider, ip, bodyBuf, project, account } = route;
  const maxRetries = CFG.jsonMaxRetries;
  const reqObj = JSON.parse(bodyBuf.toString());           // caller already verified this parses
  const wantStream = !!reqObj.stream;
  const t0 = Date.now();
  const logRec = {
    ts: t0, ip, ua: req.headers["user-agent"] || "", method: req.method, path: (req.url || "").split("?")[0],
    reqModel: model || null, provider, sentModel: rewriteModel || model || null,
    // Same attribution as the proxy path: without the account name the row cannot be billed to
    // a subscription, and the per-account spend view silently under-counts json-enforced calls.
    keyLabel: account ? `claudecode:${account}` : keyLabel({ provider, target: route.target }), stream: wantStream,
    reqContent: extractRequestContent(bodyBuf), project: project || null,
    ...extractReqParams(bodyBuf),
    ...extractReqMeta(bodyBuf),
  };
  const logJson = (status, parsed, error) => recordCall({ ...logRec, status, ms: Date.now() - t0,
    usage: parsed && parsed.usage, error,
    respContent: parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
      ? parsed.choices[0].message.content : null });
  reqObj.stream = false;                                   // must see the whole body to validate
  if (rewriteModel) reqObj.model = rewriteModel;
  if (provider === "local") applyLocalThinkingDefault(reqObj);
  const messages = Array.isArray(reqObj.messages) ? reqObj.messages.slice() : [];
  const rf = reqObj.response_format;
  const rfType = typeof rf === "string" ? rf : (rf && rf.type);
  // Neither claudecode nor the local json_object mode honours `response_format` natively → strip it
  // and steer with a plain instruction instead.
  if (provider === "claudecode" || (provider === "local" && rfType === "json_object")) {
    delete reqObj.response_format;
    injectJsonInstruction(messages, rf);
  }
  let headers = buildHeaders(req, { injectKey, authToken });
  headers["content-type"] = "application/json";
  headers["accept"] = "application/json";
  let target = base + req.url;
  const curProvider = provider;
  // No failover. If the upstream fails, the caller is told. See proxy() for why.

  // One upstream round-trip. On claudecode we translate OpenAI→Anthropic on the way out and
  // Anthropic→OpenAI on the way back, so everything below this line only ever sees OpenAI shape.
  const translating = curProvider === "claudecode";
  async function callUpstream() {
    const url = translating ? base + "/v1/messages" : target;
    const hdrs = translating
      ? { ...TR.anthropicHeaders(authToken), accept: "application/json" }
      : headers;
    const payload = translating ? TR.openaiToAnthropic(reqObj) : reqObj;
    const up = await fetch(url, { method: "POST", headers: hdrs, redirect: "follow", body: Buffer.from(JSON.stringify(payload)) });
    let text = await up.text();
    if (translating && up.status < 400) {
      try { text = JSON.stringify(TR.anthropicToOpenai(JSON.parse(text), { model: reqObj.model })); }
      catch (e) { console.error(`[translate] json-enforce bad upstream body: ${e.message}`); }
    }
    return { up, text };
  }

  let lastErr = "", lastRaw = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    reqObj.messages = messages;
    let up, text;
    try { ({ up, text } = await callUpstream()); }
    catch (e) {
      console.error(`[err] json-enforce fetch-failed provider=${curProvider} model=${model || "-"} ${target}: ${e.message}`);
      shipError(`json-enforce upstream fetch failed: ${e.message}`, { model: model || "-", provider: curProvider, ip, target });
      recordCall({ ...logRec, status: 502, ms: Date.now() - t0, error: "upstream fetch failed: " + e.message });
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "upstream fetch failed: " + e.message } }));
    }
    if (curProvider === "claudecode") recordLimits(up.headers, logRec.project, logRec.sentModel || logRec.reqModel, account);
    if (up.status >= 400) {                                // upstream error — surfaced, never masked
      console.error(`[err] upstream=${up.status} provider=${curProvider} model=${model || "-"} ${target} (json-enforce)`);
      shipError(`upstream ${up.status} ${req.method} ${req.url} (json-enforce)`, { model: model || "-", provider: curProvider, ip, status: up.status, body: text });
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
    console.error(`[err] json-invalid provider=${provider} model=${model || "-"} attempt=${attempt + 1}/${maxRetries + 1}: ${v.error}`);
    if (attempt < maxRetries) {
      // Neutral, non-accusatory wording: claude-haiku reads "your reply failed / do it again" as a
      // prompt-injection attempt and refuses harder. Just restate the format requirement plainly.
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({ role: "user", content: `Please reformat that as a single valid JSON value only — no markdown code fences and no text before or after the JSON.` });
    }
  }
  shipError(`json enforcement failed after ${maxRetries + 1} attempts`, { model: model || "-", provider, ip, error: lastErr });
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

// Fetch the crazyrouter catalog (best-effort). claudecode ids are static (claude-*), so they are
// listed from config rather than probed — probing would spend a real token on a real account.
async function upstreamCatalogs() {
  let crazyrouter = [];
  try {
    const c = await fetch(CFG.bases.crazyrouter + "/v1/models", { headers: { authorization: `Bearer ${CFG.crazyrouterKey}` }, signal: AbortSignal.timeout(8000) });
    const cj = await c.json();
    crazyrouter = ((cj && cj.data) || []).map((m) => ({ ...m, owned_by: "crazyrouter" }));
  } catch { /* crazyrouter down — skip */ }
  // Ids come from Anthropic (refreshClaudecodeModels), floored by CLAUDECODE_MODEL_SEED.
  const meta = new Map((claudecodeCatalog.models || []).map((m) => [m.id, m]));
  const claudecode = (CFG.claudecodeModels || []).map((id) => {
    const m = meta.get(id);
    return { id, object: "model", owned_by: "claudecode", ...(m && m.display_name ? { display_name: m.display_name } : {}) };
  });
  return { claudecode, crazyrouter };
}

// ── claudecode catalog, straight from Anthropic ──────────────────────────────
// `claudecodeModels` used to be a hand-typed list in config.json. It drifted: Anthropic served 9
// ids while we advertised 5. Nothing broke loudly — the four missing ids just 400'd as "not
// routable", which reads like a caller typo. So we ask the source instead.
//
// The catalog is PER-ACCOUNT and PAGINATED, and both facts cost us ids.
//
//   per-account: `philip` lists claude-opus-4-1; `cmejl3` 404s it. Reading one account's view and
//                calling it "the catalog" silently drops every model the other orgs can see.
//   paginated:   /v1/models answers `has_more` + `last_id`. One page is not the list.
//
// So: sweep EVERY account, follow EVERY page, union the lot. Each model records which accounts
// offer it (`accounts`), because "advertised" and "servable by your pinned account" are different
// questions — /v1/models answers the first, claudecode/probe answers the second.
//
// A failed sweep is a no-op, never a downgrade: CFG keeps whatever it already had. A partial sweep
// (some accounts erroring) still unions what it did get, floored by CLAUDECODE_MODEL_SEED.
let claudecodeCatalog = { source: "seed", ts: 0, accounts: [], failed: [], models: [], error: null };

async function fetchAccountModels(acct) {
  const out = [];
  let after = null;
  for (let page = 0; page < 10; page++) {   // 10×100 ids is far past any real catalog; no infinite loop
    const qs = new URLSearchParams({ limit: "100", ...(after ? { after_id: after } : {}) });
    const r = await fetch(`${CFG.bases.claudecode}/v1/models?${qs}`,
      { headers: TR.anthropicHeaders(acct.token), signal: AbortSignal.timeout(8000) });
    // The catalog sweep is the only request we make on behalf of an account with no traffic, so it
    // is where a cold-started router learns which opaque org-id belongs to which of our logins.
    // Without this the accounts view shows `limits: null` until the account happens to serve a call.
    const org = r.headers.get("anthropic-organization-id");
    if (org) ORG_OF_ACCOUNT.set(acct.name, org);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const page_ = (j.data || []).filter((m) => m && typeof m.id === "string" && m.id.trim());
    out.push(...page_);
    if (!j.has_more || !page_.length) break;
    after = j.last_id || page_[page_.length - 1].id;
  }
  return out;
}

async function fetchAnthropicModels() {
  const pool = CFG.claudecodeAccountPool || [];
  const settled = await Promise.all(pool.map(async (a) => {
    try { return { account: a.name, models: await fetchAccountModels(a) }; }
    catch (e) { return { account: a.name, error: e.message }; }
  }));
  const ok = settled.filter((s) => s.models && s.models.length);
  if (!ok.length) return null;

  // Union by id; remember every account that offers each one.
  const byId = new Map();
  for (const { account, models } of ok) {
    for (const m of models) {
      const prev = byId.get(m.id);
      if (prev) prev.accounts.push(account);
      else byId.set(m.id, { ...m, accounts: [account] });
    }
  }
  return {
    models: [...byId.values()],
    accounts: ok.map((s) => s.account),
    failed: settled.filter((s) => s.error).map((s) => ({ account: s.account, error: s.error })),
  };
}

async function refreshClaudecodeModels(why) {
  const hit = await fetchAnthropicModels();
  if (!hit) {
    claudecodeCatalog = { ...claudecodeCatalog, error: "no account could read api.anthropic.com/v1/models" };
    console.warn(`[models] claudecode refresh (${why}) FAILED — keeping ${CFG.claudecodeModels.length} known ids`);
    return claudecodeCatalog;
  }
  // Anthropic is authoritative, but never let a partial sweep shrink us below the seed.
  const live = hit.models.map((m) => m.id);
  // Aliases are appended after the live catalog: Anthropic serves them but never lists them, so a
  // sweep alone would drop `claude-haiku-4-5` — the id most callers send.
  CFG.claudecodeModels = [...new Set([...live, ...CLAUDECODE_MODEL_SEED, ...CLAUDECODE_MODEL_ALIASES])];
  claudecodeCatalog = { source: "anthropic", ts: Date.now(), accounts: hit.accounts, failed: hit.failed, models: hit.models, error: null };
  const fail = hit.failed.length ? ` (${hit.failed.length} account(s) unreadable)` : "";
  console.log(`[models] claudecode refresh (${why}) across ${hit.accounts.length} account(s)${fail}: ${live.length} live → advertising ${CFG.claudecodeModels.length}`);
  return claudecodeCatalog;
}

async function mergedModels(res) {
  const local = localModelEntries();
  const { claudecode, crazyrouter } = await upstreamCatalogs();
  const images = [{ id: IMAGE_MODEL_ID, object: "model", owned_by: "pbox" }];
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify({ object: "list", data: [...local, ...images, ...claudecode, ...crazyrouter] }));
}

// Build a concrete route for an explicit (provider, model) — used by forceModel / modelRoutes /
// defaultRoute. `model` is the id actually sent upstream (rewriteModel).
function providerRoute(provider, model, reason) {
  const l = normProvider(provider) || "crazyrouter";
  // claudecode: the pinned account's token is attached later (dispatch), not here.
  if (l === "claudecode") return { provider: "claudecode", base: CFG.bases.claudecode, rewriteModel: model || undefined, reason };
  if (l === "local") return { provider: "local", base: CFG.bases.local, rewriteModel: model, target: model, reason };
  return { provider: "crazyrouter", base: CFG.bases.crazyrouter, injectKey: true, rewriteModel: model || undefined, reason };
}

// Where unknown / empty / crazyrouter-blocked models go. provider "none" → blocked (caller gets 400).
function defaultRouteResolved(why) {
  const d = CFG.defaultRoute || { provider: "none" };
  if (!d.provider || d.provider === "none" || !d.model) return { provider: "blocked", blocked: true, why, reason: why + "; no default route" };
  return { ...providerRoute(d.provider, d.model, `default route (${why})`), via: "default" };
}

// Turn a per-project / per-group rule ({provider,model} or {block:true}) into a concrete route.
function projectRule(rule, m, label) {
  if (rule.block)
    return { provider: "blocked", blocked: true, why: `${label} is blocked (token spend disabled)`, reason: `blocked: ${label}` };
  return providerRoute(rule.provider, rule.model || m, `override: ${label}`);
}
// First projectGroup whose prefix matches this project slug (exact or startsWith). null if none.
function matchProjectGroup(pkey) {
  for (const g of CFG.projectGroups || [])
    for (const pre of g.prefixes || [])
      if (pkey === pre || pkey.startsWith(pre)) return g;
  return null;
}

// ── per-project usage limits ────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Resolve the effective limit for a project: exact entry (authoritative) → matching
// group's .limit → projectLimitDefault (only when it actually caps something). null = no limit.
function limitFor(project) {
  if (!project) return null;
  const k = String(project).trim().toLowerCase();
  const pl = CFG.projectLimits || {};
  if (Object.prototype.hasOwnProperty.call(pl, k)) {
    const e = pl[k];
    return (e && (e.tokens > 0 || e.calls > 0)) ? e : null; // explicit all-zero entry = exempt
  }
  const g = matchProjectGroup(k);
  if (g && g.limit && (g.limit.tokens > 0 || g.limit.calls > 0)) return g.limit;
  const d = CFG.projectLimitDefault;
  if (d && (d.tokens > 0 || d.calls > 0)) return d;
  return null;
}
// Rolling-window usage for a project from the call log, cached ~5s to avoid per-request SUMs.
const _usageCache = new Map();
async function projectUsage(project, windowMs) {
  if (!dbUp() || !project) return { tokens: 0, calls: 0 };
  const key = project + "|" + windowMs, now = Date.now(), c = _usageCache.get(key);
  if (c && now - c.at < 5000) return c.val;                 // ~5s cache: this is on the hot path
  let val = { tokens: 0, calls: 0 };
  const r = await dbRow(
    "SELECT COUNT(*)::int AS calls, COALESCE(SUM(total_tokens),0)::bigint AS tokens FROM calls WHERE project=$1 AND ts>=$2",
    [project, now - windowMs]);
  // dbRow swallows errors and returns null → treat as no usage. A quota check must never be the
  // reason an inference request fails.
  if (r) val = { tokens: Number(r.tokens) || 0, calls: Number(r.calls) || 0 };
  _usageCache.set(key, { at: now, val });
  return val;
}
// Decide what to do for this project right now. null = no limit configured.
// action ∈ ok | warn | slow | block. pct = max(token%, call%) of the cap.
async function usageVerdict(project) {
  const lim = limitFor(project);
  if (!lim) return null;
  const u = await projectUsage(project, WINDOW_MS[lim.window] || WINDOW_MS["24h"]);
  const pt = lim.tokens > 0 ? u.tokens / lim.tokens : 0;
  const pc = lim.calls > 0 ? u.calls / lim.calls : 0;
  const pct = Math.max(pt, pc);
  let action = "ok";
  if (pct >= 1) action = lim.hard === "warn" ? "warn" : lim.hard === "slow" ? "slow" : "block";
  else if (pct >= lim.slowPct / 100) action = "slow";
  else if (pct >= lim.warnPct / 100) action = "warn";
  return { lim, usage: u, pct, action };
}

// Resolve a model name into a concrete upstream route. Priority:
//   0a. projectRoutes (exact per-project override — beats everything, incl. group rules)
//   0b. projectGroups (prefix-matched group override)
//   1. forceModel (global override)  2. modelRoutes (per-model, any provider)  3. local alias map
//   4. claude* prefix  5. empty model → default route  6. cloud policy (open/allowlist/off)
// ── account selection: PINNED per project, never automatic ────────────────
// One project → one account, decided by config alone. There is deliberately NO auto-rotation:
// a silent account switch is a full prompt-cache miss (~12x cost) AND it makes "who spent this?"
// unanswerable after the fact. If the pinned account is out of quota, its real 429 reaches the
// caller. You fix that by re-pinning in /admin — not by the gateway guessing.
//
// `acctHealth` exists for DISPLAY and DEBUGGING only. It never influences which account is chosen.
// Synchronous read of the latest per-account headroom, because adminState() is synchronous and the
// DB is now a network hop away. ACCT_CACHE is filled by recordLimits() off live traffic and primed
// once at boot (see primeAcctCache), so this never blocks and never awaits.
function acctHealth(org) {
  try {
    const r = org ? ACCT_CACHE.get(org) : null;
    if (!r) return { util: 0, hot: false, ts: 0, stale: true };
    const stale = !r.ts || (Date.now() - r.ts > 6 * 3600 * 1000);   // no fresh reading → unknown, not "cool"
    const util = stale ? 0 : Math.max(r.u5 || 0, r.u7 || 0);
    const hot = !stale && ((r.u5 || 0) >= 0.95 || (r.u7 || 0) >= 0.98 || r.s5 === "rejected" || r.s7 === "rejected");
    return { util, hot, ts: r.ts || 0, stale };
  } catch { return { util: 0, hot: false, ts: 0, stale: true }; }
}

// The account a project bills to, or null. Resolution is exactly two steps, both explicit:
//   1. projectAccounts[project]  — the pin, edited in /admin
//   2. CFG.defaultAccount        — one named fallback, also explicit
// No request header can override it. Deterministic: same project ⇒ same account, every time.
// (`consumerAccounts` is the pre-rename name of `projectAccounts`; both are read during migration.)
function accountFor(project) {
  const pool = CFG.claudecodeAccountPool || [];
  if (!pool.length) return null;
  const p = String(project == null ? "" : project).trim().toLowerCase();
  const pins = CFG.projectAccounts || CFG.consumerAccounts || {};
  // Try the exact path first, then fall back to the consumer. A pin is a property of WHO is calling,
  // not of which workload they are running: pinning `promopilot` must cover `promopilot:l2_metadata`
  // without pinning every job by hand. An exact-path pin still wins, so one greedy job can be moved
  // to its own account without moving the rest.
  const { consumer } = parseConsumer(p);
  const want = String((p && pins[p]) || (consumer && pins[consumer]) || CFG.defaultAccount || "").trim().toLowerCase();
  if (!want) return null;
  return pool.find((a) => String(a.name).toLowerCase() === want) || null;
}

function resolveRoute(model, project) {
  const m = model == null ? "" : String(model);
  const key = m.toLowerCase();
  const pkey = project == null ? "" : String(project).trim().toLowerCase();
  // `imagegen` is routed by PATH, not by model id. Asking for it on a text endpoint used to fall all
  // the way through to crazyrouter — the one provider that bills per token — and come back as their
  // 404. Reject it here, next to the id it names, rather than 200 miles downstream at someone's till.
  if (key === IMAGE_MODEL_ID)
    return { provider: "blocked", blocked: true, why: `'${IMAGE_MODEL_ID}' is an image model — POST it to /v1/images/generations, not a chat endpoint`,
             reason: "imagegen on a text endpoint" };
  if (pkey && CFG.projectRoutes && CFG.projectRoutes[pkey])
    return projectRule(CFG.projectRoutes[pkey], m, `project ${pkey}`);
  if (pkey) {
    const g = matchProjectGroup(pkey);
    if (g) return projectRule(g, m, `group ${g.name}`);
  }
  if (CFG.forceModel && CFG.forceModel.enabled && CFG.forceModel.model)
    return providerRoute(CFG.forceModel.provider, CFG.forceModel.model, "forced (global)");
  if (CFG.modelRoutes && CFG.modelRoutes[key])
    return providerRoute(CFG.modelRoutes[key].provider, CFG.modelRoutes[key].model || m, `override: ${key}`);
  const lt = localTarget(m);
  if (lt) return { provider: "local", base: CFG.bases.local, rewriteModel: lt, target: lt, reason: "local alias" };
  if (isClaudeModel(m)) return { provider: "claudecode", base: CFG.bases.claudecode, reason: "claude* model" };
  if (!m) return defaultRouteResolved("no model specified");
  const pol = CFG.cloudPolicy || "open";
  if (pol === "open") return { provider: "crazyrouter", base: CFG.bases.crazyrouter, injectKey: true, reason: "crazyrouter (open)" };
  if (pol === "allowlist" && (CFG.cloudAllowlist || []).some((x) => x.toLowerCase() === key))
    return { provider: "crazyrouter", base: CFG.bases.crazyrouter, injectKey: true, reason: "crazyrouter (allowlisted)" };
  return defaultRouteResolved(pol === "off" ? "crazyrouter provider disabled" : "not in crazyrouter allowlist");
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin (password-gated): edit routing/models/keys, check providers + crazyrouter.
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
// Trusted IPs bypass the admin-login throttle entirely (our own fleet's egress —
// they're never a brute-force threat). Set ADMIN_TRUSTED_IPS=ip1,ip2,… in the env.
const ADMIN_TRUSTED_IPS = new Set(
  (process.env.ADMIN_TRUSTED_IPS || "").split(",").map((s) => s.trim()).filter(Boolean),
);
function throttled(ip) {
  if (ADMIN_TRUSTED_IPS.has(ip)) return false;   // our fleet — zero limit
  const now = Date.now();
  const rec = loginHits.get(ip) || { n: 0, reset: now + 300000 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 300000; }
  rec.n++;
  loginHits.set(ip, rec);
  if (loginHits.size > 5000) loginHits.clear();
  return rec.n > 30;   // fleet shares one egress IP; cccc now caches the cookie so real logins are rare
}

function adminState() {
  return {
    providers: PROVIDERS,
    bases: CFG.bases,
    localMap: CFG.localMap,
    gatedModels: CFG.gatedModels,
    claudePrefix: CFG.claudePrefix,
    claudecodeModels: CFG.claudecodeModels,
    forceModel: CFG.forceModel,
    modelRoutes: CFG.modelRoutes,
    projectRoutes: CFG.projectRoutes,
    projectAccounts: CFG.projectAccounts,
    consumerAccounts: CFG.consumerAccounts,   // legacy alias, same map
    defaultAccount: CFG.defaultAccount,
    projectGroups: CFG.projectGroups,
    projectLimits: CFG.projectLimits,
    projectLimitDefault: CFG.projectLimitDefault,
    cloudPolicy: CFG.cloudPolicy,
    cloudAllowlist: CFG.cloudAllowlist,
    defaultRoute: CFG.defaultRoute,
    jsonEnforce: CFG.jsonEnforce,
    jsonMaxRetries: CFG.jsonMaxRetries,
    requireProject: CFG.requireProject,
    requireRegisteredConsumer: CFG.requireRegisteredConsumer,
    // Redacted: the entry carries key HASHES, and adminState is the broadest thing this API returns.
    // A sha256 of 32 random bytes is not worth cracking, but it is a credential derivative and it has
    // no business in a dashboard payload. `activeKeys` is all the UI needs from here.
    consumers: Object.fromEntries(Object.entries(CFG.consumers || {}).map(([n, e]) =>
      [n, { kind: e.kind, owner: e.owner, note: e.note, activeKeys: (e.keys || []).filter((k) => !k.revoked).length }])),
    authMode: (CFG.auth && CFG.auth.mode) || "optional",
    logging: CFG.logging,
    loggingDbReady: dbUp(),
    // secrets — never returned in clear
    crazyrouterKeySet: !!CFG.crazyrouterKey, crazyrouterKeyMasked: mask(CFG.crazyrouterKey),
    // Each account carries its harvested headroom AND the age of that reading, so any consumer
    // (admin UI, statusline) can render "hot/cool" together with "as of when" — never a stale
    // number presented as fresh. `stale:true` = no reading in 6h; show it as unknown, not cool.
    claudecodeAccountPool: (CFG.claudecodeAccountPool || []).map((a) => {
      const h = acctHealth(a.org);
      return { name: a.name, org: a.org, tokenMasked: mask(a.token),
               util: h.util, hot: h.hot, ts: h.ts, stale: h.stale };
    }),
    // No sticky account exists any more: selection is pinned per project (accountFor).
    defaultAccount: CFG.defaultAccount || null,
    oblitTokenSet: !!CFG.oblitToken, oblitTokenMasked: mask(CFG.oblitToken),
    adminPasswordMasked: mask(CFG.adminPassword),
    configFile: CONFIG_FILE,
    configPersisted: fs.existsSync(CONFIG_FILE),
    knownLocalIds: { e4b: E4B, gemma: CANON, obliterated: OBLIT },
  };
}

// Probe one provider's /v1/models. Returns {up, status, ms, count?, error?}.
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
  if (route.provider === "crazyrouter") headers.authorization = `Bearer ${CFG.crazyrouterKey}`;
  else if (route.provider === "local" && isGated(route.target) && CFG.oblitToken) headers.authorization = `Bearer ${CFG.oblitToken}`;
  const sendModel = route.rewriteModel || model;
  const body = { model: sendModel, messages: [{ role: "user", content: prompt || "Reply with a short greeting." }], max_tokens: maxTokens || 256, stream: false };
  const t0 = Date.now();
  try {
    const r = await fetch(route.base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    const m = j && j.choices && j.choices[0] && j.choices[0].message;
    const content = (m && (m.content || m.reasoning_content)) || null;
    return { ok: r.ok, status: r.status, provider: route.provider, sentModel: sendModel, ms: Date.now() - t0, content, raw: content == null ? text.slice(0, 2000) : undefined };
  } catch (e) { return { ok: false, status: 0, provider: route.provider, sentModel: sendModel, ms: Date.now() - t0, error: e.message }; }
}

async function handleAdminApi(req, res, path, prefix = "/admin/api/") {
  const ip = req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const sub = path.slice(prefix.length);

  // login is the only unauthenticated endpoint
  if (sub === "login" && req.method === "POST") {
    if (throttled(ip)) return sendJson(res, 429, { error: "too many attempts, wait a few minutes" });
    const body = await readBody(req);
    let pw = "";
    try { pw = JSON.parse(body.toString()).password || ""; } catch {}
    const ok = pw.length === CFG.adminPassword.length &&
      (() => { try { return crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(CFG.adminPassword)); } catch { return false; } })();
    if (!ok) { console.error(`[admin] bad login ip=${ip}`); return sendJson(res, 401, { error: "wrong password" }); }
    // Path=/ — NOT /admin. The panel is served from the root and calls /api/*, so a cookie scoped
    // to /admin is never sent back and the login silently loops. `Secure` is set unconditionally:
    // prod is always behind TLS, and a cookie that survives plaintext is worse than a local dev
    // annoyance (use SESSION_INSECURE=1 to test over http on localhost).
    const secure = process.env.SESSION_INSECURE === "1" ? "" : " Secure;";
    const cookie = `${COOKIE}=${makeSession()}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}`;
    console.log(`[admin] login ok ip=${ip}`);
    return sendJson(res, 200, { ok: true }, { "set-cookie": cookie });
  }
  if (sub === "logout") {
    const secure = process.env.SESSION_INSECURE === "1" ? "" : " Secure;";
    return sendJson(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0` });
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
    }
    if (patch.localMap) next.localMap = patch.localMap;
    if (patch.gatedModels) next.gatedModels = patch.gatedModels;
    if (typeof (patch.claudePrefix ?? patch.wrappyPrefix) === "string") next.claudePrefix = patch.claudePrefix ?? patch.wrappyPrefix;
    if (Array.isArray(patch.claudecodeModels)) next.claudecodeModels = patch.claudecodeModels;
    if (patch.forceModel) next.forceModel = patch.forceModel;
    if (patch.modelRoutes) next.modelRoutes = patch.modelRoutes;
    if (patch.projectRoutes) next.projectRoutes = patch.projectRoutes;
    if (patch.projectAccounts) next.projectAccounts = patch.projectAccounts;   // project → account PIN
    if (patch.consumerAccounts) next.consumerAccounts = patch.consumerAccounts;  // legacy name for the same
    if (typeof patch.defaultAccount === "string") next.defaultAccount = patch.defaultAccount;
    if (patch.projectGroups) next.projectGroups = patch.projectGroups;
    if (Array.isArray(patch.claudecodeAccountPool)) next.claudecodeAccountPool = patch.claudecodeAccountPool;
    else if (Array.isArray(patch.anthropicPool)) next.claudecodeAccountPool = patch.anthropicPool;   // legacy name
    if (patch.projectLimits) next.projectLimits = patch.projectLimits;
    if (patch.projectLimitDefault) next.projectLimitDefault = patch.projectLimitDefault;
    if (patch.cloudPolicy) next.cloudPolicy = patch.cloudPolicy;
    if (patch.cloudAllowlist) next.cloudAllowlist = patch.cloudAllowlist;
    if (patch.defaultRoute) next.defaultRoute = patch.defaultRoute;
    if (typeof patch.jsonEnforce === "boolean") next.jsonEnforce = patch.jsonEnforce;
    if (patch.jsonMaxRetries !== undefined) next.jsonMaxRetries = patch.jsonMaxRetries;
    if (typeof patch.requireProject === "boolean") next.requireProject = patch.requireProject;
    if (patch.logging && typeof patch.logging === "object") Object.assign(next.logging, patch.logging);
    if (typeof (patch.crazyrouterKey ?? patch.crazyKey) === "string") next.crazyrouterKey = patch.crazyrouterKey ?? patch.crazyKey;
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

  // The Claude catalog as Anthropic reports it, plus when we last asked and via which account.
  // GET is cached (whatever the last refresh found); POST forces a round trip.
  if (sub === "claudecode/models" && (req.method === "GET" || req.method === "POST")) {
    if (req.method === "POST") await refreshClaudecodeModels(`admin ip=${ip}`);
    return sendJson(res, 200, {
      advertised: CFG.claudecodeModels,
      seed: [...CLAUDECODE_MODEL_SEED],
      aliases: [...CLAUDECODE_MODEL_ALIASES],
      source: claudecodeCatalog.source,
      checkedAt: claudecodeCatalog.ts || null,
      sweptAccounts: claudecodeCatalog.accounts || [],
      failedAccounts: claudecodeCatalog.failed || [],
      error: claudecodeCatalog.error,
      // `accounts` = which orgs list this id. An id offered by only some accounts will 404 on the
      // others, so a project pinned to one of those cannot use it however it is advertised.
      models: (claudecodeCatalog.models || []).map((m) => ({ id: m.id, display_name: m.display_name, created_at: m.created_at, accounts: m.accounts || [] })),
    });
  }

  // Which advertised models does an account ACTUALLY serve? The catalog lists every model the org
  // can see; the subscription decides which ones answer. Those disagree — an exhausted Max plan
  // lists Opus and 429s it. Worse, a 429 carries no anthropic-ratelimit-* headers, so the headroom
  // harvest learns nothing from exactly the calls that matter and Accounts renders a cheerful 0%.
  // One max_tokens:1 ping per model is the only honest answer. ~9 pings, a few tokens each.
  if (sub === "claudecode/probe" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch {}
    const pool = CFG.claudecodeAccountPool || [];
    // `all` probes the whole pool. That is |accounts| × |models| pings, so it stays an explicit,
    // operator-initiated action — never a background refresh.
    if (p.all) {
      const out = [];
      for (const a of pool) out.push(await probeAccount(a));   // serial: don't hammer one org's limiter
      return sendJson(res, 200, { accounts: out, checkedAt: Date.now() });
    }
    const acct = p.account ? pool.find((a) => a.name.toLowerCase() === String(p.account).trim().toLowerCase()) : pool[0];
    if (!acct) return sendJson(res, 400, { error: "no such account", accounts: pool.map((a) => a.name) });
    return sendJson(res, 200, await probeAccount(acct));
  }

  // Everything the operator needs to answer "can this account serve anything, and who is spending
  // it". The pool is the spine — an account with no traffic and no probe still gets a row, which is
  // exactly the case the old org-keyed limits table could not represent.
  if (sub === "accounts" && req.method === "GET") {
    const pool = CFG.claudecodeAccountPool || [];
    const pins = CFG.projectAccounts || CFG.consumerAccounts || {};
    const lim = new Map();
    for (const r of await dbRows("SELECT org_id,ts,u5,u7,reset5,reset7,status,s5,s7,project,model,account FROM acct_limits")) {
      lim.set(r.org_id, r);
    }
    // Old rows label the account `anthropic:philip` / `wrappy:philip`; new ones `claudecode:philip`.
    // The name after the colon is the join key, so every era of the log counts toward the same account.
    const spendRows = await dbRows(
      `SELECT split_part(key_label, ':', 2) AS acct,
         COUNT(*)::int AS calls, COALESCE(SUM(total_tokens),0)::bigint AS tokens, MAX(ts) AS last_ts,
         COUNT(*) FILTER (WHERE status = 429)::int AS rate_limited,
         COUNT(*) FILTER (WHERE status >= 400)::int AS errors
       FROM calls WHERE key_label LIKE '%:%' GROUP BY 1`);
    const spend = new Map(spendRows.map((r) => [String(r.acct), r]));
    const dayAgo = Date.now() - 86400000;
    const spend24Rows = await dbRows(
      `SELECT split_part(key_label, ':', 2) AS acct, COUNT(*)::int AS calls,
         COALESCE(SUM(total_tokens),0)::bigint AS tokens
       FROM calls WHERE key_label LIKE '%:%' AND ts >= $1 GROUP BY 1`, [dayAgo]);
    const spend24 = new Map(spend24Rows.map((r) => [String(r.acct), r]));

    const accounts = pool.map((a) => {
      const org = ORG_OF_ACCOUNT.get(a.name) || null;
      const l = org ? lim.get(org) : null;
      const s = spend.get(a.name) || {}, s24 = spend24.get(a.name) || {};
      const pr = PROBE_CACHE.get(a.name) || null;
      return {
        name: a.name, org,
        projects: Object.keys(pins).filter((p) => pins[p] === a.name).sort(),
        limits: l ? { ts: Number(l.ts) || 0, u5: l.u5, u7: l.u7, reset5: l.reset5, reset7: l.reset7,
          status: l.status, s5: l.s5, s7: l.s7, lastProject: l.project, lastModel: l.model } : null,
        usage: { calls: s.calls || 0, tokens: Number(s.tokens) || 0, lastTs: Number(s.last_ts) || 0,
          rateLimited: s.rate_limited || 0, errors: s.errors || 0,
          calls24h: s24.calls || 0, tokens24h: Number(s24.tokens) || 0 },
        probe: pr ? { checkedAt: pr.checkedAt, usable: pr.usable, total: pr.results.length } : null,
      };
    });
    return sendJson(res, 200, {
      accounts, now: Date.now(), defaultAccount: CFG.defaultAccount || "",
      advertisedModels: (CFG.claudecodeModels || []).length,
      // A pinned project naming an account that no longer exists in the pool 403s at request time.
      orphanPins: Object.entries(pins).filter(([, acc]) => !pool.some((a) => a.name === acc)).map(([p, acc]) => ({ project: p, account: acc })),
    });
  }

  // Pin / unpin ONE project without resending the whole map. `POST config` assigns
  // projectAccounts wholesale, so a caller that sends {bluebut:"x"} silently deletes every other
  // pin. This endpoint is the safe door: it merges, and it refuses an unknown account outright
  // rather than writing a pin that resolves to nothing and 403s at request time.
  if (sub === "pins" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const project = String(p.project || "").trim().toLowerCase();
    if (!project) return sendJson(res, 400, { error: "project required" });
    const pins = { ...(CFG.projectAccounts || CFG.consumerAccounts || {}) };
    if (p.account === null || p.account === "") {
      delete pins[project];
    } else {
      const account = String(p.account || "").trim();
      const known = (CFG.claudecodeAccountPool || []).some((a) => a.name.toLowerCase() === account.toLowerCase());
      if (!known) return sendJson(res, 400, { error: `unknown account '${account}'`, accounts: (CFG.claudecodeAccountPool || []).map((a) => a.name) });
      pins[project] = account;
    }
    CFG.projectAccounts = pins;
    CFG.consumerAccounts = pins;
    const persisted = persistConfig();
    console.log(`[admin] pin ${project} -> ${pins[project] || "(removed)"} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, projectAccounts: pins });
  }

  // ── consumer registry ──
  // The registry, plus every consumer the log has SEEN that is not in it. That second list is the
  // work queue: it is what would start 403'ing the moment requireRegisteredConsumer is turned on.
  if (sub === "consumers" && req.method === "GET") {
    const reg = CFG.consumers || {};
    const seen = await dbRows(
      `SELECT split_part(project, ':', 1) AS consumer, COUNT(*)::int AS calls,
         COALESCE(SUM(total_tokens),0)::bigint AS tokens, MAX(ts) AS last_ts,
         COUNT(DISTINCT NULLIF(split_part(project, ':', 2), ''))::int AS jobs
       FROM calls WHERE project IS NOT NULL AND project <> '' GROUP BY 1 ORDER BY 2 DESC`);
    const known = new Set(Object.keys(reg));
    const registered = Object.entries(reg).map(([name, e]) => {
      const s = seen.find((r) => r.consumer === name);
      // Never ship the hash. `id` is public by design — it is the half of the key that is not secret.
      const keys = (e.keys || []).map((k) => ({ id: k.id, created: k.created, lastUsed: k.lastUsed, revoked: !!k.revoked, note: k.note }));
      return { name, kind: e.kind, owner: e.owner, note: e.note, keys,
        activeKeys: keys.filter((k) => !k.revoked).length,
        calls: s ? s.calls : 0, tokens: s ? Number(s.tokens) : 0,
        jobs: s ? s.jobs : 0, lastTs: s ? Number(s.last_ts) : 0 };
    }).sort((a, b) => b.calls - a.calls);
    const unregistered = seen.filter((r) => r.consumer && !known.has(r.consumer))
      .map((r) => ({ name: r.consumer, calls: r.calls, tokens: Number(r.tokens), jobs: r.jobs, lastTs: Number(r.last_ts) }));
    return sendJson(res, 200, {
      registered, unregistered, enforcing: !!CFG.requireRegisteredConsumer,
      authMode: (CFG.auth && CFG.auth.mode) || "optional",
      // Flipping auth to "required" 401s every consumer holding no key. Name them, so the panel can
      // refuse to do it blind rather than discovering it from the error rate.
      keyless: registered.filter((c) => !c.activeKeys).map((c) => c.name),
      owners: [...new Set(Object.values(reg).filter((e) => e.owner).map((e) => e.owner))].sort(),
    });
  }

  // Merge one entry. Like `pins`, and for the same reason: `POST config` assigns `consumers`
  // wholesale, so sending one registration from a stale render would delete every other one.
  if (sub === "consumers" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const name = String(p.name || "").trim().toLowerCase();
    if (!name) return sendJson(res, 400, { error: "name required" });
    if (name.includes(":")) return sendJson(res, 400, { error: "register the consumer, not the job — drop everything after the ':'" });
    const reg = { ...(CFG.consumers || {}) };
    if (p.remove) {
      delete reg[name];
    } else {
      if (p.kind !== "dev" && p.kind !== "app") return sendJson(res, 400, { error: "kind must be 'dev' or 'app'" });
      const e = { kind: p.kind };
      if (p.kind === "dev") {
        const owner = String(p.owner || "").trim().toLowerCase();
        if (!owner) return sendJson(res, 400, { error: "a dev consumer is someone's machine — owner required" });
        e.owner = owner;
      }
      // Silently dropping an owner sent for an app would look like it saved. Say no instead.
      if (p.kind === "app" && String(p.owner || "").trim()) return sendJson(res, 400, { error: "an app has no owner" });
      if (typeof p.note === "string" && p.note.trim()) e.note = p.note.trim();
      reg[name] = e;
    }
    CFG.consumers = reg;
    const persisted = persistConfig();
    console.log(`[admin] consumer ${name} -> ${p.remove ? "(removed)" : reg[name].kind + (reg[name].owner ? "/" + reg[name].owner : "")} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, consumers: reg });
  }

  // Issue a key. This IS the registration step: one call creates the consumer if it does not exist
  // and hands back the only copy of the secret. Two steps (register, then separately authenticate)
  // is what let a self-asserted header masquerade as identity in the first place.
  // The plaintext is returned ONCE and never stored — only its sha256 lands in config.json.
  if (sub === "consumers/keys" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const name = String(p.name || "").trim().toLowerCase();
    if (!name) return sendJson(res, 400, { error: "name required" });
    if (name.includes(":")) return sendJson(res, 400, { error: "keys belong to a consumer, not a job — drop everything after the ':'" });
    const reg = { ...(CFG.consumers || {}) };
    let e = reg[name];
    if (!e) {
      if (p.kind !== "dev" && p.kind !== "app") return sendJson(res, 400, { error: `"${name}" is new — say kind:"dev" or kind:"app" to create it`, kinds: ["dev", "app"] });
      if (p.kind === "dev" && !String(p.owner || "").trim()) return sendJson(res, 400, { error: "a dev consumer is someone's machine — owner required" });
      if (p.kind === "app" && String(p.owner || "").trim()) return sendJson(res, 400, { error: "an app has no owner" });
      e = { kind: p.kind, keys: [] };
      if (p.kind === "dev") e.owner = String(p.owner).trim().toLowerCase();
    }
    const k = mintKey();
    e.keys = [...(e.keys || []), { id: k.id, hash: sha256(k.secret), created: Date.now(), lastUsed: 0, revoked: false, note: (p.note || "").trim() || undefined }];
    reg[name] = e;
    CFG.consumers = reg;
    const persisted = persistConfig();   // also reindexes
    console.log(`[admin] key issued ${name} id=${k.id} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, {
      ok: true, persisted, consumer: name, kind: e.kind, keyId: k.id, key: k.raw,
      warning: "this is the only time the key is shown — store it in keyvault now",
    });
  }

  // Revoke one key. The consumer, its pins and its history survive; only this credential dies.
  if (sub === "consumers/keys/revoke" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const name = String(p.name || "").trim().toLowerCase(), id = String(p.id || "").trim();
    const reg = { ...(CFG.consumers || {}) };
    const e = reg[name];
    if (!e) return sendJson(res, 404, { error: `unknown consumer '${name}'` });
    const k = (e.keys || []).find((x) => x.id === id);
    if (!k) return sendJson(res, 404, { error: `unknown key '${id}'` });
    k.revoked = true; k.revokedAt = Date.now();
    CFG.consumers = reg;
    const persisted = persistConfig();
    console.warn(`[admin] key REVOKED ${name} id=${id} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted });
  }

  // Auth mode. Separate + logged, like `consumers/enforce`: going to "required" 401s every caller
  // that has not been issued a key, so the panel refuses to do it blind.
  if (sub === "auth" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    if (!["off", "optional", "required"].includes(p.mode)) return sendJson(res, 400, { error: "mode must be off | optional | required" });
    CFG.auth = { mode: p.mode };
    const persisted = persistConfig();
    console.warn(`[admin] auth.mode=${p.mode} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, mode: p.mode });
  }

  // Turn the gate on/off. Separate from `config` so it is a deliberate, logged act — flipping it on
  // with an unseeded registry is an instant outage for every caller not yet registered.
  if (sub === "consumers/enforce" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    CFG.requireRegisteredConsumer = !!p.enabled;
    const persisted = persistConfig();
    console.warn(`[admin] requireRegisteredConsumer=${CFG.requireRegisteredConsumer} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, enforcing: CFG.requireRegisteredConsumer });
  }

  // ── consumption rollups: kind → owner → consumer → job, plus account×kind ──
  // Grouping happens in JS, not SQL: the registry lives in CFG, and a 26-row group-by is cheaper to
  // ship whole than to join against a config file.
  if (sub === "usage" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 200, { dbReady: false });
    const q = url.parse(req.url, true).query;
    const WIN = { "1h": 36e5, "24h": 864e5, "7d": 6048e5, "30d": 2592e6 };
    const win = WIN[q.win] ? q.win : "24h";
    const since = Date.now() - WIN[win];
    const rows = await dbRows(
      `SELECT project, split_part(key_label, ':', 2) AS acct, provider,
         COUNT(*)::int AS calls, COALESCE(SUM(total_tokens),0)::bigint AS tokens,
         COUNT(*) FILTER (WHERE status >= 400)::int AS errors
       FROM calls WHERE ts >= $1 AND project IS NOT NULL AND project <> '' GROUP BY 1,2,3`, [since]);
    const reg = CFG.consumers || {};
    const add = (m, k, r) => {
      const e = m.get(k) || { calls: 0, tokens: 0, errors: 0 };
      e.calls += r.calls; e.tokens += Number(r.tokens); e.errors += r.errors; m.set(k, e);
    };
    const byKind = new Map(), byOwner = new Map(), byConsumer = new Map(), byAcctKind = new Map();
    const jobsOf = new Map();
    for (const r of rows) {
      const { consumer, job } = parseConsumer(r.project);
      const e = reg[consumer];
      // An unregistered consumer is its own bucket. Folding it into "app" would be a guess, and the
      // whole point of the registry is that we stop guessing.
      const kind = e ? e.kind : "unregistered";
      add(byKind, kind, r);
      if (kind === "dev" && e.owner) add(byOwner, e.owner, r);
      add(byConsumer, consumer, r);
      if (r.acct) add(byAcctKind, `${r.acct}|${kind}`, r);
      if (job) { if (!jobsOf.has(consumer)) jobsOf.set(consumer, new Map()); add(jobsOf.get(consumer), job, r); }
    }
    const out = (m) => [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.tokens - a.tokens);
    return sendJson(res, 200, {
      dbReady: true, win, since,
      byKind: out(byKind), byOwner: out(byOwner),
      byConsumer: out(byConsumer).map((c) => ({
        ...c, kind: reg[c.key] ? reg[c.key].kind : "unregistered",
        owner: reg[c.key] && reg[c.key].owner || null,
        jobs: jobsOf.has(c.key) ? out(jobsOf.get(c.key)) : [],
      })),
      byAccountKind: out(byAcctKind).map((r) => { const [account, kind] = r.key.split("|"); return { account, kind, calls: r.calls, tokens: r.tokens, errors: r.errors }; }),
    });
  }

  if (sub === "health" && req.method === "GET") {
    const [local, crazyrouter] = await Promise.all([
      probe(CFG.bases.local), probe(CFG.bases.crazyrouter, CFG.crazyrouterKey),
    ]);
    return sendJson(res, 200, { local, crazyrouter, claudecode: { ok: (CFG.claudecodeAccountPool || []).length > 0, accounts: (CFG.claudecodeAccountPool || []).length } });
  }

  if (sub === "models" && req.method === "GET") {
    const { claudecode, crazyrouter } = await upstreamCatalogs();
    return sendJson(res, 200, { local: localModelEntries(), claudecode, crazyrouter });
  }

  // Latest per-account rate-limit snapshot harvested off real traffic (zero-token; see recordLimits).
  // One row per anthropic org-id with live 5h/7d utilization + reset + status. Dashboards read this
  // instead of probing. Rows go stale for accounts with no recent traffic (ts shows how fresh).
  if (sub === "limits" && req.method === "GET") {
    const rows = await dbRows("SELECT org_id,ts,u5,u7,reset5,reset7,status,s5,s7,project,model FROM acct_limits ORDER BY ts DESC");
    return sendJson(res, 200, { rows, now: Date.now() });
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
    const r = resolveRoute(p.model, p.project);
    const sent = r.rewriteModel || (r.provider === "local" ? r.target : p.model) || p.model || "";
    const gated = r.provider === "local" && isGated(r.target) && !!CFG.oblitToken;
    return sendJson(res, 200, {
      input: p.model || "", project: p.project || "", provider: r.provider, sentModel: sent, reason: r.reason || "",
      blocked: !!r.blocked, why: r.why, gated,
      base: r.base || (r.provider === "local" ? CFG.bases.local : r.provider === "claudecode" ? CFG.bases.claudecode : r.provider === "crazyrouter" ? CFG.bases.crazyrouter : ""),
    });
  }

  // ── call log ──
  if (sub === "calls" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 200, { rows: [], total: 0, dbReady: false });
    const q = url.parse(req.url, true).query;
    const where = [], params = [];
    const ph = (v) => { params.push(v); return `$${params.length}`; };   // positional, in push order
    if (q.provider) where.push(`provider = ${ph(String(q.provider))}`);
    if (q.model) where.push(`req_model = ${ph(String(q.model))}`);
    if (q.key) where.push(`key_label = ${ph(String(q.key))}`);
    if (q.project) where.push(q.project === "(none)" ? "(project IS NULL OR project = '')" : `project = ${ph(String(q.project).toLowerCase())}`);
    if (q.status === "error") where.push("status >= 400");
    else if (q.status === "ok") where.push("status < 400");
    else if (q.status) where.push(`status = ${ph(parseInt(q.status, 10))}`);
    if (q.since) where.push(`ts >= ${ph(parseInt(q.since, 10))}`);
    // Tri-state facets. "" = don't filter; the columns are nullable, so the negative
    // arm must spell out IS NULL or it silently drops every un-stamped row.
    if (q.effort === "(none)") where.push("(effort IS NULL OR effort = '')");
    else if (q.effort) where.push(`effort = ${ph(String(q.effort))}`);
    if (q.stream === "1") where.push("stream = true");
    else if (q.stream === "0") where.push("(stream IS NULL OR stream = false)");
    if (q.thinking === "1") where.push("thinking_tokens > 0");
    else if (q.thinking === "0") where.push("(thinking_tokens IS NULL OR thinking_tokens = 0)");
    if (q.tools === "1") where.push("tool_count > 0");
    else if (q.tools === "0") where.push("(tool_count IS NULL OR tool_count = 0)");
    if (q.cached === "1") where.push("cache_read > 0");
    else if (q.cached === "0") where.push("(cache_read IS NULL OR cache_read = 0)");
    if (q.client) where.push(`ua ILIKE ${ph("%" + String(q.client) + "%")}`);
    if (q.stop) where.push(`stop_reason = ${ph(String(q.stop))}`);
    if (q.minTok) where.push(`total_tokens >= ${ph(parseInt(q.minTok, 10))}`);
    if (q.minMs) where.push(`duration_ms >= ${ph(parseInt(q.minMs, 10))}`);
    // Live-tail cursor: only rows newer than what the client already holds. `total` then
    // means "new since afterId", not "matching overall" — the SPA adds it to its own count.
    if (q.afterId) where.push(`id > ${ph(parseInt(q.afterId, 10))}`);
    if (q.q) {
      const like = ph("%" + String(q.q) + "%");   // one placeholder, reused across the OR
      where.push(`(req_model ILIKE ${like} OR sent_model ILIKE ${like} OR ip ILIKE ${like}
        OR ua ILIKE ${like} OR req_content ILIKE ${like} OR resp_content ILIKE ${like})`);
    }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.min(parseInt(q.limit, 10) || 100, 500);
    const offset = parseInt(q.offset, 10) || 0;
    const totalRow = await dbRow(`SELECT COUNT(*)::int AS n FROM calls ${w}`, params);
    // List view: omit big content blobs; send short previews instead.
    const rows = await dbRows(`SELECT id,ts,ip,ua,method,path,req_model,provider,sent_model,key_label,status,duration_ms,stream,
      prompt_tokens,completion_tokens,total_tokens,error,project,effort,thinking_tokens,max_tokens,temperature,
      user_id,cache_read,cache_write,stop_reason,
      tool_count,mcp_tools,tool_servers,tools_kb,msg_count,system_kb,
      left(req_content,160) AS req_preview, left(resp_content,200) AS resp_preview
      FROM calls ${w} ORDER BY id DESC LIMIT ${ph(limit)} OFFSET ${ph(offset)}`, params);
    return sendJson(res, 200, { rows, total: totalRow ? totalRow.n : 0, limit, offset, dbReady: true });
  }
  // Distinct values behind the filter dropdowns. Five sequential scans over `calls`, so it is
  // cached — the panel refetches it on every mount and the live tail must not pay for it.
  if (sub === "calls/facets" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 200, { projects: [], models: [], keys: [], efforts: [], clients: [], stops: [] });
    if (FACET_CACHE.at && Date.now() - FACET_CACHE.at < 30000) return sendJson(res, 200, FACET_CACHE.val);
    const col = async (expr, extra = "") => (await dbRows(
      `SELECT ${expr} AS v, COUNT(*)::int AS n FROM calls WHERE ${expr} IS NOT NULL AND ${expr}::text <> '' ${extra}
       GROUP BY 1 ORDER BY n DESC LIMIT 60`)).map((r) => ({ v: String(r.v), n: r.n }));
    const val = {
      projects: await col("project"), models: await col("req_model"), keys: await col("key_label"),
      efforts: await col("effort"), stops: await col("stop_reason"),
      // UA strings are unbounded; the leading token is the client name and that is all we filter on.
      clients: await col("split_part(ua, '/', 1)"),
    };
    FACET_CACHE.at = Date.now(); FACET_CACHE.val = val;
    return sendJson(res, 200, val);
  }
  if (sub === "call" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 404, { error: "no db" });
    const q = url.parse(req.url, true).query;
    const id = parseInt(q.id, 10);
    if (!id) return sendJson(res, 400, { error: "id required" });
    const row = await dbRow("SELECT * FROM calls WHERE id = $1", [id]);
    return row ? sendJson(res, 200, row) : sendJson(res, 404, { error: "not found" });
  }
  // (Removed 2026-07-09: the per-conversation view. It grouped the log by Claude session_id, which
  // only ever existed for Claude Code traffic, and answered a question nobody asked. The columns it
  // read — msg_count, tool_count, tools_kb, cache_read — are still recorded and still surfaced per
  // call in the Calls tab. Consumption now rolls up by consumer, not by chat: see `usage`.)

  // Full-content export. Cursor by id, ascending: page id>after until fewer than `limit` return.
  // Returns FULL req_content/resp_content (unlike `calls`, which previews). SELECT * on purpose —
  // an explicit column list silently drops whatever was added to the table since it was written.
  if (sub === "export" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 404, { error: "no db" });
    const q = url.parse(req.url, true).query;
    const after = parseInt(q.after, 10) || 0;
    const limit = Math.min(parseInt(q.limit, 10) || 500, 2000);
    const rows = await dbRows("SELECT * FROM calls WHERE id > $1 ORDER BY id ASC LIMIT $2", [after, limit]);
    const maxId = rows.length ? rows[rows.length - 1].id : after;
    return sendJson(res, 200, { rows, count: rows.length, after, maxId, limit });
  }
  if (sub === "stats" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 200, { dbReady: false });
    try {
      const q = url.parse(req.url, true).query;
      // time window: '15m','1h','6h','24h','7d','30d' or 'all'. Default 24h.
      const WINDOWS = { "15m": 900000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
      const winKey = (q.window in WINDOWS || q.window === "all") ? q.window : "24h";
      const since = winKey === "all" ? 0 : Date.now() - WINDOWS[winKey];
      const W = "ts >= $1"; const P = [since];
      // One scan for the window scalars instead of six. Postgres counts `FILTER (WHERE …)` in the
      // same pass, and this table is now big enough that six separate seq scans is the slow path.
      const agg = await dbRow(`SELECT
          COUNT(*)::int AS calls,
          COUNT(*) FILTER (WHERE status >= 400)::int AS errors,
          COUNT(*) FILTER (WHERE error LIKE 'json_validation_failed%')::int AS json_fails,
          COALESCE(SUM(total_tokens),0) AS tokens,
          COALESCE(SUM(prompt_tokens),0) AS ptok,
          COALESCE(SUM(completion_tokens),0) AS ctok
        FROM calls WHERE ${W}`, P) || {};
      const totalRow = await dbRow("SELECT COUNT(*)::int AS n FROM calls");
      const byProvider = await dbRows(`SELECT provider, COUNT(*)::int AS n, COALESCE(SUM(total_tokens),0) AS tok,
        ROUND(AVG(duration_ms)) AS avg_ms, COUNT(*) FILTER (WHERE status>=400)::int AS errors
        FROM calls WHERE ${W} GROUP BY provider ORDER BY n DESC`, P);
      const byKey = await dbRows(`SELECT key_label, COUNT(*)::int AS n FROM calls WHERE ${W} GROUP BY key_label ORDER BY n DESC`, P);
      // By client (user-agent) — surfaces who's calling. thinkers = calls that sent extended thinking
      // or a reasoning_effort, so you can spot reasoning traffic per client at a glance.
      // string_agg replaces SQLite's GROUP_CONCAT, which does not exist here.
      const byClient = await dbRows(`SELECT COALESCE(NULLIF(ua,''),'(none)') AS ua, COUNT(*)::int AS n,
        COALESCE(SUM(total_tokens),0) AS tok, MAX(ts) AS last, COUNT(DISTINCT ip)::int AS ips,
        COUNT(*) FILTER (WHERE effort IS NOT NULL OR thinking_tokens > 0)::int AS thinkers,
        string_agg(DISTINCT provider, ',') AS providers
        FROM calls WHERE ${W} GROUP BY 1 ORDER BY n DESC LIMIT 40`, P);
      // MAX(provider): Postgres will not let a bare column ride along outside GROUP BY the way
      // SQLite does. One row per model is the shape the UI wants, so collapse provider explicitly.
      const byModel = await dbRows(`SELECT req_model, MAX(provider) AS provider, COUNT(*)::int AS n,
        COALESCE(SUM(total_tokens),0) AS tok,
        COALESCE(SUM(prompt_tokens),0) AS ptok, COALESCE(SUM(completion_tokens),0) AS ctok, ROUND(AVG(duration_ms)) AS avg_ms
        FROM calls WHERE ${W} GROUP BY req_model ORDER BY tok DESC LIMIT 40`, P);
      const byProject = await dbRows(`SELECT COALESCE(NULLIF(project,''),'(none)') AS project, COUNT(*)::int AS n,
        COALESCE(SUM(total_tokens),0) AS tok, COALESCE(SUM(prompt_tokens),0) AS ptok, COALESCE(SUM(completion_tokens),0) AS ctok,
        ROUND(AVG(duration_ms)) AS avg_ms, COUNT(*) FILTER (WHERE status>=400)::int AS errors,
        MAX(ts) AS last, COUNT(DISTINCT req_model)::int AS models, string_agg(DISTINCT provider, ',') AS providers
        FROM calls WHERE ${W} GROUP BY 1 ORDER BY tok DESC LIMIT 60`, P);
      // Cost estimate: group by (project, sent_model, provider) to price each cohort, then fold into project/model.
      const prices = priceMap();
      const costRows = await dbRows(`SELECT COALESCE(NULLIF(project,''),'(none)') AS project, req_model, sent_model, provider,
        COALESCE(SUM(prompt_tokens),0) AS ptok, COALESCE(SUM(completion_tokens),0) AS ctok
        FROM calls WHERE ${W} GROUP BY 1, sent_model, req_model, provider`, P);
      let windowCost = 0; const costByProject = {}, costByModel = {};
      for (const r of costRows) {
        const c = costUsd(prices, r.sent_model, r.provider, r.ptok, r.ctok);
        windowCost += c;
        costByProject[r.project] = (costByProject[r.project] || 0) + c;
        costByModel[r.req_model] = (costByModel[r.req_model] || 0) + c;
      }
      for (const r of byProject) {
        r.usd = +(costByProject[r.project] || 0).toFixed(4);
        // attach the effective limit + live usage% over the limit's own window (not the stats window)
        const lim = r.project && r.project !== "(none)" ? limitFor(r.project) : null;
        if (lim) {
          const u = await projectUsage(r.project, WINDOW_MS[lim.window] || WINDOW_MS["24h"]);
          const pt = lim.tokens > 0 ? u.tokens / lim.tokens : 0, pc = lim.calls > 0 ? u.calls / lim.calls : 0;
          r.limit = { window: lim.window, tokens: lim.tokens, calls: lim.calls, hard: lim.hard, warnPct: lim.warnPct, slowPct: lim.slowPct };
          r.limitUsed = { tokens: u.tokens, calls: u.calls };
          r.limitPct = +(Math.max(pt, pc) * 100).toFixed(1);
        }
      }
      byModel.forEach((r) => { r.usd = +(costByModel[r.req_model] || 0).toFixed(4); });
      const oldestRow = await dbRow("SELECT MIN(ts) AS t FROM calls");
      return sendJson(res, 200, { dbReady: true, window: winKey, total: totalRow ? totalRow.n : 0,
        windowCalls: agg.calls || 0, windowErrors: agg.errors || 0, windowTokens: agg.tokens || 0,
        windowPromptTokens: agg.ptok || 0, windowCompletionTokens: agg.ctok || 0, windowJsonFails: agg.json_fails || 0,
        windowCost: +windowCost.toFixed(4),
        pricedProviders: ["crazyrouter"], byProvider, byKey, byClient, byModel, byProject,
        oldest: oldestRow ? oldestRow.t : null, retain: CFG.logging.retain });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // ── time-series history (tokens / calls / errors over time, grouped) ──
  // ?window=…&by=provider|project|model. Buckets auto-sized to ~60 points across the
  // window. Returns top series by total tokens (rest folded into "other").
  if (sub === "series" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 200, { dbReady: false });
    try {
      const q = url.parse(req.url, true).query;
      const WINDOWS = { "15m": 900000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
      const winKey = (q.window in WINDOWS || q.window === "all") ? q.window : "24h";
      const by = ["provider", "project", "model"].includes(q.by) ? q.by : "provider";
      const groupCol = by === "provider" ? "provider" : by === "model" ? "req_model" : "COALESCE(NULLIF(project,''),'(none)')";
      const oldestRow = await dbRow("SELECT MIN(ts) AS t FROM calls");
      const oldest = (oldestRow && oldestRow.t) || Date.now();
      const span = winKey === "all" ? Math.max(60000, Date.now() - oldest) : WINDOWS[winKey];
      const since = winKey === "all" ? oldest : Date.now() - span;
      // bucket width: aim for ~60 buckets, snapped to a sane floor of 1 minute.
      // bucketMs is derived here, never caller-supplied, so interpolating it is not an injection path.
      const bucketMs = Math.max(60000, Math.round(span / 60 / 60000) * 60000);
      const rows = await dbRows(`SELECT (ts/${bucketMs}) AS b, ${groupCol} AS g,
        COUNT(*)::int AS n, COALESCE(SUM(total_tokens),0) AS tok,
        COUNT(*) FILTER (WHERE status>=400)::int AS err
        FROM calls WHERE ts >= $1 GROUP BY b, g`, [since]);
      // top-8 series by total tokens; everything else → "other".
      const totals = {}; for (const r of rows) totals[r.g] = (totals[r.g] || 0) + r.tok;
      const top = Object.entries(totals).sort((a, b2) => b2[1] - a[1]).slice(0, 8).map(([k]) => k);
      const topSet = new Set(top); const hasOther = Object.keys(totals).length > top.length;
      const series = hasOther ? [...top, "other"] : top;
      const points = new Map(); // bucketStart -> {t, tok:{}, n:{}, totalTok, totalN, totalErr}
      for (const r of rows) {
        const t = r.b * bucketMs;
        let p = points.get(t);
        if (!p) { p = { t, tok: {}, n: {}, totalTok: 0, totalN: 0, totalErr: 0 }; points.set(t, p); }
        const key = topSet.has(r.g) ? r.g : "other";
        p.tok[key] = (p.tok[key] || 0) + r.tok; p.n[key] = (p.n[key] || 0) + r.n;
        p.totalTok += r.tok; p.totalN += r.n; p.totalErr += r.err;
      }
      const out = [...points.values()].sort((a, b2) => a.t - b2.t);
      return sendJson(res, 200, { dbReady: true, window: winKey, by, bucketMs, since, series, points: out });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  if (sub === "calls/clear" && req.method === "POST") {
    if (!dbUp()) return sendJson(res, 200, { ok: true, dbReady: false });
    try {
      await pool.query("DELETE FROM calls");
      console.log(`[admin] call log cleared ip=${ip}`);
      return sendJson(res, 200, { ok: true });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  return sendJson(res, 404, { error: "unknown admin endpoint" });
}

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
