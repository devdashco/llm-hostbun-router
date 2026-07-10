// WHERE a request goes, and whether it is allowed to go there.
//
// Two invariants live here and must not be "improved" away:
//   • No fallback. A 429 or a 5xx reaches the caller. Answering with a different model on a
//     different provider hides both the cost and the truth.
//   • One project, one account. accountFor() never rotates: rotation blows the per-org prompt
//     cache (~12x cost) and makes "who spent this?" unanswerable after the fact.
const { CFG, normProvider, isImageModel, WINDOW_MS } = require("./config");
const { parseConsumer } = require("./identity");
const { dbUp, dbRow, dbRows, ACCT_CACHE } = require("./db");

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
// First projectGroup whose prefix matches this project slug (exact or startsWith). null if none.
function matchProjectGroup(pkey) {
  for (const g of CFG.projectGroups || [])
    for (const pre of g.prefixes || [])
      if (pkey === pre || pkey.startsWith(pre)) return g;
  return null;
}

// The rule that governs `pkey`, resolved exactly like accountFor(): exact path, then the consumer,
// then a group. A rule is a property of WHO calls, not of which workload they run — before this,
// `projectRoutes.promopilot` matched only the literal string `promopilot` and every job under it
// (`promopilot:generatetext`) silently ignored the pin.
function projectRuleFor(pkey) {
  const pr = CFG.projectRoutes || {};
  if (pr[pkey]) return { rule: pr[pkey], label: `project ${pkey}` };
  const { consumer } = parseConsumer(pkey);
  if (consumer && pr[consumer]) return { rule: pr[consumer], label: `consumer ${consumer}` };
  const g = matchProjectGroup(pkey);
  if (g) return { rule: g, label: `group ${g.name}` };
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
// Resolve the effective limit for a project: exact entry (authoritative) → matching
// group's .limit → projectLimitDefault (only when it actually caps something). null = no limit.
function limitFor(project) {
  if (!project) return null;
  const k = String(project).trim().toLowerCase();
  const pl = CFG.projectLimits || {};
  if (Object.prototype.hasOwnProperty.call(pl, k)) {
    const e = pl[k];
    return (e && (e.tokens > 0 || e.calls > 0)) ? e : null; // explicit all-zero entry = exempt
  }
  const g = matchProjectGroup(k);
  if (g && g.limit && (g.limit.tokens > 0 || g.limit.calls > 0)) return g.limit;
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
async function usageVerdict(project) {
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

// Resolve a model name into a concrete upstream route. Priority:
//   0a. projectRoutes (exact per-project override — beats everything, incl. group rules)
//   0b. projectGroups (prefix-matched group override)
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

// The account a project bills to, or null. Resolution is exactly two steps, both explicit:
//   1. projectAccounts[project]  — the pin, edited in the panel
//   2. CFG.defaultAccount        — one named fallback, also explicit
// No request header can override it. Deterministic: same project ⇒ same account, every time.
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
  if (!want) return null;
  return pool.find((a) => String(a.name).toLowerCase() === want) || null;
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
  matchProjectGroup, enforceAllow, accountFor, acctHealth, limitFor, projectUsage, usageVerdict,
  localTarget, isClaudeModel, isGated, sleep,
};
