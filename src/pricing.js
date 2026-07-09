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

module.exports = { priceMap, costUsd, PRICES_FILE };
