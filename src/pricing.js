// Cost estimates for the admin stats view. crazyrouter is the only metered provider; claudecode is
// a flat Max subscription and local is our own GPU, so both are $0 by definition.
const fs = require("node:fs");

const PRICES_FILE = process.env.PRICES_FILE || "/srv/prices.json";

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
// ── model cost + tier catalog (2026-07-24) ─────────────────────────────────
// Notional per-1M-token USD list prices AND a tier for the Anthropic (claudecode) catalog. These are
// NOT billed — we pay a flat Claude Max subscription, so costUsd() still returns 0 for claudecode.
// They exist for two reasons the flat subscription hides:
//   1. every model now has a defined token cost (so nothing shows an unexplained $0 with no reason);
//   2. each model carries a TIER, so a project quietly running opus/fable on the SHARED pool is
//      visible — an opus call is 5x and a fable call 10x haiku's per-token price, and both burn the
//      shared 5h/7d windows far faster. "premium" = opus* or fable* (fable is the flagship tier).
// Prices are Anthropic public list (USD / 1M tokens), input/output, verified against the claude-api
// model catalog (fable-5 $10/$50; current opus 4.6/4.7/4.8 $5/$25 — only the legacy opus-4-1 is the
// old $15/$75 Opus tier). Keep an entry per advertised id; test/router.test.mjs fails the build if a
// seeded/aliased model has no cost here.
// Anthropic's cache multipliers on the base INPUT rate: a read is a tenth, a 5-minute write is
// 1.25x. Named rather than inlined because they are the two numbers that decide whether a cached
// consumer looks cheap or expensive, and a reader has to be able to find them.
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_RATE = 1.25;

const MODEL_COST = {
  // haiku — cheap
  "claude-haiku-4-5":            { in: 1,  out: 5,  tier: "haiku" },
  "claude-haiku-4-5-20251001":  { in: 1,  out: 5,  tier: "haiku" },
  // sonnet — mid
  "claude-sonnet-4-5":          { in: 3,  out: 15, tier: "sonnet" },
  "claude-sonnet-4-5-20250929": { in: 3,  out: 15, tier: "sonnet" },
  "claude-sonnet-4-6":          { in: 3,  out: 15, tier: "sonnet" },
  "claude-sonnet-5":            { in: 3,  out: 15, tier: "sonnet" },
  // opus — premium. Current Opus (4.5+) is $5/$25; the legacy opus-4-1 is the old $15/$75 Opus tier.
  "claude-opus-4-1-20250805":   { in: 15, out: 75, tier: "opus" },
  "claude-opus-4-5":            { in: 5,  out: 25, tier: "opus" },
  "claude-opus-4-5-20251101":   { in: 5,  out: 25, tier: "opus" },
  "claude-opus-4-6":            { in: 5,  out: 25, tier: "opus" },
  "claude-opus-4-7":            { in: 5,  out: 25, tier: "opus" },
  "claude-opus-4-8":            { in: 5,  out: 25, tier: "opus" },
  "claude-opus-5":              { in: 5,  out: 25, tier: "opus" },
  // fable — flagship (Claude 5 family), the most expensive per token: $10/$50
  "claude-fable-5":             { in: 10, out: 50, tier: "fable" },
};
const PREMIUM_TIERS = new Set(["opus", "fable"]);
// Tier of a model id: exact table hit first, then a prefix classifier so an unlisted dated/undated
// variant (e.g. a brand-new opus id) still classifies before it's added to MODEL_COST. Non-Claude
// ids (gemini, qwen, …) have no tier → null (never premium).
function modelTier(id) {
  const k = String(id || "").toLowerCase();
  if (!k) return null;
  if (MODEL_COST[k]) return MODEL_COST[k].tier;
  if (!k.startsWith("claude")) return null;
  for (const t of ["opus", "fable", "sonnet", "haiku"]) if (k.includes(t)) return t;
  return null;
}
const isPremiumModel = (id) => PREMIUM_TIERS.has(modelTier(id));
// Notional (never-billed) list-price USD for a claudecode aggregate — what this traffic WOULD cost
// at Anthropic list price. Metered crazyrouter cost stays in costUsd().
//
// Unknown id → **null, not 0**. Zero is not "no guess", it is the specific claim "this traffic is
// free", and it is wrong in the one direction that matters: an id is missing from MODEL_COST
// precisely because Anthropic just shipped it, and the catalog reconciles new ids in at runtime
// (`refreshClaudecodeModels`), so the unpriced model is typically the NEWEST and most expensive one.
// Seen in prod 2026-07-26: `claude-opus-5` served and advertised with no entry here, which made the
// premium-burn banner read "claude-opus-5 (opus) — N calls, ~$0.00 list" — a warning about premium
// spend, reporting the premium spend as nothing. `modelTier`'s prefix classifier still tags it opus,
// so the row is flagged premium; only the money was a fabrication. Callers must render null as
// unknown, never coerce it with `|| 0`.
// Anthropic does not charge one rate for prompt tokens. A cache READ is 0.1x the input rate and a
// cache WRITE is 1.25x, and `ptok` here is the TOTAL — fresh input plus both cache classes, the way
// normalizeUsage sums them. Pricing all of it at the full input rate overstated every cached
// consumer, and the overstatement scales with how well they cache: measured on the pool the same
// day, cache reads were 96% of wmac's prompt tokens, so its list cost was inflated roughly 8x.
// That number exists to make premium spend visible; one that is wrong in the alarming direction
// gets discounted, and then the real alarm gets discounted with it.
//
// cr/cw are optional: a caller with no cache breakdown gets the old whole-thing-at-input-rate
// answer, which is correct when there is no caching to account for.
function listCostUsd(id, ptok, ctok, cr, cw) {
  const p = MODEL_COST[String(id || "").toLowerCase()];
  if (!p) return null;
  const read = Math.max(0, cr || 0), write = Math.max(0, cw || 0);
  const fresh = Math.max(0, (ptok || 0) - read - write);
  return (fresh / 1e6) * p.in
       + (read / 1e6) * p.in * CACHE_READ_RATE
       + (write / 1e6) * p.in * CACHE_WRITE_RATE
       + (ctok || 0) / 1e6 * p.out;
}
// Advertised claudecode ids with no MODEL_COST entry — the coverage warning surfaced in adminState so
// a newly-shipped Anthropic id without a price is visible instead of silently reading as $0/no-tier.
function unpricedModels(ids) {
  return (ids || []).filter((id) => !MODEL_COST[String(id || "").toLowerCase()]);
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

module.exports = { priceMap, costUsd, PRICES_FILE,
  MODEL_COST, modelTier, isPremiumModel, listCostUsd, unpricedModels };
