// WHERE a request goes, and whether it is allowed to go there.
//
// Two invariants live here and must not be "improved" away:
//   • No MODEL or PROVIDER fallback. A 5xx reaches the caller; so does a 429, once the pool is
//     out. Answering with a different model on a different provider hides cost and truth.
//     Carve-out (2026-08-04): a 429 may be retried on another login of the SAME pool with the
//     SAME model — see src/accountfailover.js for why no selection rule can replace it.
//   • One project, one account. accountFor() never rotates: rotation blows the per-org prompt
//     cache (~12x cost) and makes "who spent this?" unanswerable after the fact.
const { CFG, persistConfig, normProvider, isImageModel, WINDOW_MS } = require("./config");
const { parseConsumer } = require("./identity");
const { openrouterTarget } = require("./openrouter");
const { dbUp, dbRow, dbRows, ACCT_CACHE, ACCT_DEAD, ORG_OF_ACCOUNT } = require("./db");

const localTarget = (m) => (m == null ? null : CFG.localMap[String(m).toLowerCase()] || null);
// Does freeaiapikey claim this id? Only if a key is set AND the id is written down in
// `freeaiapikeyModels`. No catalogue lookup, because there is no free/paid line to police there —
// every id they serve is metered, so the WRITTEN LIST is the whole guard. Returns the id to forward
// or null, and null is the safe answer: the call then takes exactly the route it took before.
// Deliberately not a module like src/openrouter.js — that file exists to hold a live catalogue and
// a free-only test, and neither applies here. Give it a refresh and it earns its own file.
function freeaiapikeyTarget(model) {
  if (!CFG.bases.freeaiapikey || !CFG.freeaiapikeyKey) return null;
  const key = String(model == null ? "" : model).trim().toLowerCase();
  if (!key) return null;
  return (CFG.freeaiapikeyModels || []).includes(key) ? key : null;
}
const freeaiapikeyModelEntries = () =>
  (!CFG.bases.freeaiapikey || !CFG.freeaiapikeyKey) ? []
    : (CFG.freeaiapikeyModels || []).map((id) => ({ id, object: "model", owned_by: "freeaiapikey" }));
// A `claude*` model id means the claudecode provider (our Max account pool → api.anthropic.com).
const isClaudeModel = (m) => typeof m === "string" && m.toLowerCase().startsWith((CFG.claudePrefix || "claude").toLowerCase());
const isGated = (target) => Array.isArray(CFG.gatedModels) && CFG.gatedModels.includes(target);

// The local provider is ONE provider but no longer one machine: pbox serves most ids, ww serves the
// small ones that fit beside the image model on its 3070. localBases is the per-target-model
// exception list; anything absent from it is pbox. Deliberately NOT a fourth provider — the box a
// checkpoint sits on is not a billing or policy distinction, and gate/pricing/analytics all key on
// `provider`, so splitting it there would have made every one of them ask about hardware.
const localBaseFor = (m) => (CFG.localBases && CFG.localBases[String(m || "").toLowerCase()]) || CFG.bases.local;

function providerRoute(provider, model, reason) {
  const l = normProvider(provider) || "crazyrouter";
  // claudecode: the pinned account's token is attached later (dispatch), not here.
  if (l === "claudecode") return { provider: "claudecode", base: CFG.bases.claudecode, rewriteModel: model || undefined, reason };
  // authToken on the local lane = llama.cpp's --api-key. buildHeaders already turns it into the
  // Authorization bearer, so nothing downstream changes. It also OVERWRITES the caller's own
  // `sk-llm-…` header, which we were otherwise forwarding verbatim to llama.cpp.
  if (l === "local") return { provider: "local", base: localBaseFor(model), rewriteModel: model, target: model, ...(CFG.localKey ? { authToken: CFG.localKey } : {}), reason };
  // `authToken`, not `injectKey`: injectKey is hard-wired to CFG.crazyrouterKey in buildHeaders, so
  // reusing it would hand our crazyrouter credential to openrouter.ai and 401 like a routing bug.
  if (l === "openrouter")
    return { provider: "openrouter", base: CFG.bases.openrouter, rewriteModel: model || undefined,
             ...(CFG.openrouterKey ? { authToken: CFG.openrouterKey } : {}), reason };
  // Same rule, same reason: `authToken`, never `injectKey`. Their bearer works on BOTH surfaces —
  // OpenAI /v1/chat/completions and native /v1/messages (verified 2026-08-04), so nothing here has
  // to know which shape the caller sent.
  if (l === "freeaiapikey")
    return { provider: "freeaiapikey", base: CFG.bases.freeaiapikey, rewriteModel: model || undefined,
             ...(CFG.freeaiapikeyKey ? { authToken: CFG.freeaiapikeyKey } : {}), reason };
  return { provider: "crazyrouter", base: CFG.bases.crazyrouter, injectKey: true, rewriteModel: model || undefined, reason };
}

// Where unknown / empty / crazyrouter-blocked models go. provider "none" → blocked (caller gets 400).
function defaultRouteResolved(why) {
  const d = CFG.defaultRoute || { provider: "none" };
  if (!d.provider || d.provider === "none" || !d.model) return { provider: "blocked", blocked: true, why, reason: why + "; no default route" };
  return { ...providerRoute(d.provider, d.model, `default route (${why})`), via: "default" };
}

// Turn a per-project / per-group rule ({provider,model} or {block:true}) into a concrete route.
// Returns null for an allowlist-only rule: it has nothing to say about WHERE the call goes, only
// about where it may end up, so routing must fall through to the normal chain and be checked after.
function projectRule(rule, m, label) {
  if (rule.block)
    return { provider: "blocked", blocked: true, why: `${label} is blocked (token spend disabled)`, reason: `blocked: ${label}` };
  if (!rule.provider) return null;
  return providerRoute(rule.provider, rule.model || m, `override: ${label}`);
}
// The rule that governs `pkey`, resolved exactly like accountFor(): exact path, then the consumer.
// A rule is a property of WHO calls, not of which workload they run — before this,
// `projectRoutes.promopilot` matched only the literal string `promopilot` and every job under it
// (`promopilot:generatetext`) silently ignored the pin. Grouping many consumers under one rule is
// the consumer's job (name them alike, pin each) — not the router's.
function projectRuleFor(pkey) {
  const pr = CFG.projectRoutes || {};
  if (pr[pkey]) return { rule: pr[pkey], label: `project ${pkey}` };
  const { consumer } = parseConsumer(pkey);
  if (consumer && pr[consumer]) return { rule: pr[consumer], label: `consumer ${consumer}` };
  return null;
}

// Apply a rule's allowlists to an already-resolved route. Refuses; never rewrites — silently
// substituting an allowed model is exactly the "answer anyway with something else" behaviour that
// invariant 2 exists to forbid. An absent or empty list is no restriction.
function enforceAllow(r, m, rule, label) {
  if (!r || r.blocked) return r;
  const ap = rule.allowProviders || [];
  if (ap.length && !ap.includes(r.provider))
    return { provider: "blocked", blocked: true, allowDenied: true,
             why: `${label}: provider '${r.provider}' is not allowed here (allowed: ${ap.join(", ")})`,
             reason: `not allowed: provider ${r.provider}` };
  const am = rule.allowModels || [];
  const sent = String(r.rewriteModel || m || "").toLowerCase();
  if (am.length && !am.includes(sent))
    return { provider: "blocked", blocked: true, allowDenied: true,
             why: `${label}: model '${sent || "(none)"}' is not allowed here (allowed: ${am.join(", ")})`,
             reason: `not allowed: model ${sent || "(none)"}` };
  return r;
}

// ── per-project usage limits ────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Resolve the effective limit for a project. null = no limit.
// Resolved exactly like accountFor() and projectRuleFor(): exact path, then the consumer. A cap is a
// property of WHO calls, not of which workload they run — a limit on `promopilot` has to cover
// `promopilot:generatetext`, because the jobs are where the traffic actually is (`promopilot` itself
// logged 4 calls while its three jobs had ~30k between them). It did not: limitFor matched the
// literal string only, so a cap set on a consumer fell straight through to projectLimitDefault and
// every job under it ran uncapped. That is the same trap projectRoutes hit and fixed in 2026-07-09,
// left standing in the one control whose whole job is to stop an app draining the shared pool.
//
// Returns the scope it matched at, because the cap and the meter must agree: a consumer-scoped cap
// has to count the consumer's jobs together, or three jobs each get the full allowance and the
// "cap" is three times what it says (see projectUsage's byConsumer).
function resolveLimit(project) {
  if (!project) return null;
  const k = String(project).trim().toLowerCase();
  const pl = CFG.projectLimits || {};
  const at = (key, scope, byConsumer) => {
    const e = pl[key];
    return (e && (e.tokens > 0 || e.calls > 0)) ? { lim: e, scope, byConsumer } : null; // all-zero entry = exempt
  };
  // An exact-path entry decides outright, INCLUDING an all-zero one: exempting a single greedy job
  // from its consumer's cap has to be expressible, so `promopilot:cheapjob: {0,0}` means exempt and
  // must not fall through to the consumer's cap or to the default.
  // What it METERS still depends on which key it is, though. A key that IS a bare consumer name is
  // the consumer's cap however it was reached, so it has to fold
  // that consumer's jobs in; hard-coding byConsumer:false here meant a call arriving without a job
  // suffix was metered only against traffic that also arrived without one. Same config, same
  // consumer, two different buckets, decided by whether the caller happened to send X-Job: a
  // `promopilot` cap of 100k was bypassable by bare calls while `promopilot:generatetext` correctly
  // saw the aggregate and 429'd. It failed in the spend-more direction, and the traffic pattern is
  // real — this router exists partly because `promopilot` logged 4 bare calls beside ~30k from its
  // jobs. A job-specific key (`promopilot:heavy`) still meters only itself, which is the point of
  // being able to write one.
  if (Object.prototype.hasOwnProperty.call(pl, k)) {
    const { consumer: kc } = parseConsumer(k);
    return at(k, k, kc === k);
  }
  const { consumer } = parseConsumer(k);
  if (consumer && consumer !== k && Object.prototype.hasOwnProperty.call(pl, consumer)) {
    return at(consumer, consumer, true);
  }
  const d = CFG.projectLimitDefault;
  // The default is per-path, not per-consumer: it is a blanket "nobody should exceed this", and
  // widening it to fold every job of a consumer together would silently tighten it for anyone who
  // never configured a cap at all.
  if (d && (d.tokens > 0 || d.calls > 0)) return { lim: d, scope: k, byConsumer: false };
  return null;
}
function limitFor(project) {
  const r = resolveLimit(project);
  return r ? r.lim : null;
}
// Rolling-window usage for a project from the call log, cached ~5s to avoid per-request SUMs.
// `tokens` is BILLABLE tokens — total minus cache reads — not raw total_tokens. A cached read costs
// ~0.1x and barely moves the Max 5h/7d window, so quota'ing on the raw total punishes exactly the
// behaviour the cache breakpoints exist to produce: after the 2026-07-25 fix `autonoma` re-sends an
// 86k-token prefix per turn at 98% cache hit, which reads as ~2B total_tokens/day but burns the
// subscription like ~40M. A cap on the raw number would throttle a well-cached app off the pool while
// an uncached one at 1/50th the total sailed through. The window is what we are protecting, so the
// quota must count what actually spends it.
const _usageCache = new Map();
// `byConsumer` folds every job under `project` into one figure — `split_part(project,':',1)`, the
// same first-colon split parseConsumer() uses, NOT a LIKE prefix (a consumer named `pmac_claude`
// would have `_` read as a wildcard and swallow another consumer's usage). Used when the cap was
// resolved at consumer scope, so the meter measures what the cap actually governs.
async function projectUsage(project, windowMs, byConsumer = false) {
  if (!dbUp() || !project) return { tokens: 0, calls: 0 };
  const key = project + "|" + windowMs + (byConsumer ? "|c" : ""), now = Date.now(), c = _usageCache.get(key);
  if (c && now - c.at < 5000) return c.val;                 // ~5s cache: this is on the hot path
  let val = { tokens: 0, calls: 0 };
  // GREATEST(...,0): cache_read is part of prompt_tokens (normalizeUsage folds it in), but a row
  // written before that held or from a provider that reports them separately could go negative.
  const r = await dbRow(
    "SELECT COUNT(*)::int AS calls, " +
    "COALESCE(SUM(GREATEST(COALESCE(total_tokens,0) - COALESCE(cache_read,0), 0)),0)::bigint AS tokens " +
    "FROM calls WHERE " + (byConsumer ? "split_part(project,':',1)=$1" : "project=$1") + " AND ts>=$2",
    [project, now - windowMs]);
  // dbRow swallows errors and returns null → treat as no usage. A quota check must never be the
  // reason an inference request fails.
  if (r) val = { tokens: Number(r.tokens) || 0, calls: Number(r.calls) || 0 };
  _usageCache.set(key, { at: now, val });
  return val;
}
// Decide what to do for this project right now. null = no limit configured.
// action ∈ ok | warn | slow | block. pct = max(token%, call%) of the cap.
// Usage limits are a PROJECT (app) control only — a developer at a keyboard is never quota-throttled
// or blocked. A dev consumer short-circuits to null before any cap is consulted.
async function usageVerdict(project) {
  if (_isDev(_consumerOf(project))) return null;
  const res = resolveLimit(project);
  if (!res) return null;
  const { lim, scope, byConsumer } = res;
  // Meter at the scope the cap was resolved at — a consumer's cap counts its jobs together.
  const u = await projectUsage(scope, WINDOW_MS[lim.window] || WINDOW_MS["24h"], byConsumer);
  const pt = lim.tokens > 0 ? u.tokens / lim.tokens : 0;
  const pc = lim.calls > 0 ? u.calls / lim.calls : 0;
  const pct = Math.max(pt, pc);
  let action = "ok";
  if (pct >= 1) action = lim.hard === "warn" ? "warn" : lim.hard === "slow" ? "slow" : "block";
  else if (pct >= lim.slowPct / 100) action = "slow";
  else if (pct >= lim.warnPct / 100) action = "warn";
  return { lim, usage: u, pct, action };
}

// ── app back-pressure on upstream 429 ─────────────────────────────────────
// When a PROJECT (app) draws a real 429 — its pinned account's quota window is spent — we pace that
// project's next requests so it stops hammering a dry account. This is a *slow*, not a fallback: the
// 429 still reaches the caller (invariant #2), we only add latency to the app's *subsequent* calls
// until it succeeds again. DEVELOPERS are never throttled — a person waiting at a keyboard is not the
// stampede we're damping. Keyed by consumer (before the ':'), escalates with consecutive 429s, and a
// single success clears it. In-memory, per-process — a restart forgives everyone, which is fine.
const APP_THROTTLE = new Map();   // consumer -> { until, level }
const T_BASE_MS = 1000, T_MAX_MS = 15000, T_COOLDOWN_MS = 60000, T_MAX_LVL = 8;
const _consumerOf = (project) => parseConsumer(project || "").consumer;
const _isDev = (consumer) => { const c = (CFG.consumers || {})[consumer]; return !!c && c.kind === "dev"; };
// Record a real upstream 429 for a project. No-op for devs and for an empty/unknown consumer.
function note429(project) {
  const consumer = _consumerOf(project);
  if (!consumer || _isDev(consumer)) return;
  const cur = APP_THROTTLE.get(consumer) || { level: 0 };
  APP_THROTTLE.set(consumer, { until: Date.now() + T_COOLDOWN_MS, level: Math.min(cur.level + 1, T_MAX_LVL) });
}
// A success clears the back-pressure — the account window has room again.
function note2xx(project) {
  const consumer = _consumerOf(project);
  if (consumer && APP_THROTTLE.has(consumer)) APP_THROTTLE.delete(consumer);
}
// ms to sleep before forwarding this project's request (0 = don't throttle). Devs: always 0.
function throttleDelay(project) {
  const consumer = _consumerOf(project);
  if (!consumer || _isDev(consumer)) return 0;
  const rec = APP_THROTTLE.get(consumer);
  if (!rec || Date.now() >= rec.until) { if (rec) APP_THROTTLE.delete(consumer); return 0; }
  return Math.min(T_BASE_MS * (2 ** (rec.level - 1)), T_MAX_MS);
}
// Read-only snapshot of who is currently back-pressured (for adminState / the throttle watcher).
// Prunes expired records as it walks, so it never reports a throttle that has already cooled.
function throttleSnapshot() {
  const now = Date.now(), out = [];
  for (const [consumer, rec] of APP_THROTTLE) {
    if (!rec || now >= rec.until) { APP_THROTTLE.delete(consumer); continue; }
    out.push({ consumer, level: rec.level, ms: Math.min(T_BASE_MS * (2 ** (rec.level - 1)), T_MAX_MS), until: rec.until });
  }
  return out;
}

// Resolve a model name into a concrete upstream route. Priority:
//   0a. projectRoutes (exact per-project override, then per-consumer — beats everything)
//   1. forceModel (global override)  2. modelRoutes (per-model, any provider)  3. local alias map

// ── account selection: PINNED per project, never automatic ────────────────
// One project → one account, decided by config alone. There is deliberately NO auto-rotation:
// a silent account switch is a full prompt-cache miss (~12x cost) AND it makes "who spent this?"
// unanswerable after the fact. If the pinned account is out of quota, its real 429 reaches the
// caller. You fix that by re-pinning in the panel — not by the gateway guessing.
//
// `acctHealth` exists for DISPLAY and DEBUGGING only. It never influences which account is chosen.
// Synchronous read of the latest per-account headroom, because adminState() is synchronous and the
// DB is now a network hop away. ACCT_CACHE is filled by recordLimits() off live traffic and primed
// once at boot (see primeAcctCache), so this never blocks and never awaits.
function acctHealth(org) {
  try {
    const r = org ? ACCT_CACHE.get(org) : null;
    if (!r) return { util: 0, hot: false, ts: 0, stale: true };
    const stale = !r.ts || (Date.now() - r.ts > 6 * 3600 * 1000);   // no fresh reading → unknown, not "cool"
    const util = stale ? 0 : Math.max(r.u5 || 0, r.u7 || 0);
    const hot = !stale && ((r.u5 || 0) >= 0.95 || (r.u7 || 0) >= 0.98 || r.s5 === "rejected" || r.s7 === "rejected");
    return { util, hot, ts: r.ts || 0, stale };
  } catch { return { util: 0, hot: false, ts: 0, stale: true }; }
}

// ── auto account selection (opt-in, 2026-07-12) ────────────────────────────
// CFG.accountStrategy = "soonest-weekly-reset": APP consumers (registry kind "app") are served by
// the pool account whose WEEKLY (7d) window resets soonest and is usable right now. Rationale: the
// account about to reset forfeits its unused headroom at the reset, so burning it first wastes least.
//
// This is a deliberate, narrow exception to "one project → one account, no rotation":
//   • it orders on harvested reset7 timestamps, which only move when a window actually rolls — so
//     the selection hops roughly WEEKLY, not per request (a per-request rotation is the ~12x
//     prompt-cache blowout the invariant forbids);
//   • attribution survives: every call still logs `claudecode:<account>` in key_label;
//   • devs (kind "dev") and unregistered consumers are untouched — a human's session never hops.
//     "any-available" is the mode that lifts exactly that exclusion; see accountFor();
//   • it is data-driven only: an account with no weekly reading is NOT a candidate, and if no
//     account has one, selection returns null and the pin decides. Never hop blind.
// "Usable" = login alive (not ACCT_DEAD), weekly not spent, and 5h window not currently rejected.
// The harvested reading for an account (or null), and whether it is SPENT right now (would 429).
const acctReading = (a) => { const org = ORG_OF_ACCOUNT.get(a.name) || a.org; return (org && ACCT_CACHE.get(org)) || null; };
function acctSpentNow(r, now) {
  if (!r) return false;                                           // no reading → presumed available, not spent
  // Both windows: spent ONLY while the reset is still ahead of us. A reading is a snapshot, and the
  // window it describes rolls on its own — past `reset`, "spent" describes a window that no longer
  // exists. The weekly branch used to omit this check, so a stale u7>=1 benched the account forever
  // (readings only refresh off traffic it is no longer picked to serve, or the 30-min sweep), and it
  // benched it at the worst possible moment: `soonest-weekly-reset` deliberately steers work to the
  // account about to reset, then this dropped that same account the instant it did — pushing pinned
  // apps onto a different account (prompt-cache miss) or, with a one-account pool, answering
  // `403 no_account_for_project` from an account with a full week of headroom.
  if ((r.s7 === "rejected" || (r.u7 || 0) >= 1) && (!r.reset7 || r.reset7 * 1000 > now)) return true; // weekly spent
  if ((r.s5 === "rejected" || (r.u5 || 0) >= 1) && (!r.reset5 || r.reset5 * 1000 > now)) return true; // 5h spent right now
  return false;
}
// ── runtime account cooldown (2026-07-24) ──────────────────────────────────
// A real 429 means the account's CURRENT window is spent — but a 429 carries NO
// `anthropic-ratelimit-unified-*` headers, so recordLimits() cannot learn from it: the harvested
// reading can sit at u5≈0.9 while the account is actually dry. Without this, autoAccount() keeps
// re-picking the just-spent account and the app 429s in a loop until the window resets. This runtime
// set benches an account the instant it 429s so the auto-selector hops to the next AVAILABLE account
// on the very next request. It is NOT an in-request fallback (invariant #2): the 429 still reaches the
// caller; this only steers the NEXT pick. Cleared on the account's next success (real traffic or the
// live-limits probe), and self-prunes when the cooldown elapses. In-memory, per-process.
const ACCT_COOL = new Map();   // account name (lowercased) -> until-ms
const COOL_FLOOR_MS = 60 * 1000, COOL_CAP_MS = 8 * 86400 * 1000;
// Arm a cooldown for `name` after a 429. Duration = the spent window's own reset (weekly if the cached
// reading says weekly is spent, else the 5h reset), floored to 60s and honouring a Retry-After header,
// capped at 8d. With no cached reading we still bench it for the floor so the app hops off immediately.
function noteAcctCooldown(name, retryAfterSec) {
  if (!name) return;
  const now = Date.now();
  const r = acctReading({ name });                                // cached reading via ORG_OF_ACCOUNT
  let until = now + COOL_FLOOR_MS;
  if (retryAfterSec > 0) until = Math.max(until, now + retryAfterSec * 1000);
  if (r) {
    // Bench to a window's RESET only when the reading says that window is actually SPENT. A 429 on an
    // account with headroom is a burst/concurrency limit, not an exhausted window — and the old code
    // fell through to `r.reset5` for ANY 429, so one transient 429 on a 8%-utilised account benched it
    // for its whole 5h window. On 2026-07-25 that took the only healthy account out of the pool and
    // every app got `403 no_account_for_project` for five minutes (16:41–16:46 UTC) while five of the
    // eight logins were genuinely spent. No window spent ⇒ the 60s floor / Retry-After only.
    const weeklySpent = r.s7 === "rejected" || (r.u7 || 0) >= 1;  // which window drew the 429?
    const fiveSpent = r.s5 === "rejected" || (r.u5 || 0) >= 1;
    const resetSec = weeklySpent ? r.reset7 : fiveSpent ? r.reset5 : 0;
    if (resetSec) until = Math.max(until, resetSec * 1000);       // anthropic resets are epoch SECONDS
  }
  ACCT_COOL.set(String(name).toLowerCase(), Math.min(until, now + COOL_CAP_MS));
}
function acctCooling(name, now) {
  const k = String(name || "").toLowerCase();
  const until = ACCT_COOL.get(k);
  if (until == null) return false;
  if (now >= until) { ACCT_COOL.delete(k); return false; }        // self-prune on read
  return true;
}
function clearAcctCooldown(name) { if (name) ACCT_COOL.delete(String(name).toLowerCase()); }

// "Usable" = not config-disabled, the login is alive (not OAuth-disabled), not in a post-429 cooldown,
// AND no window is currently spent. A no-reading account counts as usable (presumed available) — we
// only exclude what we KNOW is disabled, dead, cooling, or spent. `a.disabled` is the operator flag;
// ACCT_DEAD is what the live probe found; ACCT_COOL is what a real 429 just told us.
const acctUsable = (a, now) => !a.disabled && !ACCT_DEAD.has(a.name) && !acctCooling(a.name, now) && !acctSpentNow(acctReading(a), now);
// The first usable account, deterministic by name — a STABLE pick (same account until its state
// changes), so serving from it does NOT rotate per request and preserves the per-org prompt cache.
function firstUsableAccount(now) {
  return (CFG.claudecodeAccountPool || [])
    .filter((a) => acctUsable(a, now))
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))[0] || null;
}

let _autoName = null;   // last pick, for change-logging only

// Below this much of the window left, an account is effectively out even though
// `acctSpentNow()` still calls it usable — that only excludes a window at the cap, so
// 96% counted as fully available, and ordering by soonest reset then PREFERRED it (the
// account closest to forfeiting is usually the one closest to spent). Measured
// 2026-08-04: bofrid was handed `claude4` (u7=0.96) and `emphyx` (0.72) call after call
// while `claude2mejlto` sat at 0. A margin, not `>= 1`, because the reading is a
// whole-account aggregate off Haiku and the higher tiers run dry well before 1.0.
const HEADROOM_FLOOR = 0.15;

function autoAccount() {
  const now = Date.now();
  const cand = [];
  for (const a of CFG.claudecodeAccountPool || []) {
    if (!acctUsable(a, now)) continue;                            // dead login or a spent window
    const r = acctReading(a);
    if (!r || !r.reset7) continue;                                // no weekly reading → not orderable here (Tier B handles it)
    const reset7ms = r.reset7 * 1000;                             // anthropic resets are epoch SECONDS
    if (reset7ms <= now) continue;                                // window already rolled; reading is stale
    cand.push({ a, reset7ms, left: 1 - Math.max(Number(r.u5) || 0, Number(r.u7) || 0) });
  }
  if (!cand.length) return null;

  // Burning the about-to-forfeit weekly window first is still the strategy — but only
  // among accounts that have something left to burn. When none do, take the least-spent
  // rather than the soonest-to-reset, which is the pick that was returning 429s.
  const roomy = cand.filter((c) => c.left >= HEADROOM_FLOOR);
  const pool = roomy.length ? roomy : cand;
  pool.sort((x, y) =>
    roomy.length
      ? x.reset7ms - y.reset7ms || (x.a.name < y.a.name ? -1 : x.a.name > y.a.name ? 1 : 0)
      : y.left - x.left || (x.a.name < y.a.name ? -1 : x.a.name > y.a.name ? 1 : 0),
  );

  const best = pool[0].a;
  if (best.name !== _autoName) {
    console.log(
      `[route] auto account -> ${best.name} (${Math.round(pool[0].left * 100)}% left, weekly reset ` +
        `${new Date(pool[0].reset7ms).toISOString()}${roomy.length ? "" : ", NOTHING above the headroom floor"})`,
    );
    _autoName = best.name;
  }
  return best;
}

// The account a project bills to, or null. Resolution is exactly two steps, both explicit:
//   1. projectAccounts[project]  — the pin, edited in the panel
//   2. CFG.defaultAccount        — one named fallback, also explicit
// No request header can override it. Deterministic: same project ⇒ same account, every time.
// Exceptions: accountStrategy "soonest-weekly-reset" auto-selects for APP consumers, "any-available"
// for everyone including the unpinned (see autoAccount).
// (`consumerAccounts` is the pre-rename name of `projectAccounts`; both are read during migration.)
// Persistently mark an account disabled after a 403 permission_error (a dead/cancelled login —
// "OAuth authentication is currently not allowed for this organization"). Called from BOTH the live
// limits probe (claudecode.js) and real inference traffic (http.js), so a login that dies is taken
// out of routing automatically, and the mark survives a restart (ACCT_DEAD alone does not). Mutates
// the pool in place — CFG is never reassigned — and persists. Idempotent; never auto-RE-enables (a
// dead subscription coming back is an operator decision, and auto-flapping a pin is churn we forbid).
// Returns the stranded projects (pins that now resolve to no account) for logging.
function autoDisableAccount(name, why) {
  const pool = CFG.claudecodeAccountPool || [];
  const a = pool.find((x) => String(x.name).toLowerCase() === String(name || "").toLowerCase());
  if (!a || a.disabled) return null;
  a.disabled = true;
  CFG.anthropicPool = CFG.claudecodeAccountPool = pool;   // legacy name kept in sync (see admin.js)
  const persisted = persistConfig();
  const pins = CFG.projectAccounts || CFG.consumerAccounts || {};
  const stranded = Object.keys(pins).filter((pj) => String(pins[pj]).toLowerCase() === String(a.name).toLowerCase()).sort();
  console.warn(`[account] AUTO-DISABLED name=${a.name} reason=${why || "OAuth disabled (403 permission_error)"} stranded=${stranded.join(",") || "-"} persisted=${persisted}`);
  return stranded;
}

function accountFor(project) {
  const pool = CFG.claudecodeAccountPool || [];
  if (!pool.length) return null;
  const p = String(project == null ? "" : project).trim().toLowerCase();
  const pins = CFG.projectAccounts || CFG.consumerAccounts || {};
  // Try the exact path first, then fall back to the consumer. A pin is a property of WHO is calling,
  // not of which workload they are running: pinning `promopilot` must cover `promopilot:l2_metadata`
  // without pinning every job by hand. An exact-path pin still wins, so one greedy job can be moved
  // to its own account without moving the rest.
  const { consumer } = parseConsumer(p);
  const want = String((p && pins[p]) || (consumer && pins[consumer]) || CFG.defaultAccount || "").trim().toLowerCase();
  let pinned = want ? (pool.find((a) => String(a.name).toLowerCase() === want) || null) : null;
  // A disabled account is never served, even when explicitly pinned: null it out so the caller gets
  // the honest `403 no_account_for_project` (re-pin the project) rather than a request to a dead
  // subscription. This is the "so we don't try to use it" guarantee for a disabled login.
  if (pinned && pinned.disabled) pinned = null;

  // "any-available" = the same selection, applied to EVERY caller and to callers with no pin at
  // all. It knowingly waives two things: invariant 3's 403 (a typo'd consumer is served, not
  // refused) and a dev's stable account (a hop is a full prompt-cache miss on boxes running ~95%
  // hits). Both are the point, not oversights — hence opt-in. Attribution survives via key_label,
  // and the pick is still stable by name, so it moves on state changes and never per request.
  const strategy = CFG.accountStrategy;
  if (strategy === "soonest-weekly-reset" || strategy === "any-available") {
    const reg = (CFG.consumers || {})[consumer];
    if (strategy === "any-available" || (reg && reg.kind === "app")) {
      const now = Date.now();
      // Tier A — the soonest-to-reset USABLE account (burn the about-to-forfeit weekly window first).
      const auto = autoAccount();
      if (auto) return auto;
      // Tier A empty (no orderable weekly reading). "Use whatever account is available": don't break
      // the app on a dead/spent pin. Keep the pin while IT can still serve (stable, cache-preserving);
      // otherwise serve from any available account, deterministic by name so the pick can't rotate per
      // request. Only when EVERY account is dead/spent do we fall to the pin, so the caller gets ITS
      // own 429/403 — a truthful "out of quota", never a silent guess.
      if (pinned && acctUsable(pinned, now)) return pinned;
      const any = firstUsableAccount(now);
      if (any) return any;
      return pinned;
    }
  }
  return pinned;
}

function resolveRoute(model, project) {
  const m = model == null ? "" : String(model);
  const key = m.toLowerCase();
  const pkey = project == null ? "" : String(project).trim().toLowerCase();
  // `imagegen` is routed by PATH, not by model id. Asking for it on a text endpoint used to fall all
  // the way through to crazyrouter — the one provider that bills per token — and come back as their
  // 404. Reject it here, next to the id it names, rather than 200 miles downstream at someone's till.
  if (isImageModel(key))
    return { provider: "blocked", blocked: true, why: `'${key}' is an image model — POST it to /v1/images/generations, not a chat endpoint`,
             reason: "image model on a text endpoint" };
  const hit = pkey ? projectRuleFor(pkey) : null;
  if (hit) {
    const pinned = projectRule(hit.rule, m, hit.label);
    return enforceAllow(pinned || baseRoute(m, key), m, hit.rule, hit.label);
  }
  return baseRoute(m, key);
}

// Routing with no project rule in play: global force → per-model override → local alias → claude* →
// crazyrouter policy → default route.
function baseRoute(m, key) {
  if (CFG.forceModel && CFG.forceModel.enabled && CFG.forceModel.model)
    return providerRoute(CFG.forceModel.provider, CFG.forceModel.model, "forced (global)");
  if (CFG.modelRoutes && CFG.modelRoutes[key])
    return providerRoute(CFG.modelRoutes[key].provider, CFG.modelRoutes[key].model || m, `override: ${key}`);
  const lt = localTarget(m);
  // Through providerRoute, not a hand-built object: it is the one place that knows WHICH local box
  // serves a given id (localBaseFor). Rebuilding the route here is how this branch kept pointing at
  // pbox for models that live on ww.
  if (lt) return providerRoute("local", lt, "local alias");
  if (isClaudeModel(m)) return { provider: "claudecode", base: CFG.bases.claudecode, reason: "claude* model" };
  if (!m) return defaultRouteResolved("no model specified");
  // BETWEEN claude* and the crazyrouter fallthrough, and both sides of that are load-bearing — see
  // the header of src/openrouter.js for which one bites on live data and which one guards a typo.
  // openrouterTarget() returns null unless the id is in their live catalogue AND passes the
  // free-only guard, so an unconfigured or unknown id falls through exactly as it did before.
  const or = openrouterTarget(m);
  if (or) return providerRoute("openrouter", or, "openrouter catalog");
  // AFTER openrouter and BEFORE the crazyrouter fallthrough, and both neighbours matter:
  //   • after openrouter, because the two catalogues OVERLAP on every id here —
  //     `anthropic/claude-opus-5` and `openai/gpt-5.6-sol` are real ids on both. openrouter is
  //     free-only by default and these are paid there, so it declines them and the order is moot
  //     today; turn openrouterFreeOnly OFF and openrouter starts winning them at list price.
  //     Free before paid is the rule; this is the cheaper paid one, not a free one.
  //   • before crazyrouter, which is the whole point: `cloudPolicy: "open"` forwards anything, and
  //     crazyrouter bills ~2x the input and ~2.5-3x the output for the same id (measured
  //     2026-08-04). Below the fallthrough this provider would never see a single call.
  const fa = freeaiapikeyTarget(m);
  if (fa) return providerRoute("freeaiapikey", fa, "freeaiapikey model list");
  const pol = CFG.cloudPolicy || "open";
  if (pol === "open") return { provider: "crazyrouter", base: CFG.bases.crazyrouter, injectKey: true, reason: "crazyrouter (open)" };
  if (pol === "allowlist" && (CFG.cloudAllowlist || []).some((x) => x.toLowerCase() === key))
    return { provider: "crazyrouter", base: CFG.bases.crazyrouter, injectKey: true, reason: "crazyrouter (allowlisted)" };
  return defaultRouteResolved(pol === "off" ? "crazyrouter provider disabled" : "not in crazyrouter allowlist");
}

module.exports = {
  resolveRoute, baseRoute, providerRoute, defaultRouteResolved, projectRule, projectRuleFor,
  enforceAllow, accountFor, autoAccount, autoDisableAccount, acctHealth, limitFor, resolveLimit, projectUsage, usageVerdict,
  localTarget, freeaiapikeyTarget, freeaiapikeyModelEntries, isClaudeModel, isGated, sleep,
  note429, note2xx, throttleDelay, throttleSnapshot,
  noteAcctCooldown, acctCooling, clearAcctCooldown,
};
