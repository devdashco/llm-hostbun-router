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
//      visible — a premium call is ~15x the input / ~15x the output price of haiku and burns the
//      shared 5h/7d windows far faster. "premium" = opus* or fable* (the flagship Claude 5 tier).
// Prices are Anthropic public list (USD / 1M tokens), input/output. Keep an entry per advertised id;
// test/router.test.mjs fails the build if a seeded/aliased model has no cost here.
const MODEL_COST = {
  // haiku — cheap
  "claude-haiku-4-5":            { in: 1,  out: 5,  tier: "haiku" },
  "claude-haiku-4-5-20251001":  { in: 1,  out: 5,  tier: "haiku" },
  // sonnet — mid
  "claude-sonnet-4-5":          { in: 3,  out: 15, tier: "sonnet" },
  "claude-sonnet-4-5-20250929": { in: 3,  out: 15, tier: "sonnet" },
  "claude-sonnet-4-6":          { in: 3,  out: 15, tier: "sonnet" },
  "claude-sonnet-5":            { in: 3,  out: 15, tier: "sonnet" },
  // opus — premium
  "claude-opus-4-1-20250805":   { in: 15, out: 75, tier: "opus" },
  "claude-opus-4-5":            { in: 15, out: 75, tier: "opus" },
  "claude-opus-4-5-20251101":   { in: 15, out: 75, tier: "opus" },
  "claude-opus-4-6":            { in: 15, out: 75, tier: "opus" },
  "claude-opus-4-7":            { in: 15, out: 75, tier: "opus" },
  "claude-opus-4-8":            { in: 15, out: 75, tier: "opus" },
  // fable — flagship (Claude 5 family)
  "claude-fable-5":             { in: 15, out: 75, tier: "fable" },
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
// at Anthropic list price. Unknown id → 0 (no guess). Metered crazyrouter cost stays in costUsd().
function listCostUsd(id, ptok, ctok) {
  const p = MODEL_COST[String(id || "").toLowerCase()];
  if (!p) return 0;
  return (ptok || 0) / 1e6 * p.in + (ctok || 0) / 1e6 * p.out;
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
