// The `groq` provider — api.groq.com, LPU inference, and the second FREE lane after `local`.
//
//   node test/groq.test.mjs
//
// Same assert-the-route-never-the-response discipline as freeaiapikey.test.mjs, because the failure
// modes are the same shape: every one of them returns a perfectly good completion, or a 404 that
// reads like a routing bug. What differs is WHICH mistake costs what.
//
//   • claiming an id it should not have. Groq serves transcription (whisper-large-v3*), TTS
//     (canopylabs/orpheus-*) and 512-token classifiers (meta-llama/llama-prompt-guard-2-*) on the
//     same base URL as its chat models. Route one of those to /v1/chat/completions and it fails —
//     for an id that would otherwise have been answered by a provider that works.
//   • claiming NOTHING when it should have. Then a FREE id falls through to a PAID lane and bills,
//     at a 200, for work groq would have done for nothing.
//
// The ordering block at the bottom is the one that is not obvious from reading routing.js top to
// bottom, and it is the one that silently regresses: `openai/gpt-oss-*` is a real id here AND on
// openrouter AND through crazyrouter's open fallthrough.
import { CFG, setCFG, mergeConfig, envDefaults, PROVIDERS } from "../src/config.js";
import { baseRoute, groqTarget, groqModelEntries } from "../src/routing.js";

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => { fail++; console.log(`  FAIL  ${m}${extra ? ` — ${extra}` : ""}`); };
const check = (m, cond, extra) => (cond ? ok(m) : bad(m, extra));

const KEY = "gsk_test-groq";
const BASE = "https://api.groq.com/openai";

// Rebuild CFG from scratch per scenario, through the real loader path, so a field the sanitizer
// silently drops fails here exactly as it would in production.
function withCfg(saved) {
  setCFG(mergeConfig(envDefaults(), saved));
}

console.log("\ngroq provider\n");

// ── the vocabulary ──────────────────────────────────────────────────────────
check("groq is in PROVIDERS", PROVIDERS.includes("groq"), PROVIDERS.join(","));

// ── off without a key ───────────────────────────────────────────────────────
// The single most important property: deploying this changes NO existing route until someone sets
// the key. Not a 401 — null, so every id takes the route it took before the provider existed.
withCfg({ groqKey: "" });
check("no key → claims nothing", groqTarget("llama-3.1-8b-instant") === null);
check("no key → id falls through to crazyrouter",
  baseRoute("llama-3.1-8b-instant", "llama-3.1-8b-instant").provider === "crazyrouter");
check("no key → /v1/models advertises nothing", groqModelEntries().length === 0);

// Set on CFG directly, not through the merge: mergeConfig's `pick()` treats an empty base as
// "unset" and keeps the env default, so a saved "" can never reach the resolver. The guard still
// has to hold — a fresh envDefaults() with GROQ_BASE="" produces exactly this state.
withCfg({ groqKey: KEY });
CFG.bases.groq = "";
check("no base → claims nothing", groqTarget("llama-3.1-8b-instant") === null);
check("no base → id falls through to crazyrouter",
  baseRoute("llama-3.1-8b-instant", "llama-3.1-8b-instant").provider === "crazyrouter");

// ── the model list IS the guard ─────────────────────────────────────────────
withCfg({ groqKey: KEY });
check("seeded id is claimed", groqTarget("llama-3.1-8b-instant") === "llama-3.1-8b-instant");
check("seeded id routes to groq",
  baseRoute("llama-3.1-8b-instant", "llama-3.1-8b-instant").provider === "groq");
check("unlisted id is NOT claimed", groqTarget("llama-9-imaginary") === null);
check("unlisted id still reaches crazyrouter",
  baseRoute("llama-9-imaginary", "llama-9-imaginary").provider === "crazyrouter");
check("id match is case-insensitive", groqTarget("Llama-3.1-8B-Instant") === "llama-3.1-8b-instant");
check("empty id claims nothing", groqTarget("") === null && groqTarget(null) === null);

// The non-chat surfaces groq serves on this same base. Each of these would take a chat completion
// and fail, so the seed must not carry them — asserted by id, because "we left them out" is a fact
// about the list rather than about the code, and a later well-meaning "add every advertised id"
// commit is exactly how it breaks.
withCfg({ groqKey: KEY });
for (const id of ["whisper-large-v3", "whisper-large-v3-turbo", "canopylabs/orpheus-v1-english",
                  "meta-llama/llama-prompt-guard-2-86m", "meta-llama/llama-prompt-guard-2-22m"]) {
  check(`non-chat id ${id} is NOT seeded`, groqTarget(id) === null);
}

// An explicit empty list is the off switch that does not require deleting the key.
withCfg({ groqKey: KEY, groqModels: [] });
check("empty list → claims nothing", groqTarget("llama-3.1-8b-instant") === null);
check("empty list → falls through",
  baseRoute("llama-3.1-8b-instant", "llama-3.1-8b-instant").provider === "crazyrouter");

// ── the Max subscription must not leak onto it ──────────────────────────────
// Groq's ids are bare, exactly like ours, so the `vendor/model` shape that protects the pool on
// freeaiapikey does NOT protect it here. What protects it is branch order: isClaudeModel() is
// resolved before any opt-in provider. Asserted, including the hand-listed mistake.
withCfg({ groqKey: KEY });
for (const id of ["claude-opus-5", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
  check(`bare ${id} still goes to claudecode`, baseRoute(id, id).provider === "claudecode");
}
withCfg({ groqKey: KEY, groqModels: ["claude-opus-5"] });
check("even listed by hand, claude-opus-5 loses to the claude* branch",
  baseRoute("claude-opus-5", "claude-opus-5").provider === "claudecode");

// The local GPU is free AND ours, and it is resolved before every opt-in provider. If a groq id
// ever collides with a localMap alias, local must keep it — otherwise a config edit silently moves
// traffic off our own hardware onto a metered daily quota.
withCfg({ groqKey: KEY, groqModels: ["local"], localMap: { local: "qwen3.5-9b" } });
check("a groq id colliding with a local alias still resolves local",
  baseRoute("local", "local").provider === "local");

// ── the route carries the right credential ──────────────────────────────────
// `injectKey` is hard-wired to CFG.crazyrouterKey in buildHeaders. Setting it here would hand our
// crazyrouter credential to groq and 401 in a way that reads like a routing bug.
withCfg({ groqKey: KEY });
const r = baseRoute("llama-3.3-70b-versatile", "llama-3.3-70b-versatile");
check("route carries authToken", r.authToken === KEY, JSON.stringify(r));
check("route does NOT carry injectKey", !r.injectKey, JSON.stringify(r));
check("route points at their base", r.base === BASE, r.base);
check("base keeps the /openai suffix", /\/openai$/.test(r.base), r.base);
check("route rewrites to their id", r.rewriteModel === "llama-3.3-70b-versatile", r.rewriteModel);

// ── the advertised catalogue matches what would route ───────────────────────
const ids = groqModelEntries().map((e) => e.id);
check("/v1/models advertises the configured ids", ids.length === (CFG.groqModels || []).length);
check("every advertised id actually resolves here",
  ids.every((id) => baseRoute(id, id).provider === "groq"),
  ids.filter((id) => baseRoute(id, id).provider !== "groq").join(","));
check("advertised entries are owned_by groq",
  groqModelEntries().every((e) => e.owned_by === "groq"));

// ── BOTH catalogue endpoints advertise it ───────────────────────────────────
// There are two: the public `/v1/models` (mergedModels in src/claudecode.js) and the admin
// `/api/models` (catalogs in src/diagnostics.js). Adding a provider to only one is NOT a visible
// failure — the panel lists the ids while a caller enumerating the public catalogue cannot find a
// model that routes perfectly well. It shipped that way once in f4a0b45, the comment warning about
// it was written, and `groq` still shipped past that comment on the first pass here. Hence a check
// rather than a third warning.
//
// The `res` stub is a plain object on purpose and it is safe HERE specifically: mergedModels only
// calls writeHead + end, never pipes and never waits on a stream event. (A plain-object res that
// held up only while the tests drove early-return branches is a real trap in this repo — it is
// being taken deliberately, not by accident.)
withCfg({ groqKey: KEY });
{
  const { mergedModels } = await import("../src/claudecode.js");
  let body = "";
  await mergedModels({ writeHead() {}, end(s) { body = s; } });
  const data = JSON.parse(body).data || [];
  const advertised = data.filter((m) => m.owned_by === "groq").map((m) => m.id);
  check("public /v1/models advertises the groq ids", advertised.length === (CFG.groqModels || []).length,
    `advertised ${advertised.length} of ${(CFG.groqModels || []).length}: ${advertised.join(",")}`);
}

// ── ordering: free before paid ──────────────────────────────────────────────
// The reason groq sits ABOVE openrouter and freeaiapikey in resolveRoute rather than below them.
// `openai/gpt-oss-120b` is a real id in all three catalogues. Groq serves it free; the other two
// bill. openrouter declines it today only because openrouterFreeOnly is on — flip that one flag
// with groq resolved below it and this lane silently stops being used for the ids it was added
// for, at a 200 the whole way.
// Both ids are listed for freeaiapikey on purpose: `groqModels` is asserted to WIN the shared one
// and to leave the other alone. Listing only the shared id would make the second check pass for the
// wrong reason (freeaiapikey not claiming an id it was never given), which is the assertion-that-
// cannot-fail shape — it read green here before this list carried both.
withCfg({ groqKey: KEY, openrouterKey: "sk-or-test", freeaiapikeyKey: "sk-fa-test",
          freeaiapikeyModels: ["openai/gpt-oss-120b", "openai/gpt-5.5"] });
check("groq wins an id freeaiapikey also lists",
  baseRoute("openai/gpt-oss-120b", "openai/gpt-oss-120b").provider === "groq",
  baseRoute("openai/gpt-oss-120b", "openai/gpt-oss-120b").provider);
check("an id ONLY freeaiapikey lists still reaches freeaiapikey (groq did not swallow the chain)",
  baseRoute("openai/gpt-5.5", "openai/gpt-5.5").provider === "freeaiapikey");

// ── config round-trip ───────────────────────────────────────────────────────
// The sanitizer is the mirror a cold boot with the DB down reads from. A field it drops takes the
// provider offline on the one restart nobody is watching.
withCfg({ groqKey: KEY, groqModels: ["Llama-3.1-8B-Instant", "llama-3.1-8b-instant", " openai/gpt-oss-20b "] });
check("saved key survives the merge", CFG.groqKey === KEY);
check("saved models are lowercased, trimmed and deduped",
  JSON.stringify(CFG.groqModels) === JSON.stringify(["llama-3.1-8b-instant", "openai/gpt-oss-20b"]),
  JSON.stringify(CFG.groqModels));
withCfg({ groqKey: KEY, bases: { groq: "https://example.test/" } });
check("saved base survives the merge, trailing slash stripped",
  CFG.bases.groq === "https://example.test", CFG.bases.groq);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
