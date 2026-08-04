// Upstream quota headroom, harvested free off response headers.
//
// The sibling of db.js's recordLimits(), and the difference is the point. That one reads Anthropic's
// `anthropic-ratelimit-unified-*` and PERSISTS to Postgres, because a Max account's 5h/7d window is
// a property of the subscription that has to survive a restart and be joined against spend.
//
// This one reads the OpenAI-convention `x-ratelimit-*` that groq (and cerebras, cloudflare,
// openrouter — same names) return on EVERY reply, and keeps it in memory only. Three reasons that is
// the right call rather than a corner cut:
//
//   • The values are ABSOLUTE, not accumulated — `remaining` and `limit`, not a running total. A
//     restart loses nothing permanent: the next call through that model refills the entry, and until
//     it does the reading is honestly absent rather than wrong.
//   • A DB write per inference to store a number that the next inference overwrites is write
//     amplification for no reader.
//   • It answers the one question the call log CANNOT. The log knows how many requests we sent; only
//     the header knows what the CEILING is. Hardcoding `14400` in config would be a number that
//     drifts silently the day groq changes a tier — and a stale ceiling reads as headroom.
//
// Deliberately provider-agnostic on the header names: this is not speculative generality, it is that
// the four free lanes we are stacking all speak the same convention, and a per-provider parser would
// be four copies of the same six lines.

// provider -> model -> reading. Bounded: MAX_KEYS total, and models come from a configured list, so
// this cannot grow into an unbounded cache keyed on whatever a caller asked for.
const QUOTA = new Map();
const MAX_KEYS = 200;

// "2m59.56s", "370ms", "6s" -> ms. Groq returns a duration, not a timestamp, so a caller rendering
// "resets at" has to add it to now() — returning the raw string would make every consumer parse it.
function durMs(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g);
  if (!m) return null;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let total = 0;
  for (const part of m) {
    const [, n, u] = part.match(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/);
    total += Number(n) * unit[u];
  }
  return Math.round(total);
}

const num = (v) => (v == null || v === "" ? null : Number(v));

/**
 * Snapshot one reply's rate-limit headers. No-op for a provider that sends none, so it is safe to
 * call on every response regardless of upstream.
 *
 * `headers` is a fetch Headers (what proxy() holds), matching recordLimits' signature.
 */
function recordQuota(provider, model, headers) {
  if (!provider || !headers || typeof headers.get !== "function") return;
  const h = (k) => headers.get(k);
  const limReq = num(h("x-ratelimit-limit-requests"));
  const limTok = num(h("x-ratelimit-limit-tokens"));
  // Neither present = this upstream does not speak the convention. Not an error, just not for us.
  if (limReq == null && limTok == null) return;

  let byModel = QUOTA.get(provider);
  if (!byModel) { byModel = new Map(); QUOTA.set(provider, byModel); }
  const key = String(model || "(unknown)").toLowerCase();
  // Only refuse GROWTH past the cap — an existing key must always keep updating, or the busiest
  // models would freeze at a stale reading exactly when the cap was hit.
  if (!byModel.has(key) && totalKeys() >= MAX_KEYS) return;

  const remReq = num(h("x-ratelimit-remaining-requests"));
  const remTok = num(h("x-ratelimit-remaining-tokens"));
  byModel.set(key, {
    limitRequests: limReq, remainingRequests: remReq,
    limitTokens: limTok, remainingTokens: remTok,
    // Percent USED, so it reads the same direction as claudecode's u5/u7 utilisation. null when the
    // pair is incomplete — never 0, which would claim "nothing spent".
    usedRequestsPct: pct(limReq, remReq),
    usedTokensPct: pct(limTok, remTok),
    resetRequestsMs: durMs(h("x-ratelimit-reset-requests")),
    resetTokensMs: durMs(h("x-ratelimit-reset-tokens")),
    ts: Date.now(),
  });
}

function pct(limit, remaining) {
  if (limit == null || remaining == null || !(limit > 0)) return null;
  return Math.round(((limit - remaining) / limit) * 1000) / 10;
}

function totalKeys() {
  let n = 0;
  for (const m of QUOTA.values()) n += m.size;
  return n;
}

/**
 * Everything harvested, for /api/health. `{provider: {model: reading}}`.
 * An absent provider means NO READING — not "no usage". Render those differently or the panel
 * repeats the `limits: null` vs 0% mistake this codebase keeps writing down.
 */
function quotaSnapshot() {
  const out = {};
  for (const [provider, byModel] of QUOTA) {
    out[provider] = Object.fromEntries(byModel);
  }
  return out;
}

/** The tightest reading for one provider — what a health verdict should lead with. */
function tightest(provider) {
  const byModel = QUOTA.get(provider);
  if (!byModel || !byModel.size) return null;
  let worst = null;
  for (const [model, r] of byModel) {
    const p = Math.max(r.usedRequestsPct ?? -1, r.usedTokensPct ?? -1);
    if (p < 0) continue;
    if (!worst || p > worst.usedPct) worst = { model, usedPct: p, ...r };
  }
  return worst;
}

function resetQuota() { QUOTA.clear(); }

module.exports = { recordQuota, quotaSnapshot, tightest, resetQuota, durMs };
