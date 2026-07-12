// Live routing config: env defaults, overlaid with /data/config.json on a persistent volume.
//
// CFG is MUTATED IN PLACE, never reassigned. Every module holds the same object reference, so a
// reassignment here would leave the rest of the router reading a detached copy of the old config —
// the admin panel would save, report success, and change nothing. setCFG() swaps the contents.
const fs = require("node:fs");
const path = require("node:path");

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
// 404s while the undated `claude-opus-4-8` serves. The mapping is not mechanical — verify a new id
// with a single native `/v1/messages` call before adding one (a 404 advertises a model that does
// not exist; a 429 means it exists and the subscription's usage window is spent).
const CLAUDECODE_MODEL_ALIASES = Object.freeze([
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
]);
const CLAUDECODE_MODEL_REFRESH_MS = 6 * 3600 * 1000;
// Client-side routes of the control panel (its NAV slugs). Kept in sync with admin/index.html by
// hand — a missing entry only costs a hard-refresh 404 on that tab, never a mis-served API path.
const UI_ROUTES = new Set(["/overview", "/calls", "/routing", "/identity", "/settings",
  // Legacy slugs from before the 2026-07-12 five-page consolidation. The panel redirects each onto
  // its new page + tab; the server just has to keep serving the shell on a hard refresh.
  "/consumers", "/stats", "/accounts", "/models", "/crazyrouter", "/secrets"].map((s) => s));
const CONFIG_FILE = process.env.CONFIG_FILE || "/data/config.json";

// Default local model ids (env-overridable). "local" -> small multimodal E4B; "gemma" -> 26B MoE;
// "obliterated" -> Qwen3.6-27B abliterated.
const CANON = process.env.LOCAL_MODEL || "google/gemma-4-26b-a4b";
const OBLIT = process.env.LOCAL_MODEL_2 || "qwen3.6-27b-obliterated";
const E4B = process.env.LOCAL_MODEL_3 || "gemma-4-e4b-it-obliterated";

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
//
// The upstream answers to TWO ids — `imagegen` and `sd-turbo` — and every one of them must be barred
// from the text endpoints, or it drops through the whole resolver into crazyrouter, the only provider
// that bills per token. Listing just the first one is how `sd-turbo` kept knocking on the paid door.
// (The service's own /health reports `stabilityai/stable-diffusion-xl-base-1.0`: the name is a
// historical label, not the weights. Ask the upstream, don't infer from the id.)
const IMAGE_MODEL_ID = "imagegen";
const IMAGE_MODEL_IDS = [IMAGE_MODEL_ID, "sd-turbo"];
const isImageModel = (m) => IMAGE_MODEL_IDS.includes(String(m || "").toLowerCase());
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

// A project rule carries two INDEPENDENT things, and conflating them is how "pin promopilot to haiku"
// turned into "promopilot may only ever use haiku" by accident:
//   • the PIN     — {provider, model}: what the request is rewritten to, regardless of what it asked for.
//   • the ALLOWLIST — {allowProviders, allowModels}: what the request may resolve to. Never rewrites;
//     only refuses. An empty/absent list means "no restriction", never "nothing allowed" — the
//     alternative would turn a typo'd save into a total outage for that project.
// A rule may have either, both, or neither (neither = drop the entry).
const sanitizeAllow = (v, norm) => {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.filter((x) => typeof x === "string" && x.trim()).map((x) => norm(x.trim())).filter(Boolean))];
  return out.length ? out : undefined;
};
const allowProvidersOf = (v) => sanitizeAllow(v && v.allowProviders, (x) => normProvider(x));
const allowModelsOf = (v) => sanitizeAllow(v && v.allowModels, (x) => x.toLowerCase());
// Normalize one project/group rule. Returns null when it says nothing at all.
function sanitizeRule(v) {
  if (!v || typeof v !== "object") return null;
  const provider = providerOf(v);
  const allowProviders = allowProvidersOf(v);
  const allowModels = allowModelsOf(v);
  if (!provider && !allowProviders && !allowModels) return null;
  return {
    ...(provider ? { provider, model: typeof v.model === "string" ? v.model.trim() : "" } : {}),
    ...(allowProviders ? { allowProviders } : {}),
    ...(allowModels ? { allowModels } : {}),
  };
}

const LIMIT_WINDOWS =["1h", "6h", "24h", "7d", "30d"];
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
    // account is chosen (see accountFor). No headers, no sticky, no rotation. Edit live in the panel.
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
    // Legacy caller name -> canonical `<consumer>[:<job>]`. Lets one machine that has called itself
    // three different things over its life resolve to one consumer, without touching any caller.
    // See normalizeConsumerPath(). Registered consumers must be the CANONICAL names.
    consumerAliases: {},
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

// One object, for the life of the process. Callers hold this reference; see the file header.
const CFG = envDefaults();
// Swap the contents of CFG without breaking anyone's reference to it.
function setCFG(next) {
  for (const k of Object.keys(CFG)) delete CFG[k];
  Object.assign(CFG, next);
  return CFG;
}

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
  if (saved.consumerAliases && typeof saved.consumerAliases === "object" && !Array.isArray(saved.consumerAliases)) {
    c.consumerAliases = {};
    for (const [k, v] of Object.entries(saved.consumerAliases)) {
      const from = String(k || "").trim().toLowerCase(), to = String(v || "").trim().toLowerCase();
      // An alias whose source contains ':' would never match — normalizeConsumerPath keys on the
      // consumer half only. And an alias to itself is a silent infinite no-op; drop both.
      if (from && to && !from.includes(":") && from !== to) c.consumerAliases[from] = to;
    }
  }
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
      const rule = sanitizeRule(v);
      if (rule) pr[k.trim().toLowerCase()] = rule;
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
      const rule = sanitizeRule(g);
      if (rule || limit) pg.push({ name, prefixes, ...(rule || {}), ...(limit ? { limit } : {}) });
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
    setCFG(mergeConfig(base, JSON.parse(raw)));
    console.log(`[cfg] loaded overrides from ${CONFIG_FILE}`);
  } catch (e) {
    setCFG(base);
    if (e.code !== "ENOENT") console.error(`[cfg] load failed (${e.message}); using env defaults`);
  }
  reindexKeys();   // loadConfig replaces CFG's contents, so a stale key index must not survive it
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

// NOTE: loadConfig() is NOT called at module scope. It used to be, which forced KEY_INDEX to be
// declared hundreds of lines from reindexKeys() to dodge its temporal dead zone. server.js calls it
// once at boot instead, so load order is a statement rather than a hazard.

// The key index is config-derived: it maps a public key id to its consumer. Rebuilt on every write
// (persistConfig) so a revoked key can never survive in a stale index.
let KEY_INDEX = new Map();
function reindexKeys() {
  const ix = new Map();
  for (const [consumer, e] of Object.entries(CFG.consumers || {})) {
    for (const k of (e.keys || [])) if (!k.revoked) ix.set(k.id, { consumer, rec: k });
  }
  KEY_INDEX = ix;
}
const keyIndex = () => KEY_INDEX;

module.exports = {
  CFG, setCFG, loadConfig, persistConfig, mergeConfig, envDefaults,
  PROVIDERS, PROVIDER_SET, normProvider, providerOf, sanitizeRule, sanitizeLimit,
  IMAGE_MODEL_ID, IMAGE_MODEL_IDS, isImageModel, LIMIT_WINDOWS, WINDOW_MS,
  CLAUDECODE_MODEL_SEED, CLAUDECODE_MODEL_ALIASES, CLAUDECODE_MODEL_REFRESH_MS,
  CONFIG_FILE, UI_ROUTES, reindexKeys, keyIndex, CANON, OBLIT, E4B,
};
