// The router's VOCABULARIES and the validators that police them: which providers exist, which model
// ids are images, which windows and hard-actions a usage cap may name, which auth modes are real.
//
// Split out of config.js on 2026-07-26 (522 lines, over budget). This half depends on nothing but
// `path` — no CFG, no envDefaults, no merge — which is exactly why it is the clean cut: the other
// candidate, mergeConfig, uses these validators and extracting it would cycle straight back.
//
// config.js re-exports every name below, so no caller changes and the import guard keeps seeing
// them (test/imports.test.mjs pass 2 keys on the export list — un-exporting shrinks its coverage).
const path = require("node:path");

// ─────────────────────────────────────────────────────────────────────────────
// Providers. Where a request is actually served. There are four, and that's the whole taxonomy.
// ─────────────────────────────────────────────────────────────────────────────
//   local        pbox llama.cpp. Speaks OpenAI natively.
//   claudecode   the claudecode-account-pool (our Claude Max logins) → api.anthropic.com.
//                Native /v1/messages is forwarded verbatim; OpenAI /v1/chat/completions is
//                translated (translate.js). The account is PINNED per project — never rotated.
//   crazyrouter  cloud relay (gemini etc). Opt-in by model id. Never an automatic fallback.
//   openrouter   openrouter.ai. Opt-in by model id, and FREE-ONLY by default (openrouterFreeOnly).
//                Its catalogue is ~330 models of which ~17 are free; the free ones are the reason
//                it is here, and the paid ones sit one typo away on the same base URL. So the
//                provider only claims an id its catalogue marks free — anything else falls through
//                to the chain it would have taken anyway, rather than quietly billing a card.
//                See src/openrouter.js.
//
// `provider` is the field name. `lane` was the old word for the same thing and is still accepted
// on input so existing /data/config.json keeps working.
const PROVIDERS = ["local", "crazyrouter", "claudecode", "openrouter"];
// The image provider is deliberately absent from PROVIDERS: it is not a routing target. It is picked
// by path (`/v1/images/*`), it speaks its own shape, and it bills GPU seconds rather than tokens.
//
// The upstream answers to THREE ids and every one of them must be barred from the text endpoints,
// or it drops through the whole resolver into crazyrouter, the only provider that bills per token.
// Listing just the first one is how `sd-turbo` kept knocking on the paid door — so this list has to
// gain an entry the same day the image service serves a new id, never later.
//
// What actually runs, as of 2026-07-28, is NVIDIA SANA-Sprint 0.6B on home-ww — 2 steps, no LoRA.
// It replaced SDXL + the SDXL-Lightning 8-step LoRA, which spilled VRAM on that card (~30 s/image)
// and whose adapter machinery caused two outages in a week.
//   · `imagegen`       — the canonical public id. Deliberately generic; the checkpoint behind it is
//                        ours to swap without every caller editing a string.
//   · `sana-sprint`    — the honest id for what is loaded today, for callers that want to pin it.
//   · `sdxl-lightning` — what WAS loaded until 2026-07-28. Still barred here so a caller pinning it
//                        cannot fall through to a per-token provider; it now serves SANA.
//   · `sd-turbo`       — a legacy alias, and a lie: this service has never run SD-Turbo. Kept only
//                        so pre-rename callers don't break.
// The service's own /health names what is loaded (`kind` + `model`). Ask the upstream what it is
// running; never infer the weights from the id.
const IMAGE_MODEL_ID = "imagegen";
const IMAGE_MODEL_IDS = [IMAGE_MODEL_ID, "sana-sprint", "sana", "sdxl-lightning", "sd-turbo"];
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

// ─────────────────────────────────────────────────────────────────────────────
// Image templates — a reference picture + a style instruction, rendered by an image-capable model
// on crazyrouter. See src/imagetemplates.js for the path itself; this is only the vocabulary.
// ─────────────────────────────────────────────────────────────────────────────
// The ids this router will render a template with. Config, never code (invariant 6): crazyrouter
// ships image models without asking us, so `imageTemplateModels` in /data/config.json is the live
// list and this is the seed. It exists to stop a text model id reaching the paid upstream through
// an images endpoint — the caller would be billed per token and handed a chat completion.
const IMAGE_TEMPLATE_MODELS = ["nano-banana", "nano-banana-pro", "nano-banana-2"];
// A slug is a URL path segment (/v1/image-templates/<slug>/reference) AND a filename stem on the
// volume, so it is restricted to what is safe in both. No dots: `..` is the traversal that matters.
const IMAGE_TEMPLATE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Normalize one template from untrusted input (admin POST, config.json, the repo seed). Returns null
// when the slug is unusable — the caller answers 400 rather than writing a key nobody can address.
// Accepts snake_case as well as camelCase: the CMS rows these came from spell it `system_instruction`.
function sanitizeImageTemplate(v) {
  if (!v || typeof v !== "object") return null;
  const slug = String(v.slug || "").trim().toLowerCase();
  if (!IMAGE_TEMPLATE_SLUG.test(slug)) return null;
  const str = (x, max) => (typeof x === "string" ? x.trim().slice(0, max) : "");
  const ratio = str(v.aspectRatio ?? v.aspect_ratio, 12);
  const ref = str(v.reference, 96);
  return {
    slug,
    name: str(v.name, 80) || slug,
    description: str(v.description, 400),
    systemInstruction: str(v.systemInstruction ?? v.system_instruction, 8000),
    // "" = fall back to the first entry of imageTemplateModels at render time, so a template written
    // before an id existed does not pin itself to a model that has since been retired.
    model: str(v.model, 80).toLowerCase(),
    aspectRatio: /^\d{1,2}:\d{1,2}$/.test(ratio) ? ratio : "",
    // Filename only — never a path. storeReference() is the only writer and always names it <slug>.<ext>.
    reference: /^[a-z0-9][a-z0-9-]{0,79}\.(jpg|jpeg|png|webp|gif)$/.test(ref) ? ref : "",
    // Which of our sites this template dresses, as bare hostnames. It is what lets a caller ask for
    // "the template for bofrid.se" without a second system knowing the answer — the association used
    // to live only in the CMS, which made every image call a CMS call.
    sites: Array.isArray(v.sites)
      ? [...new Set(v.sites.filter((s) => typeof s === "string" && s.trim())
          .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "")))].sort()
      : [],
    created: Number(v.created) || 0,
    updated: Number(v.updated) || 0,
  };
}

const WINDOW_MS = { "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
// DERIVED, not a second literal. These were two adjacent lists of the same five strings: add a
// window to WINDOW_MS, forget this one, and sanitizeLimit() silently rejects the new value back to
// "24h" — the operator saves a 6h cap and gets a 24h one with no error. The panel keeps its own copy
// (LIM_WINDOWS in panel/lib/routing-helpers.ts) because it is a separate static build with no server
// import; test/panel-nav.test.mjs fails if the two drift, which is the pairing that would actually
// bite — an offered window the server does not accept.
const LIMIT_WINDOWS = Object.keys(WINDOW_MS);
// What a cap does when it is hit. The panel offers these in a dropdown (LIM_HARD in
// panel/lib/routing-helpers.ts) and test/panel-nav.test.mjs fails if the two disagree — offer one
// this list rejects and sanitizeLimit() quietly rewrites the operator's choice to "block".
const LIMIT_HARD = ["block", "slow", "warn"];
// The three auth modes, in ONE place. This list was written out twice — once in the POST /api/auth
// validator and once in the config loader — so a fourth mode added to the endpoint would be accepted
// by the API and then silently dropped the next time /data/config.json was read. The gate that
// decides whether anyone needs a key is not a good place for two lists to disagree.
const AUTH_MODES = ["off", "optional", "required"];
// How the claudecode account is chosen. In ONE place for the same reason AUTH_MODES is: the value
// was written out three times — the env read, the config loader, and POST /api/claudecode/strategy's
// validator — so a mode the endpoint accepted could be silently dropped on the next config load,
// and the operator would see the panel flip and the behaviour not change. See accountFor().
const ACCOUNT_STRATEGIES = ["pinned", "soonest-weekly-reset", "any-available"];
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
    hard: LIMIT_HARD.includes(v.hard) ? v.hard : "block",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The local lane: which ids mean "our own GPU", and which box each one sits on.
// ─────────────────────────────────────────────────────────────────────────────
// CANON is the id the local llama.cpp answers to (its `-a` alias); LOCAL_ALIASES is every id that
// means the pbox GPU. Seeded into localMap so a cold boot on an EMPTY /data volume still serves
// them from llama.cpp. Not a neutral default: until 2026-08-02 localMap seeded {} and modelRoutes
// sent `local`/`gemma` to claudecode, so a lost config.json moved the whole FREE lane onto the Max
// subscription — invariant 2's cross-provider substitution, arriving as a default rather than a
// decision. With no bases.local the call now fails honestly instead.
//
// This is vocabulary, so it lives here beside PROVIDERS and IMAGE_MODEL_IDS rather than in
// config.js — which was at 521 lines against a 500 budget once the ww half was added.
const CANON = process.env.LOCAL_MODEL || "qwen3.5-9b";
const LOCAL_ALIASES = ["local", "gemma", "gemma-4-26b", "qwen", "qwen3.5-9b"];
// One provider, TWO boxes since 2026-08-03. ww's RTX 3070 already serves the image model; what is
// left of that card (~2.6 GB at its measured 5545 MiB peak) fits a 2B, so these ids resolve to ww.
// The split is a BASE, not a provider: which machine holds a checkpoint is not a billing or policy
// distinction, and gate/pricing/analytics all key on `provider`.
const WW_CANON = process.env.LOCAL_MODEL_WW || "qwen3.5-2b";
const WW_ALIASES = ["qwen3.5-2b", "qwen-small"];
// ww is reached at its OWN hostname, exactly as the image model already is (`bases.images` →
// imagegen-ww.hostbun.cc). Both are Coolify resources on the ww box; the hostname is the managed,
// restartable, monitored way in. The previous default `http://10.0.1.250:8001` was none of those
// and was not even ww: on hostbun that address is a SECONDARY IP of the docker bridge
// (`ip route get 10.0.1.250` → local, dev lo) and the listener on :8001 is **sshd** — a hand-made
// `ssh -R` reverse tunnel from ww, owned by nobody, restarted by nothing, gone on the next reboot.
// It answers 200 until the day the session drops, and then the free lane's small model refuses
// connections from the router's own box for a reason nothing in Coolify can show you.
const WW_BASE = (process.env.LOCAL_BASE_WW || "https://qwen-ww.hostbun.cc").replace(/\/$/, "");
const OBLIT = process.env.LOCAL_MODEL_2 || "qwen3.6-27b-obliterated";
const E4B = process.env.LOCAL_MODEL_3 || "gemma-4-e4b-it-obliterated";
// alias -> the model id its box actually answers to.
const LOCAL_MAP_SEED = {
  ...Object.fromEntries(LOCAL_ALIASES.map((id) => [id, CANON])),
  ...Object.fromEntries(WW_ALIASES.map((id) => [id, WW_CANON])),
};
// model id -> the base that serves it, for the ids that are NOT on pbox. Keyed on both the alias
// and the canonical id, because providerRoute is reached with whichever of the two was named. An id
// absent here is pbox, so losing this map degrades to "ww's ids 404 on pbox's llama.cpp" — an
// honest failure, never a silent hop onto a per-token provider.
const LOCAL_BASES_SEED = Object.fromEntries([...WW_ALIASES, WW_CANON].map((id) => [id, WW_BASE]));

module.exports = {
  PROVIDERS, PROVIDER_SET, LEGACY_PROVIDER, normProvider, providerOf,
  IMAGE_MODEL_ID, IMAGE_MODEL_IDS, isImageModel,
  IMAGE_TEMPLATE_MODELS, IMAGE_TEMPLATE_SLUG, sanitizeImageTemplate,
  WINDOW_MS, LIMIT_WINDOWS, LIMIT_HARD, AUTH_MODES, ACCOUNT_STRATEGIES,
  sanitizeRule, sanitizeLimit,
  CANON, LOCAL_ALIASES, WW_CANON, WW_ALIASES, WW_BASE, OBLIT, E4B,
  LOCAL_MAP_SEED, LOCAL_BASES_SEED,
};
