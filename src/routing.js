// WHERE a request goes, and whether it is allowed to go there.
//
// Two invariants live here and must not be "improved" away:
//   • No fallback. A 429 or a 5xx reaches the caller. Answering with a different model on a
//     different provider hides both the cost and the truth.
//   • One project, one account. accountFor() never rotates: rotation blows the per-org prompt
//     cache (~12x cost) and makes "who spent this?" unanswerable after the fact.
const { CFG, normProvider, isImageModel, WINDOW_MS } = require("./config");
const { parseConsumer } = require("./identity");
const { dbUp, dbRow, dbRows, ACCT_CACHE, ACCT_DEAD, ORG_OF_ACCOUNT } = require("./db");

const localTarget = (m) => (m == null ? null : CFG.localMap[String(m).toLowerCase()] || null);
// A `claude*` model id means the claudecode provider (our Max account pool → api.anthropic.com).
const isClaudeModel = (m) => typeof m === "string" && m.toLowerCase().startsWith((CFG.claudePrefix || "claude").toLowerCase());
const isGated = (target) => Array.isArray(CFG.gatedModels) && CFG.gatedModels.includes(target);

function providerRoute(provider, model, reason) {
  const l = normProvider(provider) || "crazyrouter";
  // claudecode: the pinned account's token is attached later (dispatch), not here.
  if (l === "claudecode") return { provider: "claudecode", base: CFG.bases.claudecode, rewriteModel: model || undefined, reason };
  if (l === "local") return { provider: "local", base: CFG.bases.local, rewriteModel: model, target: model, reason };
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
// Resolve the effective limit for a project: exact entry (authoritative) →
// projectLimitDefault (only when it actually caps something). null = no limit.
function limitFor(project) {
  if (!project) return null;
  const k = String(project).trim().toLowerCase();
  const pl = CFG.projectLimits || {};
  if (Object.prototype.hasOwnProperty.call(pl, k)) {
    const e = pl[k];
    return (e && (e.tokens > 0 || e.calls > 0)) ? e : null; // explicit all-zero entry = exempt
  }
  const d = CFG.projectLimitDefault;
  if (d && (d.tokens > 0 || d.calls > 0)) return d;
  return null;
}
// Rolling-window usage for a project from the call log, cached ~5s to avoid per-request SUMs.
const _usageCache = new Map();
async function projectUsage(project, windowMs) {
  if (!dbUp() || !project) return { tokens: 0, calls: 0 };
  const key = project + "|" + windowMs, now = Date.now(), c = _usageCache.get(key);
  if (c && now - c.at < 5000) return c.val;                 // ~5s cache: this is on the hot path
  let val = { tokens: 0, calls: 0 };
  const r = await dbRow(
    "SELECT COUNT(*)::int AS calls, COALESCE(SUM(total_tokens),0)::bigint AS tokens FROM calls WHERE project=$1 AND ts>=$2",
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
  const lim = limitFor(project);
  if (!lim) return null;
  const u = await projectUsage(project, WINDOW_MS[lim.window] || WINDOW_MS["24h"]);
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
//   • devs (kind "dev") and unregistered consumers are untouched — a human's session never hops;
//   • it is data-driven only: an account with no weekly reading is NOT a candidate, and if no
//     account has one, selection returns null and the pin decides. Never hop blind.
// "Usable" = login alive (not ACCT_DEAD), weekly not spent, and 5h window not currently rejected.
// The harvested reading for an account (or null), and whether it is SPENT right now (would 429).
const acctReading = (a) => { const org = ORG_OF_ACCOUNT.get(a.name) || a.org; return (org && ACCT_CACHE.get(org)) || null; };
function acctSpentNow(r, now) {
  if (!r) return false;                                           // no reading → presumed available, not spent
  if (r.s7 === "rejected" || (r.u7 || 0) >= 1) return true;       // weekly spent — 429s until reset7
  if ((r.s5 === "rejected" || (r.u5 || 0) >= 1) && (!r.reset5 || r.reset5 * 1000 > now)) return true; // 5h spent right now
  return false;
}
// "Usable" = not config-disabled, the login is alive (not OAuth-disabled), AND no window is currently
// spent. A no-reading account counts as usable (presumed available) — we only exclude what we KNOW is
// disabled, dead, or spent. `a.disabled` is the operator flag; ACCT_DEAD is what the live probe found.
const acctUsable = (a, now) => !a.disabled && !ACCT_DEAD.has(a.name) && !acctSpentNow(acctReading(a), now);
// The first usable account, deterministic by name — a STABLE pick (same account until its state
// changes), so serving from it does NOT rotate per request and preserves the per-org prompt cache.
function firstUsableAccount(now) {
  return (CFG.claudecodeAccountPool || [])
    .filter((a) => acctUsable(a, now))
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))[0] || null;
}

let _autoName = null;   // last pick, for change-logging only
function autoAccount() {
  const now = Date.now();
  let best = null, bestReset = Infinity;
  for (const a of CFG.claudecodeAccountPool || []) {
    if (!acctUsable(a, now)) continue;                            // dead login or a spent window
    const r = acctReading(a);
    if (!r || !r.reset7) continue;                                // no weekly reading → not orderable here (Tier B handles it)
    const reset7ms = r.reset7 * 1000;                             // anthropic resets are epoch SECONDS
    if (reset7ms <= now) continue;                                // window already rolled; reading is stale
    if (reset7ms < bestReset || (reset7ms === bestReset && best && a.name < best.name)) { best = a; bestReset = reset7ms; }
  }
  if (best && best.name !== _autoName) {
    console.log(`[route] auto account -> ${best.name} (weekly reset ${new Date(bestReset).toISOString()})`);
    _autoName = best.name;
  }
  return best;
}

// The account a project bills to, or null. Resolution is exactly two steps, both explicit:
//   1. projectAccounts[project]  — the pin, edited in the panel
//   2. CFG.defaultAccount        — one named fallback, also explicit
// No request header can override it. Deterministic: same project ⇒ same account, every time.
// Exception: accountStrategy "soonest-weekly-reset" auto-selects for APP consumers (see autoAccount).
// (`consumerAccounts` is the pre-rename name of `projectAccounts`; both are read during migration.)
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

  if (CFG.accountStrategy === "soonest-weekly-reset") {
    const reg = (CFG.consumers || {})[consumer];
    if (reg && reg.kind === "app") {
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
  if (lt) return { provider: "local", base: CFG.bases.local, rewriteModel: lt, target: lt, reason: "local alias" };
  if (isClaudeModel(m)) return { provider: "claudecode", base: CFG.bases.claudecode, reason: "claude* model" };
  if (!m) return defaultRouteResolved("no model specified");
  const pol = CFG.cloudPolicy || "open";
  if (pol === "open") return { provider: "crazyrouter", base: CFG.bases.crazyrouter, injectKey: true, reason: "crazyrouter (open)" };
  if (pol === "allowlist" && (CFG.cloudAllowlist || []).some((x) => x.toLowerCase() === key))
    return { provider: "crazyrouter", base: CFG.bases.crazyrouter, injectKey: true, reason: "crazyrouter (allowlisted)" };
  return defaultRouteResolved(pol === "off" ? "crazyrouter provider disabled" : "not in crazyrouter allowlist");
}

module.exports = {
  resolveRoute, baseRoute, providerRoute, defaultRouteResolved, projectRule, projectRuleFor,
  enforceAllow, accountFor, autoAccount, acctHealth, limitFor, projectUsage, usageVerdict,
  localTarget, isClaudeModel, isGated, sleep,
  note429, note2xx, throttleDelay, throttleSnapshot,
};
