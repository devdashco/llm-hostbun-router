// Upstream quota headroom harvested off `x-ratelimit-*` (src/quota.js).
//
//   node test/quota.test.mjs
//
// This exists to answer one operational question — "how close is a free lane to its ceiling?" — and
// every way it fails answers that question WRONG while looking fine:
//
//   • no reading rendered as 0% used. "Nothing has been routed here since boot" and "plenty left"
//     are opposite facts. This codebase has written that lesson down twice already (claudecode's
//     `limits: null`, the images health verdict) and both times it was a real incident first.
//   • a reading that freezes. The busiest model is the one that hits the cap, and it is also the one
//     a naive key cap would stop updating first.
//   • harvesting nothing at all, because the header names moved or the call site sits behind an
//     early return. Then the panel says "healthy" right up to the 429.
import { recordQuota, quotaSnapshot, tightest, resetQuota, durMs } from "../src/quota.js";

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => { fail++; console.log(`  FAIL  ${m}${extra ? ` — ${extra}` : ""}`); };
const check = (m, cond, extra) => (cond ? ok(m) : bad(m, extra));

// A fetch-shaped Headers stand-in. `headers.get` is the whole contract recordQuota uses, and it
// takes the real `up.headers` in proxy(), so matching that shape is the point.
const H = (o) => ({ get: (k) => (k in o ? String(o[k]) : null) });

// The exact header set groq returned for llama-3.1-8b-instant on 2026-08-04.
const GROQ_8B = {
  "x-ratelimit-limit-requests": "14400",
  "x-ratelimit-limit-tokens": "6000",
  "x-ratelimit-remaining-requests": "14399",
  "x-ratelimit-remaining-tokens": "5963",
  "x-ratelimit-reset-requests": "6s",
  "x-ratelimit-reset-tokens": "370ms",
};

console.log("\nquota harvest\n");

// ── absent is not zero ──────────────────────────────────────────────────────
resetQuota();
check("no reading → provider absent from the snapshot", quotaSnapshot().groq === undefined);
check("no reading → tightest() is null, not 0%", tightest("groq") === null);

// ── a real reply is harvested ───────────────────────────────────────────────
resetQuota();
recordQuota("groq", "llama-3.1-8b-instant", H(GROQ_8B));
{
  const r = quotaSnapshot().groq["llama-3.1-8b-instant"];
  check("limit + remaining requests captured", r.limitRequests === 14400 && r.remainingRequests === 14399);
  check("limit + remaining tokens captured", r.limitTokens === 6000 && r.remainingTokens === 5963);
  // Percent USED, matching claudecode's u5/u7 direction. 1/14400 = 0.00694% -> 0 at one decimal.
  check("usedRequestsPct is percent USED", r.usedRequestsPct === 0, String(r.usedRequestsPct));
  check("usedTokensPct is percent USED", r.usedTokensPct === 0.6, String(r.usedTokensPct));
  check("reset durations parsed to ms", r.resetRequestsMs === 6000 && r.resetTokensMs === 370,
    `${r.resetRequestsMs}/${r.resetTokensMs}`);
  check("reading is timestamped", typeof r.ts === "number" && r.ts > 0);
}

// ── a provider that sends no such headers is a no-op, not an empty reading ───
// An empty reading would claim "0 of 0 used" for claudecode and crazyrouter, which is a fact about
// the header convention, not about their headroom.
resetQuota();
recordQuota("claudecode", "claude-opus-5", H({ "anthropic-ratelimit-unified-5h-utilization": "12" }));
check("non-x-ratelimit reply records nothing", quotaSnapshot().claudecode === undefined);
recordQuota("groq", "m", null);
recordQuota("groq", "m", {});
check("null / shapeless headers are survived", quotaSnapshot().groq === undefined);

// ── the reading updates ─────────────────────────────────────────────────────
// The whole value is that it tracks toward the ceiling. A store that only ever wrote once would pass
// every assertion above and be useless.
resetQuota();
recordQuota("groq", "llama-3.1-8b-instant", H(GROQ_8B));
recordQuota("groq", "llama-3.1-8b-instant", H({ ...GROQ_8B, "x-ratelimit-remaining-requests": "7200" }));
check("a later reply overwrites the earlier reading",
  quotaSnapshot().groq["llama-3.1-8b-instant"].remainingRequests === 7200);
check("...and the percent moves with it",
  quotaSnapshot().groq["llama-3.1-8b-instant"].usedRequestsPct === 50,
  String(quotaSnapshot().groq["llama-3.1-8b-instant"].usedRequestsPct));

// ── tightest() leads with the model closest to its cap ──────────────────────
// groq's ceilings are per model and uneven — 14,400/day on one id and 1,000 on the rest — so a
// provider-level verdict that averaged them would report healthy while one lane was exhausted.
resetQuota();
recordQuota("groq", "llama-3.1-8b-instant", H({ ...GROQ_8B, "x-ratelimit-remaining-requests": "14000" }));
recordQuota("groq", "openai/gpt-oss-120b", H({
  "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "50",
  "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "8000",
}));
{
  const t = tightest("groq");
  check("tightest picks the model nearest its cap", t.model === "openai/gpt-oss-120b", t.model);
  check("...and reports how used it is", t.usedPct === 95, String(t.usedPct));
}

// A model whose pair is incomplete must not win by default — it has no percent at all.
resetQuota();
recordQuota("groq", "partial", H({ "x-ratelimit-limit-tokens": "8000" }));   // no remaining
check("an incomplete reading yields no percent",
  quotaSnapshot().groq.partial.usedTokensPct === null);
check("...and does not become the tightest", tightest("groq") === null);

// ── the key set is bounded, but live keys never freeze ──────────────────────
// Same lesson as gate-perbox: an in-memory map keyed on something a caller influences must not grow
// forever. But capping GROWTH must not cap UPDATES, or the busiest model — the one that hits the
// ceiling — is exactly the one that stops reporting.
resetQuota();
for (let i = 0; i < 260; i++) recordQuota("groq", `m${i}`, H(GROQ_8B));
const kept = Object.keys(quotaSnapshot().groq).length;
check("key set is capped", kept <= 200, String(kept));
recordQuota("groq", "m0", H({ ...GROQ_8B, "x-ratelimit-remaining-requests": "1" }));
check("an EXISTING key still updates once the cap is reached",
  quotaSnapshot().groq.m0.remainingRequests === 1,
  String(quotaSnapshot().groq.m0.remainingRequests));

// ── duration parsing ────────────────────────────────────────────────────────
// Groq returns a DURATION ("2m59.56s"), not a timestamp. Getting this wrong renders a reset time
// that is silently hours off.
check("durMs: 6s", durMs("6s") === 6000);
check("durMs: 370ms", durMs("370ms") === 370);
check("durMs: 2m59.56s", durMs("2m59.56s") === 179560, String(durMs("2m59.56s")));
check("durMs: 1h30m", durMs("1h30m") === 5_400_000, String(durMs("1h30m")));
check("durMs: junk → null", durMs("later") === null && durMs("") === null && durMs(null) === null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
