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
const UI_ROUTES = new Set(["/overview", "/calls", "/routing", "/consumers", "/providers",
  // Legacy slugs from before the 2026-07-12 five-page consolidation and the 2026-07-26 rename
  // (`identity` → `consumers`, `settings` → split across `consumers`/`providers`). The panel
  // redirects each onto its new page + tab; the server just has to keep serving the shell on a
  // hard refresh, or a bookmark 404s instead of landing where it used to.
  "/identity", "/settings", "/stats", "/accounts", "/models", "/crazyrouter", "/secrets"]);
const CONFIG_FILE = process.env.CONFIG_FILE || "/data/config.json";

// The vocabularies and their validators — providers, image ids, limit windows/actions, auth modes,
// and the local lane (CANON, the pbox + ww aliases, their bases, the abliterated ids).
// Re-exported below so every existing caller (and the import guard) still sees them here.
const SCHEMA = require("./config-schema");
const {
  PROVIDERS, PROVIDER_SET, LEGACY_PROVIDER, normProvider, providerOf,
  IMAGE_MODEL_ID, IMAGE_MODEL_IDS, isImageModel,
  IMAGE_TEMPLATE_MODELS, IMAGE_TEMPLATE_SLUG, sanitizeImageTemplate,
  WINDOW_MS, LIMIT_WINDOWS, LIMIT_HARD, AUTH_MODES, ACCOUNT_STRATEGIES,
  sanitizeRule, sanitizeLimit,
  CANON, OBLIT, E4B, LOCAL_MAP_SEED, LOCAL_BASES_SEED,
} = SCHEMA;

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
      // openrouter.ai. The `/api` suffix is load-bearing: their OpenAI surface is at /api/v1/*, and
      // every caller of this base (proxy, the health probe, the catalog refresh) appends "/v1/…".
      // Drop it and each one asks for /v1/chat/completions, which is their marketing site.
      openrouter: (process.env.OPENROUTER_BASE || "https://openrouter.ai/api").replace(/\/$/, ""),
      // freeaiapikey. The `api.` host is load-bearing and NEW: the bare freeaiapikey.com endpoint
      // answers 410 `endpoint_moved` on every path, which reads as a routing bug rather than as a
      // vendor migration. No `/api` suffix here (unlike openrouter) — their OpenAI surface is at
      // /v1/* directly, and native /v1/messages sits beside it on the same host.
      freeaiapikey: (process.env.FREEAIAPIKEY_BASE || "https://api.freeaiapikey.com").replace(/\/$/, ""),
      // groq. The `/openai/v1` surface is theirs; the base stops at `/openai` because every caller
      // of a base here appends "/v1/…". Their native surface at the bare host is NOT OpenAI-shaped,
      // so dropping the suffix does not 404 — it reaches a different API that answers differently,
      // which is the worse failure of the two.
      groq: (process.env.GROQ_BASE || "https://api.groq.com/openai").replace(/\/$/, ""),
      // claudecode → the real Anthropic API, called with a pinned account's Max token. The old
      // old subprocess-wrapper base is GONE.
      claudecode: (process.env.ANTHROPIC_BASE || "https://api.anthropic.com").replace(/\/$/, ""),
      // Image generation. Routed by PATH, never by model name. SANA-Sprint 0.6B on ww's RTX 3070,
      // fronted by the `ww` tunnel. NOT pbox: the old `sdturbo.bofrid.dev` default outlived that
      // move and answers 503, so a boot without IMAGE_BASE aimed every image call at a dead host.
      images: (process.env.IMAGE_BASE || "https://imagegen-ww.hostbun.cc").replace(/\/$/, ""),
    },
    // Who to name as the owner of the image models in /v1/models. A literal is what
    // let "pbox" survive the move to ww for months.
    imageOwner: process.env.IMAGE_OWNER || "home-ww",
    crazyrouterKey: process.env.CRAZYROUTER_KEY || "",
    // openrouter.ai bearer (`sk-or-v1-…`). EMPTY DISABLES THE PROVIDER ENTIRELY — openrouterTarget()
    // claims no id without it, so an unconfigured router routes exactly as it did before this
    // provider existed. That is the point: a half-configured openrouter must not swallow ids that
    // used to reach crazyrouter and answer 401 for them.
    openrouterKey: process.env.OPENROUTER_KEY || "",
    // Only claim ids the catalogue marks FREE (`:free`, or zero prompt AND completion price).
    // On by default because openrouter serves ~330 models on one base URL and ~17 of them are free:
    // with this off, any id in their catalogue routes there and bills the card. An id named
    // explicitly in `openrouterModels` bypasses this — that is an operator decision, not a guess.
    openrouterFreeOnly: process.env.OPENROUTER_FREE_ONLY !== "0",
    // Ids that route to openrouter regardless of what the live catalogue says (and regardless of
    // openrouterFreeOnly). Config, never code (invariant 6). Normally EMPTY: the catalogue refresh
    // in src/openrouter.js is what makes a new free model routable without a config edit.
    openrouterModels: (process.env.OPENROUTER_MODELS || "").split(",").map((x) => x.trim()).filter(Boolean),
    // freeaiapikey bearer (`sk-…`). EMPTY DISABLES THE PROVIDER ENTIRELY, same rule and same reason
    // as openrouterKey: a half-configured reseller must not swallow ids that used to reach
    // crazyrouter and answer 401 for them.
    freeaiapikeyKey: process.env.FREEAIAPIKEY_KEY || "",
    // The ids this provider may claim. There is no free-only guard to lean on here — every id they
    // serve is metered — so THIS LIST IS THE GUARD, and it is why the provider needs no catalogue
    // refresh: an id not written down never routes here. Seeded from their live /v1/models
    // (2026-08-04, ten ids). Config, never code (invariant 6): FREEAIAPIKEY_MODELS or the panel
    // replaces it, and an explicit empty list disables the provider without touching the key.
    //
    // Every id is `vendor/model`, which is what keeps the Max pool safe: `anthropic/claude-opus-5`
    // is a DIFFERENT STRING from `claude-opus-5`, so isClaudeModel() never sees these and the flat
    // subscription cannot leak onto a metered relay. Do not "tidy" the prefixes off.
    freeaiapikeyModels: (process.env.FREEAIAPIKEY_MODELS ||
      "openai/gpt-5.6-sol,openai/gpt-5.5,openai/gpt-5.4,openai/gpt-4o," +
      "anthropic/claude-opus-5,anthropic/claude-opus-4.8,anthropic/claude-opus-4.7," +
      "anthropic/claude-opus-4.6,anthropic/claude-sonnet-5,anthropic/claude-sonnet-4.6"
    ).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
    // groq bearer (`gsk_…`). EMPTY DISABLES THE PROVIDER ENTIRELY, same rule and same reason as
    // openrouterKey and freeaiapikeyKey: a half-configured provider must not swallow ids that used
    // to reach crazyrouter and then answer 401 for them.
    groqKey: process.env.GROQ_KEY || "",
    // The ids this provider may claim. THE WRITTEN LIST IS THE GUARD — same shape as
    // freeaiapikeyModels, opposite reason: there it protects against cost, here against a 404. Groq
    // advertises 15 ids on one base and only some are chat models — whisper-large-v3* transcribe,
    // canopylabs/orpheus-* speak, meta-llama/llama-prompt-guard-2-* are 512-token classifiers — and
    // each would take a /v1/chat/completions call and fail, for an id that would otherwise have
    // reached a provider that answers. So this is the four verified on the real path 2026-08-04 plus
    // gpt-oss-20b (same family and context as the 120b). Check the rest before adding them.
    //
    // Ids are BARE, unlike freeaiapikey's `vendor/model`, so nothing in the STRING keeps the Max pool
    // safe here — branch order does (isClaudeModel runs first). `openai/gpt-oss-*` is also a real
    // openrouter id, which is why groq resolves BEFORE it: see the ordering note in src/routing.js.
    groqModels: (process.env.GROQ_MODELS ||
      "llama-3.1-8b-instant,llama-3.3-70b-versatile,qwen/qwen3.6-27b," +
      "openai/gpt-oss-120b,openai/gpt-oss-20b"
    ).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
    // A SEPARATE crazyrouter key for image templates, because access to the image models is granted
    // per token: the router's own key is valid and still answers "this token does not have access to
    // model gemini-2.5-flash-image". Empty = fall back to crazyrouterKey. Kept apart rather than
    // swapping the main key, which would move every text call onto another account's bill.
    imageTemplateKey: process.env.IMAGE_TEMPLATE_KEY || "",
    // claudecodeAccountPool: our Claude Max logins, [{name, org, token}] with token = sk-ant-oat…
    // (setup-tokens, ~1yr, no refresh). A project is PINNED to one of these (projectAccounts); the
    // gateway never rotates between them. Seed via ANTHROPIC_POOL env or the admin config; tokens
    // are masked in adminState. `anthropicPool` is the old name and is still read.
    claudecodeAccountPool: (() => { try { return JSON.parse(process.env.ANTHROPIC_POOL || "[]"); } catch { return []; } })(),
    // bearer injected toward the image upstream (SD-Turbo API_TOKEN). Empty = send nothing.
    imageToken: process.env.IMAGE_TOKEN || "",
    // imageTemplates: slug → {name, systemInstruction, model, aspectRatio, reference, …}. A reference
    // picture plus a style instruction, rendered by an image-capable crazyrouter model — the SECOND
    // image path, and the only one that costs money (see src/imagetemplates.js). The picture itself
    // is a file on the same volume, named here by filename only. Seeded from assets/image-templates
    // when this is empty, so a fresh volume still ships the templates the repo carries.
    imageTemplates: {},
    // Which model ids that path will render with. Config, never code (invariant 6) — crazyrouter adds
    // image models without asking, and this list is what keeps a TEXT id from reaching a paid upstream
    // through an images endpoint.
    imageTemplateModels: (() => {
      const env = (process.env.IMAGE_TEMPLATE_MODELS || "").split(",").map((x) => x.trim()).filter(Boolean);
      return env.length ? env : [...IMAGE_TEMPLATE_MODELS];
    })(),
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
    // Bearer sent TOWARD the local llama.cpp (its --api-key). Empty = send nothing, the old
    // behaviour where pbox.llm.hostbun.cc answered anyone. Set on both sides or neither.
    localKey: process.env.LOCAL_KEY || "",
    gatedModels: [OBLIT],
    // localMap: alias -> local-model-id (resolves the local provider). Production overrides it from
    // config.json; this seed only decides a cold boot. ⚠ A `projectRoutes` pin's `model` is a
    // literal string and OUTRANKS this map — a checkpoint swap must update both (see CLAUDE.md).
    localMap: { ...LOCAL_MAP_SEED },
    localBases: { ...LOCAL_BASES_SEED },   // per-MODEL override of bases.local; absent id = pbox
    // ── flow control (admin-editable) ──
    // forceModel: when enabled, EVERY request is rewritten to this provider+model regardless of what
    // the caller asked for. The big red switch.
    forceModel: { enabled: false, provider: "claudecode", model: "" },
    // modelRoutes: explicit per-incoming-model overrides to ANY provider (highest priority after
    // forceModel). key = incoming model name (lowercased). value = { provider, model }.
    // Only the ABLITERATED ids are redirected to claudecode: those checkpoints really have no
    // backend. `local`/`gemma`/`google/gemma-4-26b-a4b` were in this list too until 2026-08-02 and
    // should never have outlived the hosted backend's retirement — modelRoutes beats localMap, so
    // they made the free lane resolve to a paid one on any box without a config.json.
    modelRoutes: Object.fromEntries(
      ["gemma-4-e4b-it-obliterated", "obliterated", "obliteratus", "qwen3.6-27b-obliterated"]
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
    // accountStrategy: how the claudecode account is chosen.
    //   "pinned"               — projectAccounts only (the invariant default).
    //   "soonest-weekly-reset" — APP consumers (registry kind "app") are served by the usable
    //                            account whose 7d window resets soonest (autoAccount in routing.js).
    //                            Devs keep their pins; an unregistered/unpinned caller still 403s.
    //   "any-available"        — the same selection, applied to EVERY caller and to callers with no
    //                            pin at all. "Don't make me pick an account": the pool is one shared
    //                            set of our own Max subscriptions, so any usable login serves.
    //                            It waives invariant 3's 403 on purpose — read the note above
    //                            accountFor() in routing.js before turning it on, because it also
    //                            means a DEV session can move between accounts (a prompt-cache miss
    //                            on the box that runs at ~95% cache hits).
    accountStrategy: ACCOUNT_STRATEGIES.includes(process.env.ACCOUNT_STRATEGY) ? process.env.ACCOUNT_STRATEGY : "pinned",
    // ── per-project usage limits (rolling-window quotas) ──
    // projectLimits[<project>] = { window, tokens, calls, warnPct, slowPct, slowMs, hard }
    //   window  rolling count window: 1h|6h|24h|7d|30d (default 24h)
    //   tokens  token cap in window (0 = no token cap)   calls  call cap (0 = none)
    //   warnPct ≥this% of cap → warn (X-Usage-Warning header + log)   default 80
    //   slowPct ≥this% → throttle: sleep slowMs before forwarding      default 95
    //   slowMs  delay added per request while throttling (ms)          default 1500
    //   hard    at ≥100%: "block" (429) | "slow" (keep throttling) | "warn" (never block)
    // An exact projectLimits entry is authoritative (even all-zero = exempt). Else
    // projectLimitDefault (applied to every attributed project when its
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
    // Bumped by POST /api/logout and mixed into the session signature, so a cookie handed back at
    // logout stops authenticating. Sessions are a stateless signed token with no store to revoke
    // from; this is the revocation. It is global — one admin password, so "log out" means all
    // sessions, which is the honest reading of the only logout button there is.
    sessionEpoch: 1,
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
    // `images` too, or the admin POST that sets it reverts on the next restart: saved and ignored.
    const im = pick("images"); if (im) c.bases.images = im;
    const or = pick("openrouter"); if (or) c.bases.openrouter = or;
    const fa = pick("freeaiapikey"); if (fa) c.bases.freeaiapikey = fa;
    const gq = pick("groq"); if (gq) c.bases.groq = gq;
  }
  if (saved.localMap && typeof saved.localMap === "object" && !Array.isArray(saved.localMap)) {
    const m = {};
    for (const [k, v] of Object.entries(saved.localMap)) {
      if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim())
        m[k.trim().toLowerCase()] = v.trim();
    }
    c.localMap = m; // allow an explicit empty map to fully disable the local provider
  }
  if (saved.localBases && typeof saved.localBases === "object" && !Array.isArray(saved.localBases)) {
    const lb = {};
    for (const [k, v] of Object.entries(saved.localBases)) {
      if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim())
        lb[k.trim().toLowerCase()] = v.trim().replace(/\/$/, "");
    }
    c.localBases = lb; // an explicit empty map sends every local id back to the one bases.local
  }
  if (Array.isArray(saved.gatedModels))
    c.gatedModels = saved.gatedModels.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  // Image templates. Validated per entry and keyed on the SANITIZED slug, not on the object key: a
  // saved file whose key and `slug` disagree would otherwise be addressable under one name and
  // rendered under the other. An entry that says nothing (no instruction, no picture) is dropped.
  if (saved.imageTemplates && typeof saved.imageTemplates === "object" && !Array.isArray(saved.imageTemplates)) {
    c.imageTemplates = {};
    for (const [k, v] of Object.entries(saved.imageTemplates)) {
      const t = sanitizeImageTemplate({ slug: k, ...(v && typeof v === "object" ? v : {}) });
      if (t && (t.systemInstruction || t.reference)) c.imageTemplates[t.slug] = t;
    }
  }
  if (Array.isArray(saved.imageTemplateModels)) {
    const ids = saved.imageTemplateModels.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().toLowerCase());
    // An explicit empty list would disable templated generation entirely with no error anywhere —
    // read it as "unset" and keep the seed. Removing a model is a rewrite of the list, not a wipe.
    if (ids.length) c.imageTemplateModels = [...new Set(ids)];
  }
  // Secrets / scalars, with legacy aliases.
  if (typeof saved.crazyrouterKey === "string") c.crazyrouterKey = saved.crazyrouterKey;
  else if (typeof saved.crazyKey === "string") c.crazyrouterKey = saved.crazyKey;
  if (typeof saved.openrouterKey === "string") c.openrouterKey = saved.openrouterKey;
  if (typeof saved.openrouterFreeOnly === "boolean") c.openrouterFreeOnly = saved.openrouterFreeOnly;
  // An explicit empty list IS meaningful here (unlike imageTemplateModels): the catalogue refresh
  // is what makes free ids routable, so emptying this only drops the manual additions.
  if (Array.isArray(saved.openrouterModels))
    c.openrouterModels = [...new Set(saved.openrouterModels
      .filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().toLowerCase()))];
  if (typeof saved.freeaiapikeyKey === "string") c.freeaiapikeyKey = saved.freeaiapikeyKey;
  // An explicit empty list IS meaningful — it is the off switch for the provider that does not
  // require deleting the key, and there is no catalogue refresh to re-fill it behind your back.
  if (Array.isArray(saved.freeaiapikeyModels))
    c.freeaiapikeyModels = [...new Set(saved.freeaiapikeyModels
      .filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().toLowerCase()))];
  if (typeof saved.groqKey === "string") c.groqKey = saved.groqKey;
  // Same rule as freeaiapikeyModels: an explicit empty list IS the off switch, and no catalogue
  // refresh exists to re-fill it. Here it also has a second job — trimming an id back OUT of the
  // list is how a model Groq stops serving stops being advertised on /v1/models.
  if (Array.isArray(saved.groqModels))
    c.groqModels = [...new Set(saved.groqModels
      .filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().toLowerCase()))];
  // The account pool. `claudecodeAccountPool` is the name; `anthropicPool` is what the live
  // /data/config.json still calls it. Read either, keep both in sync so a rollback still boots.
  {
    const raw = Array.isArray(saved.claudecodeAccountPool) ? saved.claudecodeAccountPool
      : Array.isArray(saved.anthropicPool) ? saved.anthropicPool : null;
    if (raw) {
      c.claudecodeAccountPool = raw
        .filter((a) => a && typeof a.token === "string" && a.token.trim())
        .map((a) => {
          // email is a human label (which Anthropic login this is); disabled marks a dead/retired
          // subscription so routing skips it (see accountFor). Both are optional and only kept when
          // set, so a plain {name,org,token} entry stays byte-clean on disk.
          const e = { name: String(a.name || "acct").trim(), org: String(a.org || "").trim(), token: a.token.trim() };
          if (a.email && String(a.email).trim()) e.email = String(a.email).trim();
          if (a.disabled) e.disabled = true;
          return e;
        });
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
  if (typeof saved.imageTemplateKey === "string") c.imageTemplateKey = saved.imageTemplateKey;
  for (const k of ["oblitToken", "adminPassword", "localKey"])
    if (typeof saved[k] === "string") c[k] = saved[k];
  // Must survive the sanitizer or every logout is undone by the next config load — the same way
  // `allowUa` was silently dropped here and took the key policy with it.
  if (Number.isInteger(saved.sessionEpoch) && saved.sessionEpoch > 0) c.sessionEpoch = saved.sessionEpoch;
  if (typeof saved.jsonEnforce === "boolean") c.jsonEnforce = saved.jsonEnforce;
  if (Number.isInteger(saved.jsonMaxRetries) && saved.jsonMaxRetries >= 0 && saved.jsonMaxRetries <= 5)
    c.jsonMaxRetries = saved.jsonMaxRetries;
  if (typeof saved.requireProject === "boolean") c.requireProject = saved.requireProject;
  if (typeof saved.requireRegisteredConsumer === "boolean") c.requireRegisteredConsumer = saved.requireRegisteredConsumer;
  if (saved.auth && typeof saved.auth === "object" && AUTH_MODES.includes(saved.auth.mode))
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
      // Which clients may present this consumer's key (user-agent prefixes; see uaAllowed in
      // identity.js). It has to survive the mirror, not just the DB: the mirror is what a cold boot
      // with the database down authenticates from, and a field the loader drops would take the lock
      // off every key at exactly the moment nobody is watching. Empty = unrestricted, so it is only
      // set when non-empty — an `allowUa: []` in the file must not read as "nothing allowed".
      if (Array.isArray(v.allowUa)) {
        const allow = v.allowUa.map((s) => String(s || "").trim()).filter(Boolean);
        if (allow.length) e.allowUa = allow;
      }
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
  if (ACCOUNT_STRATEGIES.includes(saved.accountStrategy)) c.accountStrategy = saved.accountStrategy;
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
  reindexKeys(); require("./alert").watchPremiumApps(CFG);   // a stale key index must not survive a reload; the watcher call is the boot BASELINE (src/alert.js) — what is already deployed is not news
}

function persistConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(CFG, null, 2));
    // Every write is a potential key change (issue, revoke, delete a consumer). Rebuilding the index
    // here means no caller has to remember to, and a stale index can never authenticate a dead key.
    reindexKeys(); require("./alert").watchPremiumApps(CFG);   // ...and a potential POLICY change: every registry write, panel save and /api/routes edit passes here, so this is the one place that sees an app become able to spend opus. Diff + alert, never a refusal — src/alert.js
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
  IMAGE_MODEL_ID, IMAGE_MODEL_IDS, isImageModel, LIMIT_WINDOWS, LIMIT_HARD, AUTH_MODES, ACCOUNT_STRATEGIES, WINDOW_MS,
  CLAUDECODE_MODEL_SEED, CLAUDECODE_MODEL_ALIASES, CLAUDECODE_MODEL_REFRESH_MS,
  CONFIG_FILE, UI_ROUTES, reindexKeys, keyIndex, CANON, OBLIT, E4B,
};
