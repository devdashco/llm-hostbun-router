// The `freeaiapikey` provider — api.freeaiapikey.com, a metered reseller of the same frontier ids
// crazyrouter sells, at roughly half the input price and a third of the output price.
//
//   node test/freeaiapikey.test.mjs
//
// EVERY failure mode of this provider returns a perfectly good completion, which is why not one
// assertion below is about a status code. They are all about WHICH UPSTREAM an id resolves to:
//
//   • claiming an id it should not have. `anthropic/claude-opus-5` is a real id in BOTH this
//     catalogue and openrouter's, and `claude-opus-5` — no prefix — is our flat Max subscription.
//     Route the bare one here and the subscription we already pay for starts billing per token, at
//     a 200, against a reseller whose own usage accounting is demonstrably wrong (measured
//     2026-08-04: `input_tokens: 0` on a real call, and 1,762 input tokens for the prompt "hi").
//   • claiming NOTHING when it should have. Then the id falls through to crazyrouter, which
//     answers just as well and bills ~2x the input and ~2.5-3x the output.
//
// Both are invisible from the caller's side. So: assert the route, never the response.
import { readFileSync } from "node:fs";
import { CFG, setCFG, mergeConfig, envDefaults, PROVIDERS } from "../src/config.js";
import { baseRoute, freeaiapikeyTarget, freeaiapikeyModelEntries } from "../src/routing.js";

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => { fail++; console.log(`  FAIL  ${m}${extra ? ` — ${extra}` : ""}`); };
const check = (m, cond, extra) => (cond ? ok(m) : bad(m, extra));

const KEY = "sk-test-freeaiapikey";
const BASE = "https://api.freeaiapikey.com";

// Rebuild CFG from scratch per scenario. mergeConfig(envDefaults(), …) is what the real loader does,
// so a field the sanitizer silently drops fails here exactly as it would in production — that is how
// `allowUa` was caught being dropped on load.
function withCfg(saved) {
  setCFG(mergeConfig(envDefaults(), saved));
}

console.log("\nfreeaiapikey provider\n");

// ── the vocabulary ──────────────────────────────────────────────────────────
check("freeaiapikey is in PROVIDERS", PROVIDERS.includes("freeaiapikey"), PROVIDERS.join(","));

// ── off without a key ───────────────────────────────────────────────────────
// The single most important property: deploying this changes NO existing route until someone sets
// the key. Not a 401 — null, so every id takes the route it took before the provider existed. A
// half-configured provider that swallowed ids and then 401'd would be an outage nobody could
// attribute to this commit.
withCfg({ freeaiapikeyKey: "" });
check("no key → claims nothing", freeaiapikeyTarget("openai/gpt-5.6-sol") === null);
check("no key → id falls through to crazyrouter",
  baseRoute("openai/gpt-5.6-sol", "openai/gpt-5.6-sol").provider === "crazyrouter");
check("no key → /v1/models advertises nothing", freeaiapikeyModelEntries().length === 0);

// Set on CFG directly, not through the merge: mergeConfig's `pick()` treats an empty base as
// "unset" and keeps the env default, so a saved `""` can never reach the resolver. The guard still
// has to hold, because a fresh envDefaults() with FREEAIAPIKEY_BASE="" produces exactly this state.
withCfg({ freeaiapikeyKey: KEY });
CFG.bases.freeaiapikey = "";
check("no base → claims nothing", freeaiapikeyTarget("openai/gpt-5.6-sol") === null);
check("no base → id falls through to crazyrouter",
  baseRoute("openai/gpt-5.6-sol", "openai/gpt-5.6-sol").provider === "crazyrouter");

// ── the model list IS the guard ─────────────────────────────────────────────
// There is no free-only test here as there is for openrouter, because everything they serve is
// metered. So the written list is the only thing standing between "we chose to spend here" and
// "an id we never heard of started billing".
withCfg({ freeaiapikeyKey: KEY });
check("seeded id is claimed", freeaiapikeyTarget("openai/gpt-5.6-sol") === "openai/gpt-5.6-sol");
check("seeded id routes to freeaiapikey",
  baseRoute("openai/gpt-5.6-sol", "openai/gpt-5.6-sol").provider === "freeaiapikey");
check("unlisted id is NOT claimed", freeaiapikeyTarget("openai/gpt-9-imaginary") === null);
check("unlisted id still reaches crazyrouter",
  baseRoute("openai/gpt-9-imaginary", "openai/gpt-9-imaginary").provider === "crazyrouter");
check("id match is case-insensitive", freeaiapikeyTarget("OpenAI/GPT-5.6-Sol") === "openai/gpt-5.6-sol");
check("empty id claims nothing", freeaiapikeyTarget("") === null && freeaiapikeyTarget(null) === null);

// An explicit empty list is the off switch that does not require deleting the key. It must be read
// as "claim nothing", not as "unset, keep the seed" — the opposite of imageTemplateModels, and the
// difference is that emptying THIS list is how an operator disables a provider they still hold
// credentials for.
withCfg({ freeaiapikeyKey: KEY, freeaiapikeyModels: [] });
check("empty list → claims nothing", freeaiapikeyTarget("openai/gpt-5.6-sol") === null);
check("empty list → falls through",
  baseRoute("openai/gpt-5.6-sol", "openai/gpt-5.6-sol").provider === "crazyrouter");

// ── the Max subscription must not leak onto it ──────────────────────────────
// Their ids are `vendor/model`. Ours are bare. That difference is the only thing keeping a flat
// subscription off a metered relay, so it is asserted rather than assumed — including the case
// where someone puts the bare id in the list by hand, which is the mistake that would cost money.
withCfg({ freeaiapikeyKey: KEY });
for (const id of ["claude-opus-5", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
  check(`bare ${id} still goes to claudecode`, baseRoute(id, id).provider === "claudecode");
}
check("prefixed anthropic/claude-opus-5 IS claimed (a different string, on purpose)",
  baseRoute("anthropic/claude-opus-5", "anthropic/claude-opus-5").provider === "freeaiapikey");

withCfg({ freeaiapikeyKey: KEY, freeaiapikeyModels: ["claude-opus-5"] });
check("even listed by hand, bare claude-opus-5 loses to the claude* branch",
  baseRoute("claude-opus-5", "claude-opus-5").provider === "claudecode");

// ── the route carries the right credential ──────────────────────────────────
// `injectKey` is hard-wired to CFG.crazyrouterKey in buildHeaders. Setting it here would hand our
// crazyrouter credential to a third party and 401 in a way that reads like a routing bug.
withCfg({ freeaiapikeyKey: KEY });
const r = baseRoute("anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5");
check("route carries authToken", r.authToken === KEY, JSON.stringify(r));
check("route does NOT carry injectKey", !r.injectKey, JSON.stringify(r));
check("route points at their base", r.base === BASE, r.base);
check("route rewrites to their id", r.rewriteModel === "anthropic/claude-sonnet-5", r.rewriteModel);

// ── the advertised catalogue matches what would route ───────────────────────
// Advertising an id that does not resolve here sends a caller to an unexplained fallthrough; the
// two lists are generated from the same field precisely so they cannot drift.
const ids = freeaiapikeyModelEntries().map((e) => e.id);
check("/v1/models advertises the configured ids", ids.length === (CFG.freeaiapikeyModels || []).length);
check("every advertised id actually resolves here",
  ids.every((id) => baseRoute(id, id).provider === "freeaiapikey"),
  ids.filter((id) => baseRoute(id, id).provider !== "freeaiapikey").join(","));

// ── BOTH catalogue endpoints, not one ───────────────────────────────────────
// There are two: the public `GET /v1/models` (mergedModels in src/claudecode.js) and the panel's
// `/api/models` (catalogs in src/diagnostics.js). Adding a provider to one and not the other is
// invisible — nothing errors, the panel looks complete, and only a caller enumerating the public
// catalogue notices that a model which routes perfectly well is not listed. That shipped in f4a0b45.
// A source check rather than a boot: mergedModels awaits the live upstream catalogues, so exercising
// it here would put a network call in a unit suite to assert a wiring fact.
{
  const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  for (const f of ["claudecode.js", "diagnostics.js"])
    check(`${f} publishes freeaiapikey's ids`, src(f).includes("freeaiapikeyModelEntries()"));
}

// ── ordering against openrouter ─────────────────────────────────────────────
// The catalogues OVERLAP. openrouter is free-only by default and these ids are paid there, so it
// declines them today — but with freeOnly off it would claim them at list price, which is dearer
// than both this provider and crazyrouter. Pin the intent: free before paid, cheap paid before
// dear paid. (openrouterTarget also needs a loaded catalogue, which this process has not fetched,
// so this asserts our branch is reached at all rather than simulating theirs.)
withCfg({ freeaiapikeyKey: KEY, openrouterKey: "sk-or-test" });
check("with openrouter keyed but no catalogue, freeaiapikey still wins the id",
  baseRoute("openai/gpt-5.5", "openai/gpt-5.5").provider === "freeaiapikey");

// ── config round-trip ───────────────────────────────────────────────────────
// The sanitizer is the mirror a cold boot with the DB down reads from. A field it drops takes the
// provider offline on the one restart nobody is watching.
withCfg({ freeaiapikeyKey: KEY, freeaiapikeyModels: ["Openai/GPT-5.4", "openai/gpt-5.4", " openai/gpt-4o "] });
check("saved key survives the merge", CFG.freeaiapikeyKey === KEY);
check("saved models are lowercased, trimmed and deduped",
  JSON.stringify(CFG.freeaiapikeyModels) === JSON.stringify(["openai/gpt-5.4", "openai/gpt-4o"]),
  JSON.stringify(CFG.freeaiapikeyModels));
withCfg({ freeaiapikeyKey: KEY, bases: { freeaiapikey: "https://example.test/" } });
check("saved base survives the merge, trailing slash stripped",
  CFG.bases.freeaiapikey === "https://example.test", CFG.bases.freeaiapikey);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
