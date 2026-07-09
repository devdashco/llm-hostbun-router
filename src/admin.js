// The control-plane API. Password-gated with an HMAC cookie; every mutating route logs who and what.
//
// The /admin/api/* prefix is a COMPATIBILITY CONTRACT, not a security boundary — claudectl's proxy_*
// tools hardcode it (claudectl/server/claudectl_server.py). /api/* is the alias the panel itself
// uses. The cookie is the gate; the prefix is just a name.
//
// Three endpoints deliberately MERGE instead of replacing, because POST config assigns its fields
// wholesale and a save built from a stale render would delete every sibling:
//   • /pins    one project -> account
//   • /routes  one project -> rule
//   • /consumers, /consumers/keys  one registry entry
const crypto = require("node:crypto");
const fs = require("node:fs");
const TR = require("../translate");
const C = require("./config");
const { CFG, setCFG, persistConfig, mergeConfig, envDefaults, loadConfig, reindexKeys, CANON, OBLIT, E4B,
        PROVIDERS, normProvider, sanitizeRule, sanitizeLimit, IMAGE_MODEL_IDS, CONFIG_FILE } = C;
const DB = require("./db");
const { dbUp, dbRows, ACCT_CACHE, ORG_OF_ACCOUNT, PROBE_CACHE, FACET_CACHE } = DB;
const { priceMap, costUsd } = require("./pricing");
const { mintKey, sha256, parseConsumer } = require("./identity");
const { resolveRoute, accountFor, acctHealth, isGated, localTarget } = require("./routing");
const { readBody, sendJson, mask, buildHeaders } = require("./http");
const CC = require("./claudecode");
const { probeAccount, refreshClaudecodeModels, upstreamCatalogs, localModelEntries } = CC;

// ─────────────────────────────────────────────────────────────────────────────
const COOKIE = "hb_admin";
const sign = (payload) => crypto.createHmac("sha256", CFG.adminPassword).update(payload).digest("hex");
function makeSession(ttlMs = 7 * 24 * 3600 * 1000) {
  const payload = `exp=${Date.now() + ttlMs}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}
function validSession(val) {
  if (!val) return false;
  const [b, sig] = String(val).split(".");
  if (!b || !sig) return false;
  let payload;
  try { payload = Buffer.from(b, "base64url").toString(); } catch { return false; }
  const expect = sign(payload);
  if (sig.length !== expect.length) return false;
  try { if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false; } catch { return false; }
  const m = payload.match(/exp=(\d+)/);
  return !!m && Date.now() < parseInt(m[1], 10);
}
function getCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
const isAuthed = (req) => validSession(getCookie(req, COOKIE));

// Naive per-IP login throttle: max 10 attempts / 5 min.
const loginHits = new Map();
// Trusted IPs bypass the admin-login throttle entirely (our own fleet's egress —
// they're never a brute-force threat). Set ADMIN_TRUSTED_IPS=ip1,ip2,… in the env.
const ADMIN_TRUSTED_IPS = new Set(
  (process.env.ADMIN_TRUSTED_IPS || "").split(",").map((s) => s.trim()).filter(Boolean),
);
function throttled(ip) {
  if (ADMIN_TRUSTED_IPS.has(ip)) return false;   // our fleet — zero limit
  const now = Date.now();
  const rec = loginHits.get(ip) || { n: 0, reset: now + 300000 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 300000; }
  rec.n++;
  loginHits.set(ip, rec);
  if (loginHits.size > 5000) loginHits.clear();
  return rec.n > 30;   // fleet shares one egress IP; cccc now caches the cookie so real logins are rare
}

function adminState() {
  return {
    providers: PROVIDERS,
    bases: CFG.bases,
    localMap: CFG.localMap,
    gatedModels: CFG.gatedModels,
    claudePrefix: CFG.claudePrefix,
    claudecodeModels: CFG.claudecodeModels,
    forceModel: CFG.forceModel,
    modelRoutes: CFG.modelRoutes,
    projectRoutes: CFG.projectRoutes,
    projectAccounts: CFG.projectAccounts,
    consumerAccounts: CFG.consumerAccounts,   // legacy alias, same map
    defaultAccount: CFG.defaultAccount,
    projectGroups: CFG.projectGroups,
    projectLimits: CFG.projectLimits,
    projectLimitDefault: CFG.projectLimitDefault,
    cloudPolicy: CFG.cloudPolicy,
    cloudAllowlist: CFG.cloudAllowlist,
    defaultRoute: CFG.defaultRoute,
    jsonEnforce: CFG.jsonEnforce,
    jsonMaxRetries: CFG.jsonMaxRetries,
    requireProject: CFG.requireProject,
    requireRegisteredConsumer: CFG.requireRegisteredConsumer,
    // Redacted: the entry carries key HASHES, and adminState is the broadest thing this API returns.
    // A sha256 of 32 random bytes is not worth cracking, but it is a credential derivative and it has
    // no business in a dashboard payload. `activeKeys` is all the UI needs from here.
    consumers: Object.fromEntries(Object.entries(CFG.consumers || {}).map(([n, e]) =>
      [n, { kind: e.kind, owner: e.owner, note: e.note, activeKeys: (e.keys || []).filter((k) => !k.revoked).length }])),
    authMode: (CFG.auth && CFG.auth.mode) || "optional",
    logging: CFG.logging,
    loggingDbReady: dbUp(),
    // secrets — never returned in clear
    crazyrouterKeySet: !!CFG.crazyrouterKey, crazyrouterKeyMasked: mask(CFG.crazyrouterKey),
    // Each account carries its harvested headroom AND the age of that reading, so any consumer
    // (admin UI, statusline) can render "hot/cool" together with "as of when" — never a stale
    // number presented as fresh. `stale:true` = no reading in 6h; show it as unknown, not cool.
    claudecodeAccountPool: (CFG.claudecodeAccountPool || []).map((a) => {
      const h = acctHealth(a.org);
      return { name: a.name, org: a.org, tokenMasked: mask(a.token),
               util: h.util, hot: h.hot, ts: h.ts, stale: h.stale };
    }),
    // No sticky account exists any more: selection is pinned per project (accountFor).
    defaultAccount: CFG.defaultAccount || null,
    oblitTokenSet: !!CFG.oblitToken, oblitTokenMasked: mask(CFG.oblitToken),
    adminPasswordMasked: mask(CFG.adminPassword),
    configFile: CONFIG_FILE,
    configPersisted: fs.existsSync(CONFIG_FILE),
    knownLocalIds: { e4b: E4B, gemma: CANON, obliterated: OBLIT },
  };
}


async function probe(base, authToken) {
  const t0 = Date.now();
  try {
    const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const r = await fetch(base + "/v1/models", { headers, signal: AbortSignal.timeout(12000) });
    let count;
    try { const j = await r.json(); count = (j && j.data && j.data.length) || undefined; } catch { /* non-json */ }
    return { up: r.ok, status: r.status, ms: Date.now() - t0, count };
  } catch (e) { return { up: false, status: 0, ms: Date.now() - t0, error: e.message }; }
}

// Check a crazyrouter key (defaults to the configured one): billing + catalog reachability.
async function crazyCheck(key) {
  const k = key || CFG.crazyrouterKey;
  const out = { keySet: !!k, keyMasked: mask(k) };
  if (!k) return { ...out, error: "no key set" };
  const base = CFG.bases.crazyrouter;
  const hdr = { authorization: `Bearer ${k}` };
  async function get(p) {
    try {
      const r = await fetch(base + p, { headers: hdr, signal: AbortSignal.timeout(12000) });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, ok: r.ok, json: j, text: t };
    } catch (e) { return { status: 0, ok: false, error: e.message }; }
  }
  const [sub, usage, models] = await Promise.all([
    get("/dashboard/billing/subscription"), get("/dashboard/billing/usage"), get("/v1/models"),
  ]);
  out.keyValid = models.ok && !(sub.json && sub.json.error);
  if (sub.json && typeof sub.json.hard_limit_usd === "number") out.hardLimitUsd = sub.json.hard_limit_usd;
  if (usage.json && typeof usage.json.total_usage === "number") out.totalUsageUsd = usage.json.total_usage / 100; // cents
  if (out.hardLimitUsd != null && out.totalUsageUsd != null) out.remainingUsd = Math.round((out.hardLimitUsd - out.totalUsageUsd) * 100) / 100;
  out.modelCount = (models.json && models.json.data && models.json.data.length) || 0;
  out.statuses = { subscription: sub.status, usage: usage.status, models: models.status };
  const errMsg = (sub.json && sub.json.error && sub.json.error.message) || (models.json && models.json.error && models.json.error.message);
  if (errMsg) out.message = errMsg;
  return out;
}

// Run a chat completion through current routing (admin is trusted → auto-injects the gate token).
async function adminTest(model, prompt, maxTokens) {
  const route = resolveRoute(model);
  const headers = { "content-type": "application/json" };
  if (route.provider === "crazyrouter") headers.authorization = `Bearer ${CFG.crazyrouterKey}`;
  else if (route.provider === "local" && isGated(route.target) && CFG.oblitToken) headers.authorization = `Bearer ${CFG.oblitToken}`;
  const sendModel = route.rewriteModel || model;
  const body = { model: sendModel, messages: [{ role: "user", content: prompt || "Reply with a short greeting." }], max_tokens: maxTokens || 256, stream: false };
  const t0 = Date.now();
  try {
    const r = await fetch(route.base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    const m = j && j.choices && j.choices[0] && j.choices[0].message;
    const content = (m && (m.content || m.reasoning_content)) || null;
    return { ok: r.ok, status: r.status, provider: route.provider, sentModel: sendModel, ms: Date.now() - t0, content, raw: content == null ? text.slice(0, 2000) : undefined };
  } catch (e) { return { ok: false, status: 0, provider: route.provider, sentModel: sendModel, ms: Date.now() - t0, error: e.message }; }
}

async function handleAdminApi(req, res, path, prefix = "/admin/api/") {
  const ip = req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const sub = path.slice(prefix.length);

  // login is the only unauthenticated endpoint
  if (sub === "login" && req.method === "POST") {
    if (throttled(ip)) return sendJson(res, 429, { error: "too many attempts, wait a few minutes" });
    const body = await readBody(req);
    let pw = "";
    try { pw = JSON.parse(body.toString()).password || ""; } catch {}
    const ok = pw.length === CFG.adminPassword.length &&
      (() => { try { return crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(CFG.adminPassword)); } catch { return false; } })();
    if (!ok) { console.error(`[admin] bad login ip=${ip}`); return sendJson(res, 401, { error: "wrong password" }); }
    // Path=/ — NOT /admin. The panel is served from the root and calls /api/*, so a cookie scoped
    // to /admin is never sent back and the login silently loops. `Secure` is set unconditionally:
    // prod is always behind TLS, and a cookie that survives plaintext is worse than a local dev
    // annoyance (use SESSION_INSECURE=1 to test over http on localhost).
    const secure = process.env.SESSION_INSECURE === "1" ? "" : " Secure;";
    const cookie = `${COOKIE}=${makeSession()}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}`;
    console.log(`[admin] login ok ip=${ip}`);
    return sendJson(res, 200, { ok: true }, { "set-cookie": cookie });
  }
  if (sub === "logout") {
    const secure = process.env.SESSION_INSECURE === "1" ? "" : " Secure;";
    return sendJson(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0` });
  }

  if (!isAuthed(req)) return sendJson(res, 401, { error: "unauthorized" });

  if (sub === "state" && req.method === "GET") return sendJson(res, 200, adminState());

  if (sub === "config" && req.method === "POST") {
    const body = await readBody(req);
    let patch = null;
    try { patch = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "invalid JSON body" }); }
    // Secret fields: omit/undefined = keep; "" = clear; value = set. Start from current CFG.
    const next = JSON.parse(JSON.stringify(CFG));
    if (patch.bases) {
      if (typeof patch.bases.local === "string") next.bases.local = patch.bases.local;
      if (typeof (patch.bases.crazyrouter ?? patch.bases.crazy) === "string") next.bases.crazyrouter = patch.bases.crazyrouter ?? patch.bases.crazy;
    }
    if (patch.localMap) next.localMap = patch.localMap;
    if (patch.gatedModels) next.gatedModels = patch.gatedModels;
    if (typeof (patch.claudePrefix ?? patch.wrappyPrefix) === "string") next.claudePrefix = patch.claudePrefix ?? patch.wrappyPrefix;
    if (Array.isArray(patch.claudecodeModels)) next.claudecodeModels = patch.claudecodeModels;
    if (patch.forceModel) next.forceModel = patch.forceModel;
    if (patch.modelRoutes) next.modelRoutes = patch.modelRoutes;
    if (patch.projectRoutes) next.projectRoutes = patch.projectRoutes;
    if (patch.projectAccounts) next.projectAccounts = patch.projectAccounts;   // project → account PIN
    if (patch.consumerAccounts) next.consumerAccounts = patch.consumerAccounts;  // legacy name for the same
    if (typeof patch.defaultAccount === "string") next.defaultAccount = patch.defaultAccount;
    if (patch.projectGroups) next.projectGroups = patch.projectGroups;
    if (Array.isArray(patch.claudecodeAccountPool)) next.claudecodeAccountPool = patch.claudecodeAccountPool;
    else if (Array.isArray(patch.anthropicPool)) next.claudecodeAccountPool = patch.anthropicPool;   // legacy name
    if (patch.projectLimits) next.projectLimits = patch.projectLimits;
    if (patch.projectLimitDefault) next.projectLimitDefault = patch.projectLimitDefault;
    if (patch.cloudPolicy) next.cloudPolicy = patch.cloudPolicy;
    if (patch.cloudAllowlist) next.cloudAllowlist = patch.cloudAllowlist;
    if (patch.defaultRoute) next.defaultRoute = patch.defaultRoute;
    if (typeof patch.jsonEnforce === "boolean") next.jsonEnforce = patch.jsonEnforce;
    if (patch.jsonMaxRetries !== undefined) next.jsonMaxRetries = patch.jsonMaxRetries;
    if (typeof patch.requireProject === "boolean") next.requireProject = patch.requireProject;
    if (patch.logging && typeof patch.logging === "object") Object.assign(next.logging, patch.logging);
    if (typeof (patch.crazyrouterKey ?? patch.crazyKey) === "string") next.crazyrouterKey = patch.crazyrouterKey ?? patch.crazyKey;
    for (const k of ["oblitToken", "adminPassword"])
      if (typeof patch[k] === "string") next[k] = patch[k];
    const merged = mergeConfig(envDefaults(), next);
    if (!merged.adminPassword || merged.adminPassword.length < 3)
      return sendJson(res, 400, { error: "admin password must be at least 3 chars" });
    setCFG(merged);
    const persisted = persistConfig();
    console.log(`[admin] config updated ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, state: adminState() });
  }

  if (sub === "reset" && req.method === "POST") {
    try { fs.unlinkSync(CONFIG_FILE); } catch {}
    setCFG(envDefaults());
    reindexKeys();
    console.log(`[admin] config reset to env defaults ip=${ip}`);
    return sendJson(res, 200, { ok: true, state: adminState() });
  }

  // The Claude catalog as Anthropic reports it, plus when we last asked and via which account.
  // GET is cached (whatever the last refresh found); POST forces a round trip.
  if (sub === "claudecode/models" && (req.method === "GET" || req.method === "POST")) {
    if (req.method === "POST") await refreshClaudecodeModels(`admin ip=${ip}`);
    return sendJson(res, 200, {
      advertised: CFG.claudecodeModels,
      seed: [...CLAUDECODE_MODEL_SEED],
      aliases: [...CLAUDECODE_MODEL_ALIASES],
      source: claudecodeCatalog.source,
      checkedAt: claudecodeCatalog.ts || null,
      sweptAccounts: claudecodeCatalog.accounts || [],
      failedAccounts: claudecodeCatalog.failed || [],
      error: claudecodeCatalog.error,
      // `accounts` = which orgs list this id. An id offered by only some accounts will 404 on the
      // others, so a project pinned to one of those cannot use it however it is advertised.
      models: (claudecodeCatalog.models || []).map((m) => ({ id: m.id, display_name: m.display_name, created_at: m.created_at, accounts: m.accounts || [] })),
    });
  }

  // Which advertised models does an account ACTUALLY serve? The catalog lists every model the org
  // can see; the subscription decides which ones answer. Those disagree — an exhausted Max plan
  // lists Opus and 429s it. Worse, a 429 carries no anthropic-ratelimit-* headers, so the headroom
  // harvest learns nothing from exactly the calls that matter and Accounts renders a cheerful 0%.
  // One max_tokens:1 ping per model is the only honest answer. ~9 pings, a few tokens each.
  if (sub === "claudecode/probe" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch {}
    const pool = CFG.claudecodeAccountPool || [];
    // `all` probes the whole pool. That is |accounts| × |models| pings, so it stays an explicit,
    // operator-initiated action — never a background refresh.
    if (p.all) {
      const out = [];
      for (const a of pool) out.push(await probeAccount(a));   // serial: don't hammer one org's limiter
      return sendJson(res, 200, { accounts: out, checkedAt: Date.now() });
    }
    const acct = p.account ? pool.find((a) => a.name.toLowerCase() === String(p.account).trim().toLowerCase()) : pool[0];
    if (!acct) return sendJson(res, 400, { error: "no such account", accounts: pool.map((a) => a.name) });
    return sendJson(res, 200, await probeAccount(acct));
  }

  // Everything the operator needs to answer "can this account serve anything, and who is spending
  // it". The pool is the spine — an account with no traffic and no probe still gets a row, which is
  // exactly the case the old org-keyed limits table could not represent.
  if (sub === "accounts" && req.method === "GET") {
    const pool = CFG.claudecodeAccountPool || [];
    const pins = CFG.projectAccounts || CFG.consumerAccounts || {};
    const lim = new Map();
    for (const r of await dbRows("SELECT org_id,ts,u5,u7,reset5,reset7,status,s5,s7,project,model,account FROM acct_limits")) {
      lim.set(r.org_id, r);
    }
    // Old rows label the account `anthropic:philip` / `wrappy:philip`; new ones `claudecode:philip`.
    // The name after the colon is the join key, so every era of the log counts toward the same account.
    const spendRows = await dbRows(
      `SELECT split_part(key_label, ':', 2) AS acct,
         COUNT(*)::int AS calls, COALESCE(SUM(total_tokens),0)::bigint AS tokens, MAX(ts) AS last_ts,
         COUNT(*) FILTER (WHERE status = 429)::int AS rate_limited,
         COUNT(*) FILTER (WHERE status >= 400)::int AS errors
       FROM calls WHERE key_label LIKE '%:%' GROUP BY 1`);
    const spend = new Map(spendRows.map((r) => [String(r.acct), r]));
    const dayAgo = Date.now() - 86400000;
    const spend24Rows = await dbRows(
      `SELECT split_part(key_label, ':', 2) AS acct, COUNT(*)::int AS calls,
         COALESCE(SUM(total_tokens),0)::bigint AS tokens
       FROM calls WHERE key_label LIKE '%:%' AND ts >= $1 GROUP BY 1`, [dayAgo]);
    const spend24 = new Map(spend24Rows.map((r) => [String(r.acct), r]));

    const accounts = pool.map((a) => {
      const org = ORG_OF_ACCOUNT.get(a.name) || null;
      const l = org ? lim.get(org) : null;
      const s = spend.get(a.name) || {}, s24 = spend24.get(a.name) || {};
      const pr = PROBE_CACHE.get(a.name) || null;
      return {
        name: a.name, org,
        projects: Object.keys(pins).filter((p) => pins[p] === a.name).sort(),
        limits: l ? { ts: Number(l.ts) || 0, u5: l.u5, u7: l.u7, reset5: l.reset5, reset7: l.reset7,
          status: l.status, s5: l.s5, s7: l.s7, lastProject: l.project, lastModel: l.model } : null,
        usage: { calls: s.calls || 0, tokens: Number(s.tokens) || 0, lastTs: Number(s.last_ts) || 0,
          rateLimited: s.rate_limited || 0, errors: s.errors || 0,
          calls24h: s24.calls || 0, tokens24h: Number(s24.tokens) || 0 },
        probe: pr ? { checkedAt: pr.checkedAt, usable: pr.usable, total: pr.results.length } : null,
      };
    });
    return sendJson(res, 200, {
      accounts, now: Date.now(), defaultAccount: CFG.defaultAccount || "",
      advertisedModels: (CFG.claudecodeModels || []).length,
      // A pinned project naming an account that no longer exists in the pool 403s at request time.
      orphanPins: Object.entries(pins).filter(([, acc]) => !pool.some((a) => a.name === acc)).map(([p, acc]) => ({ project: p, account: acc })),
    });
  }

  // Pin / unpin ONE project without resending the whole map. `POST config` assigns
  // projectAccounts wholesale, so a caller that sends {bluebut:"x"} silently deletes every other
  // pin. This endpoint is the safe door: it merges, and it refuses an unknown account outright
  // rather than writing a pin that resolves to nothing and 403s at request time.
  if (sub === "pins" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const project = String(p.project || "").trim().toLowerCase();
    if (!project) return sendJson(res, 400, { error: "project required" });
    const pins = { ...(CFG.projectAccounts || CFG.consumerAccounts || {}) };
    if (p.account === null || p.account === "") {
      delete pins[project];
    } else {
      const account = String(p.account || "").trim();
      const known = (CFG.claudecodeAccountPool || []).some((a) => a.name.toLowerCase() === account.toLowerCase());
      if (!known) return sendJson(res, 400, { error: `unknown account '${account}'`, accounts: (CFG.claudecodeAccountPool || []).map((a) => a.name) });
      pins[project] = account;
    }
    CFG.projectAccounts = pins;
    CFG.consumerAccounts = pins;
    const persisted = persistConfig();
    console.log(`[admin] pin ${project} -> ${pins[project] || "(removed)"} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, projectAccounts: pins });
  }

  // Set / clear ONE project's rule — pin, allowlist, or block — without resending the whole map.
  // Same hazard as `pins`: `POST config` assigns projectRoutes wholesale, so a save built from a
  // stale render deletes every other project's rule.
  //   {project, block:true}                                   → reject every call
  //   {project, provider, model?}                             → pin
  //   {project, allowProviders:[…], allowModels:[…]}          → allowlist only, normal routing
  //   {project, rule:null}  /  {project, clear:true}          → back to auto
  if (sub === "routes" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const project = String(p.project || "").trim().toLowerCase();
    if (!project) return sendJson(res, 400, { error: "project required" });
    const routes = { ...(CFG.projectRoutes || {}) };
    if (p.clear || p.rule === null) {
      delete routes[project];
    } else if (p.block) {
      routes[project] = { block: true };
    } else {
      // Refuse silently-empty saves: a rule that normalizes to nothing means the caller mistyped a
      // provider, and writing "auto" for a project they meant to restrict is the wrong way to fail.
      if (p.provider && !normProvider(p.provider))
        return sendJson(res, 400, { error: `unknown provider '${p.provider}'`, providers: PROVIDERS });
      for (const x of p.allowProviders || [])
        if (!normProvider(x)) return sendJson(res, 400, { error: `unknown provider '${x}' in allowProviders`, providers: PROVIDERS });
      const rule = sanitizeRule(p);
      if (!rule) return sendJson(res, 400, { error: "rule says nothing — give provider, allowProviders, allowModels, or block:true" });
      routes[project] = rule;
    }
    CFG.projectRoutes = routes;
    const persisted = persistConfig();
    console.log(`[admin] route ${project} -> ${JSON.stringify(routes[project] || "(auto)")} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, projectRoutes: routes });
  }

  // Replace ONE account's token. `POST config` assigns claudecodeAccountPool wholesale, so rotating
  // a single expired token through it means resending every other account's secret — and the panel
  // never has them, because adminState masks them. This merges, and never echoes the token back.
  // The pool in /data/config.json is the only copy of these credentials anywhere; there is no backup.
  if (sub === "accounts/token" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const name = String(p.account || "").trim();
    const token = String(p.token || "").trim();
    if (!name || !token) return sendJson(res, 400, { error: "account and token required" });
    if (!/^sk-ant-oat/.test(token)) return sendJson(res, 400, { error: "expected a Max setup-token (sk-ant-oat…)" });
    const pool = [...(CFG.claudecodeAccountPool || [])];
    const i = pool.findIndex((a) => String(a.name).toLowerCase() === name.toLowerCase());
    if (i < 0) return sendJson(res, 400, { error: `unknown account '${name}'`, accounts: pool.map((a) => a.name) });
    pool[i] = { ...pool[i], token };
    CFG.claudecodeAccountPool = pool;
    CFG.anthropicPool = pool;   // legacy name, kept in sync so a rollback still boots
    const persisted = persistConfig();
    // A rotated token means a new session with the org; the cached catalog for it is now suspect.
    PROBE_CACHE.delete(pool[i].name);
    console.warn(`[admin] token rotated for account=${pool[i].name} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, account: pool[i].name });
  }

  // Merge one alias. `POST config` assigns consumerAliases wholesale (same hazard as pins/routes).
  // Send {to:null} to drop one.
  if (sub === "consumers/alias" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const from = String(p.from || "").trim().toLowerCase();
    if (!from) return sendJson(res, 400, { error: "from required" });
    if (from.includes(":")) return sendJson(res, 400, { error: "alias the consumer, not a job path — drop everything after the ':'" });
    const aliases = { ...(CFG.consumerAliases || {}) };
    if (p.to === null || p.to === "") {
      delete aliases[from];
    } else {
      const to = String(p.to || "").trim().toLowerCase();
      if (!to) return sendJson(res, 400, { error: "to required" });
      if (to === from) return sendJson(res, 400, { error: "an alias to itself does nothing" });
      // The target's CONSUMER must exist, or the alias resolves to a name that 403s under the
      // registration gate — an outage disguised as a cleanup.
      const t = parseConsumer(to);
      if (!Object.prototype.hasOwnProperty.call(CFG.consumers || {}, t.consumer))
        return sendJson(res, 400, { error: `alias target consumer '${t.consumer}' is not registered`, hint: "register it first" });
      if (aliases[t.consumer]) return sendJson(res, 400, { error: `'${t.consumer}' is itself an alias — chains are not resolved` });
      aliases[from] = to;
    }
    CFG.consumerAliases = aliases;
    const persisted = persistConfig();
    console.log(`[admin] alias ${from} -> ${aliases[from] || "(removed)"} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, consumerAliases: aliases });
  }

  // ── consumer registry ──
  // The registry, plus every consumer the log has SEEN that is not in it. That second list is the
  // work queue: it is what would start 403'ing the moment requireRegisteredConsumer is turned on.
  if (sub === "consumers" && req.method === "GET") {
    const reg = CFG.consumers || {};
    const seen = await dbRows(
      `SELECT split_part(project, ':', 1) AS consumer, COUNT(*)::int AS calls,
         COALESCE(SUM(total_tokens),0)::bigint AS tokens, MAX(ts) AS last_ts,
         COUNT(DISTINCT NULLIF(split_part(project, ':', 2), ''))::int AS jobs
       FROM calls WHERE project IS NOT NULL AND project <> '' GROUP BY 1 ORDER BY 2 DESC`);
    const known = new Set(Object.keys(reg));
    const registered = Object.entries(reg).map(([name, e]) => {
      const s = seen.find((r) => r.consumer === name);
      // Never ship the hash. `id` is public by design — it is the half of the key that is not secret.
      const keys = (e.keys || []).map((k) => ({ id: k.id, created: k.created, lastUsed: k.lastUsed, revoked: !!k.revoked, note: k.note }));
      return { name, kind: e.kind, owner: e.owner, note: e.note, keys,
        activeKeys: keys.filter((k) => !k.revoked).length,
        calls: s ? s.calls : 0, tokens: s ? Number(s.tokens) : 0,
        jobs: s ? s.jobs : 0, lastTs: s ? Number(s.last_ts) : 0 };
    }).sort((a, b) => b.calls - a.calls);
    // An aliased name is not unregistered — it resolves to a registered consumer at the door. The log
    // still holds its historical rows, so without this every alias would nag here forever.
    const aliased = new Set(Object.keys(CFG.consumerAliases || {}));
    const unregistered = seen.filter((r) => r.consumer && !known.has(r.consumer) && !aliased.has(r.consumer))
      .map((r) => ({ name: r.consumer, calls: r.calls, tokens: Number(r.tokens), jobs: r.jobs, lastTs: Number(r.last_ts) }));
    return sendJson(res, 200, {
      registered, unregistered, enforcing: !!CFG.requireRegisteredConsumer,
      consumerAliases: CFG.consumerAliases || {},
      authMode: (CFG.auth && CFG.auth.mode) || "optional",
      // Flipping auth to "required" 401s every consumer holding no key. Name them, so the panel can
      // refuse to do it blind rather than discovering it from the error rate.
      keyless: registered.filter((c) => !c.activeKeys).map((c) => c.name),
      owners: [...new Set(Object.values(reg).filter((e) => e.owner).map((e) => e.owner))].sort(),
    });
  }

  // Merge one entry. Like `pins`, and for the same reason: `POST config` assigns `consumers`
  // wholesale, so sending one registration from a stale render would delete every other one.
  if (sub === "consumers" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const name = String(p.name || "").trim().toLowerCase();
    if (!name) return sendJson(res, 400, { error: "name required" });
    if (name.includes(":")) return sendJson(res, 400, { error: "register the consumer, not the job — drop everything after the ':'" });
    const reg = { ...(CFG.consumers || {}) };
    if (p.remove) {
      delete reg[name];
    } else {
      if (p.kind !== "dev" && p.kind !== "app") return sendJson(res, 400, { error: "kind must be 'dev' or 'app'" });
      const e = { kind: p.kind };
      if (p.kind === "dev") {
        const owner = String(p.owner || "").trim().toLowerCase();
        if (!owner) return sendJson(res, 400, { error: "a dev consumer is someone's machine — owner required" });
        e.owner = owner;
      }
      // Silently dropping an owner sent for an app would look like it saved. Say no instead.
      if (p.kind === "app" && String(p.owner || "").trim()) return sendJson(res, 400, { error: "an app has no owner" });
      if (typeof p.note === "string" && p.note.trim()) e.note = p.note.trim();
      reg[name] = e;
    }
    CFG.consumers = reg;
    const persisted = persistConfig();
    console.log(`[admin] consumer ${name} -> ${p.remove ? "(removed)" : reg[name].kind + (reg[name].owner ? "/" + reg[name].owner : "")} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, consumers: reg });
  }

  // Issue a key. This IS the registration step: one call creates the consumer if it does not exist
  // and hands back the only copy of the secret. Two steps (register, then separately authenticate)
  // is what let a self-asserted header masquerade as identity in the first place.
  // The plaintext is returned ONCE and never stored — only its sha256 lands in config.json.
  if (sub === "consumers/keys" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const name = String(p.name || "").trim().toLowerCase();
    if (!name) return sendJson(res, 400, { error: "name required" });
    if (name.includes(":")) return sendJson(res, 400, { error: "keys belong to a consumer, not a job — drop everything after the ':'" });
    const reg = { ...(CFG.consumers || {}) };
    let e = reg[name];
    if (!e) {
      if (p.kind !== "dev" && p.kind !== "app") return sendJson(res, 400, { error: `"${name}" is new — say kind:"dev" or kind:"app" to create it`, kinds: ["dev", "app"] });
      if (p.kind === "dev" && !String(p.owner || "").trim()) return sendJson(res, 400, { error: "a dev consumer is someone's machine — owner required" });
      if (p.kind === "app" && String(p.owner || "").trim()) return sendJson(res, 400, { error: "an app has no owner" });
      e = { kind: p.kind, keys: [] };
      if (p.kind === "dev") e.owner = String(p.owner).trim().toLowerCase();
    }
    const k = mintKey();
    e.keys = [...(e.keys || []), { id: k.id, hash: sha256(k.secret), created: Date.now(), lastUsed: 0, revoked: false, note: (p.note || "").trim() || undefined }];
    reg[name] = e;
    CFG.consumers = reg;
    const persisted = persistConfig();   // also reindexes
    console.log(`[admin] key issued ${name} id=${k.id} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, {
      ok: true, persisted, consumer: name, kind: e.kind, keyId: k.id, key: k.raw,
      warning: "this is the only time the key is shown — store it in keyvault now",
    });
  }

  // Revoke one key. The consumer, its pins and its history survive; only this credential dies.
  if (sub === "consumers/keys/revoke" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const name = String(p.name || "").trim().toLowerCase(), id = String(p.id || "").trim();
    const reg = { ...(CFG.consumers || {}) };
    const e = reg[name];
    if (!e) return sendJson(res, 404, { error: `unknown consumer '${name}'` });
    const k = (e.keys || []).find((x) => x.id === id);
    if (!k) return sendJson(res, 404, { error: `unknown key '${id}'` });
    k.revoked = true; k.revokedAt = Date.now();
    CFG.consumers = reg;
    const persisted = persistConfig();
    console.warn(`[admin] key REVOKED ${name} id=${id} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted });
  }

  // Auth mode. Separate + logged, like `consumers/enforce`: going to "required" 401s every caller
  // that has not been issued a key, so the panel refuses to do it blind.
  if (sub === "auth" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    if (!["off", "optional", "required"].includes(p.mode)) return sendJson(res, 400, { error: "mode must be off | optional | required" });
    CFG.auth = { mode: p.mode };
    const persisted = persistConfig();
    console.warn(`[admin] auth.mode=${p.mode} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, mode: p.mode });
  }

  // Turn the gate on/off. Separate from `config` so it is a deliberate, logged act — flipping it on
  // with an unseeded registry is an instant outage for every caller not yet registered.
  if (sub === "consumers/enforce" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    CFG.requireRegisteredConsumer = !!p.enabled;
    const persisted = persistConfig();
    console.warn(`[admin] requireRegisteredConsumer=${CFG.requireRegisteredConsumer} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, enforcing: CFG.requireRegisteredConsumer });
  }

  // ── consumption rollups: kind → owner → consumer → job, plus account×kind ──
  // Grouping happens in JS, not SQL: the registry lives in CFG, and a 26-row group-by is cheaper to
  // ship whole than to join against a config file.
  if (sub === "usage" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 200, { dbReady: false });
    const q = url.parse(req.url, true).query;
    const WIN = { "1h": 36e5, "24h": 864e5, "7d": 6048e5, "30d": 2592e6 };
    const win = WIN[q.win] ? q.win : "24h";
    const since = Date.now() - WIN[win];
    const rows = await dbRows(
      `SELECT project, split_part(key_label, ':', 2) AS acct, provider,
         COUNT(*)::int AS calls, COALESCE(SUM(total_tokens),0)::bigint AS tokens,
         COUNT(*) FILTER (WHERE status >= 400)::int AS errors
       FROM calls WHERE ts >= $1 AND project IS NOT NULL AND project <> '' GROUP BY 1,2,3`, [since]);
    const reg = CFG.consumers || {};
    const add = (m, k, r) => {
      const e = m.get(k) || { calls: 0, tokens: 0, errors: 0 };
      e.calls += r.calls; e.tokens += Number(r.tokens); e.errors += r.errors; m.set(k, e);
    };
    const byKind = new Map(), byOwner = new Map(), byConsumer = new Map(), byAcctKind = new Map();
    const jobsOf = new Map();
    for (const r of rows) {
      const { consumer, job } = parseConsumer(r.project);
      const e = reg[consumer];
      // An unregistered consumer is its own bucket. Folding it into "app" would be a guess, and the
      // whole point of the registry is that we stop guessing.
      const kind = e ? e.kind : "unregistered";
      add(byKind, kind, r);
      if (kind === "dev" && e.owner) add(byOwner, e.owner, r);
      add(byConsumer, consumer, r);
      if (r.acct) add(byAcctKind, `${r.acct}|${kind}`, r);
      if (job) { if (!jobsOf.has(consumer)) jobsOf.set(consumer, new Map()); add(jobsOf.get(consumer), job, r); }
    }
    const out = (m) => [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.tokens - a.tokens);
    return sendJson(res, 200, {
      dbReady: true, win, since,
      byKind: out(byKind), byOwner: out(byOwner),
      byConsumer: out(byConsumer).map((c) => ({
        ...c, kind: reg[c.key] ? reg[c.key].kind : "unregistered",
        owner: reg[c.key] && reg[c.key].owner || null,
        jobs: jobsOf.has(c.key) ? out(jobsOf.get(c.key)) : [],
      })),
      byAccountKind: out(byAcctKind).map((r) => { const [account, kind] = r.key.split("|"); return { account, kind, calls: r.calls, tokens: r.tokens, errors: r.errors }; }),
    });
  }

  if (sub === "health" && req.method === "GET") {
    const [local, crazyrouter] = await Promise.all([
      probe(CFG.bases.local), probe(CFG.bases.crazyrouter, CFG.crazyrouterKey),
    ]);
    return sendJson(res, 200, { local, crazyrouter, claudecode: { ok: (CFG.claudecodeAccountPool || []).length > 0, accounts: (CFG.claudecodeAccountPool || []).length } });
  }

  if (sub === "models" && req.method === "GET") {
    const { claudecode, crazyrouter } = await upstreamCatalogs();
    return sendJson(res, 200, { local: localModelEntries(), claudecode, crazyrouter });
  }

  // Latest per-account rate-limit snapshot harvested off real traffic (zero-token; see recordLimits).
  // One row per anthropic org-id with live 5h/7d utilization + reset + status. Dashboards read this
  // instead of probing. Rows go stale for accounts with no recent traffic (ts shows how fresh).
  if (sub === "limits" && req.method === "GET") {
    const rows = await dbRows("SELECT org_id,ts,u5,u7,reset5,reset7,status,s5,s7,project,model FROM acct_limits ORDER BY ts DESC");
    return sendJson(res, 200, { rows, now: Date.now() });
  }

  if (sub === "crazyrouter" && req.method === "GET") return sendJson(res, 200, await crazyCheck());
  if (sub === "crazyrouter/test" && req.method === "POST") {
    const body = await readBody(req); let key = "";
    try { key = JSON.parse(body.toString()).key || ""; } catch {}
    return sendJson(res, 200, await crazyCheck(key));
  }

  if (sub === "test" && req.method === "POST") {
    const body = await readBody(req); let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "invalid JSON body" }); }
    if (!p.model) return sendJson(res, 400, { error: "model required" });
    return sendJson(res, 200, await adminTest(p.model, p.prompt, p.max_tokens));
  }

  // Dry-run: show exactly where a model name routes, without calling upstream.
  if (sub === "resolve" && req.method === "POST") {
    const body = await readBody(req); let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "invalid JSON body" }); }
    const r = resolveRoute(p.model, p.project);
    const sent = r.rewriteModel || (r.provider === "local" ? r.target : p.model) || p.model || "";
    const gated = r.provider === "local" && isGated(r.target) && !!CFG.oblitToken;
    return sendJson(res, 200, {
      input: p.model || "", project: p.project || "", provider: r.provider, sentModel: sent, reason: r.reason || "",
      blocked: !!r.blocked, why: r.why, gated,
      base: r.base || (r.provider === "local" ? CFG.bases.local : r.provider === "claudecode" ? CFG.bases.claudecode : r.provider === "crazyrouter" ? CFG.bases.crazyrouter : ""),
    });
  }

  // ── call log ──
  if (sub === "calls" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 200, { rows: [], total: 0, dbReady: false });
    const q = url.parse(req.url, true).query;
    const where = [], params = [];
    const ph = (v) => { params.push(v); return `$${params.length}`; };   // positional, in push order
    if (q.provider) where.push(`provider = ${ph(String(q.provider))}`);
    if (q.model) where.push(`req_model = ${ph(String(q.model))}`);
    if (q.key) where.push(`key_label = ${ph(String(q.key))}`);
    if (q.project) where.push(q.project === "(none)" ? "(project IS NULL OR project = '')" : `project = ${ph(String(q.project).toLowerCase())}`);
    if (q.status === "error") where.push("status >= 400");
    else if (q.status === "ok") where.push("status < 400");
    else if (q.status) where.push(`status = ${ph(parseInt(q.status, 10))}`);
    if (q.since) where.push(`ts >= ${ph(parseInt(q.since, 10))}`);
    // Tri-state facets. "" = don't filter; the columns are nullable, so the negative
    // arm must spell out IS NULL or it silently drops every un-stamped row.
    if (q.effort === "(none)") where.push("(effort IS NULL OR effort = '')");
    else if (q.effort) where.push(`effort = ${ph(String(q.effort))}`);
    if (q.stream === "1") where.push("stream = true");
    else if (q.stream === "0") where.push("(stream IS NULL OR stream = false)");
    if (q.thinking === "1") where.push("thinking_tokens > 0");
    else if (q.thinking === "0") where.push("(thinking_tokens IS NULL OR thinking_tokens = 0)");
    if (q.tools === "1") where.push("tool_count > 0");
    else if (q.tools === "0") where.push("(tool_count IS NULL OR tool_count = 0)");
    if (q.cached === "1") where.push("cache_read > 0");
    else if (q.cached === "0") where.push("(cache_read IS NULL OR cache_read = 0)");
    if (q.client) where.push(`ua ILIKE ${ph("%" + String(q.client) + "%")}`);
    if (q.stop) where.push(`stop_reason = ${ph(String(q.stop))}`);
    if (q.minTok) where.push(`total_tokens >= ${ph(parseInt(q.minTok, 10))}`);
    if (q.minMs) where.push(`duration_ms >= ${ph(parseInt(q.minMs, 10))}`);
    // Live-tail cursor: only rows newer than what the client already holds. `total` then
    // means "new since afterId", not "matching overall" — the SPA adds it to its own count.
    if (q.afterId) where.push(`id > ${ph(parseInt(q.afterId, 10))}`);
    if (q.q) {
      const like = ph("%" + String(q.q) + "%");   // one placeholder, reused across the OR
      where.push(`(req_model ILIKE ${like} OR sent_model ILIKE ${like} OR ip ILIKE ${like}
        OR ua ILIKE ${like} OR req_content ILIKE ${like} OR resp_content ILIKE ${like})`);
    }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.min(parseInt(q.limit, 10) || 100, 500);
    const offset = parseInt(q.offset, 10) || 0;
    const totalRow = await dbRow(`SELECT COUNT(*)::int AS n FROM calls ${w}`, params);
    // List view: omit big content blobs; send short previews instead.
    const rows = await dbRows(`SELECT id,ts,ip,ua,method,path,req_model,provider,sent_model,key_label,status,duration_ms,stream,
      prompt_tokens,completion_tokens,total_tokens,error,project,effort,thinking_tokens,max_tokens,temperature,
      user_id,cache_read,cache_write,stop_reason,
      tool_count,mcp_tools,tool_servers,tools_kb,msg_count,system_kb,
      left(req_content,160) AS req_preview, left(resp_content,200) AS resp_preview
      FROM calls ${w} ORDER BY id DESC LIMIT ${ph(limit)} OFFSET ${ph(offset)}`, params);
    return sendJson(res, 200, { rows, total: totalRow ? totalRow.n : 0, limit, offset, dbReady: true });
  }
  // Distinct values behind the filter dropdowns. Five sequential scans over `calls`, so it is
  // cached — the panel refetches it on every mount and the live tail must not pay for it.
  if (sub === "calls/facets" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 200, { projects: [], models: [], keys: [], efforts: [], clients: [], stops: [] });
    if (FACET_CACHE.at && Date.now() - FACET_CACHE.at < 30000) return sendJson(res, 200, FACET_CACHE.val);
    const col = async (expr, extra = "") => (await dbRows(
      `SELECT ${expr} AS v, COUNT(*)::int AS n FROM calls WHERE ${expr} IS NOT NULL AND ${expr}::text <> '' ${extra}
       GROUP BY 1 ORDER BY n DESC LIMIT 60`)).map((r) => ({ v: String(r.v), n: r.n }));
    const val = {
      projects: await col("project"), models: await col("req_model"), keys: await col("key_label"),
      efforts: await col("effort"), stops: await col("stop_reason"),
      // UA strings are unbounded; the leading token is the client name and that is all we filter on.
      clients: await col("split_part(ua, '/', 1)"),
    };
    FACET_CACHE.at = Date.now(); FACET_CACHE.val = val;
    return sendJson(res, 200, val);
  }
  if (sub === "call" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 404, { error: "no db" });
    const q = url.parse(req.url, true).query;
    const id = parseInt(q.id, 10);
    if (!id) return sendJson(res, 400, { error: "id required" });
    const row = await dbRow("SELECT * FROM calls WHERE id = $1", [id]);
    return row ? sendJson(res, 200, row) : sendJson(res, 404, { error: "not found" });
  }
  // (Removed 2026-07-09: the per-conversation view. It grouped the log by Claude session_id, which
  // only ever existed for Claude Code traffic, and answered a question nobody asked. The columns it
  // read — msg_count, tool_count, tools_kb, cache_read — are still recorded and still surfaced per
  // call in the Calls tab. Consumption now rolls up by consumer, not by chat: see `usage`.)

  // Full-content export. Cursor by id, ascending: page id>after until fewer than `limit` return.
  // Returns FULL req_content/resp_content (unlike `calls`, which previews). SELECT * on purpose —
  // an explicit column list silently drops whatever was added to the table since it was written.
  if (sub === "export" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 404, { error: "no db" });
    const q = url.parse(req.url, true).query;
    const after = parseInt(q.after, 10) || 0;
    const limit = Math.min(parseInt(q.limit, 10) || 500, 2000);
    const rows = await dbRows("SELECT * FROM calls WHERE id > $1 ORDER BY id ASC LIMIT $2", [after, limit]);
    const maxId = rows.length ? rows[rows.length - 1].id : after;
    return sendJson(res, 200, { rows, count: rows.length, after, maxId, limit });
  }
  if (sub === "stats" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 200, { dbReady: false });
    try {
      const q = url.parse(req.url, true).query;
      // time window: '15m','1h','6h','24h','7d','30d' or 'all'. Default 24h.
      const WINDOWS = { "15m": 900000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
      const winKey = (q.window in WINDOWS || q.window === "all") ? q.window : "24h";
      const since = winKey === "all" ? 0 : Date.now() - WINDOWS[winKey];
      const W = "ts >= $1"; const P = [since];
      // One scan for the window scalars instead of six. Postgres counts `FILTER (WHERE …)` in the
      // same pass, and this table is now big enough that six separate seq scans is the slow path.
      const agg = await dbRow(`SELECT
          COUNT(*)::int AS calls,
          COUNT(*) FILTER (WHERE status >= 400)::int AS errors,
          COUNT(*) FILTER (WHERE error LIKE 'json_validation_failed%')::int AS json_fails,
          COALESCE(SUM(total_tokens),0) AS tokens,
          COALESCE(SUM(prompt_tokens),0) AS ptok,
          COALESCE(SUM(completion_tokens),0) AS ctok
        FROM calls WHERE ${W}`, P) || {};
      const totalRow = await dbRow("SELECT COUNT(*)::int AS n FROM calls");
      const byProvider = await dbRows(`SELECT provider, COUNT(*)::int AS n, COALESCE(SUM(total_tokens),0) AS tok,
        ROUND(AVG(duration_ms)) AS avg_ms, COUNT(*) FILTER (WHERE status>=400)::int AS errors
        FROM calls WHERE ${W} GROUP BY provider ORDER BY n DESC`, P);
      const byKey = await dbRows(`SELECT key_label, COUNT(*)::int AS n FROM calls WHERE ${W} GROUP BY key_label ORDER BY n DESC`, P);
      // By client (user-agent) — surfaces who's calling. thinkers = calls that sent extended thinking
      // or a reasoning_effort, so you can spot reasoning traffic per client at a glance.
      // string_agg replaces SQLite's GROUP_CONCAT, which does not exist here.
      const byClient = await dbRows(`SELECT COALESCE(NULLIF(ua,''),'(none)') AS ua, COUNT(*)::int AS n,
        COALESCE(SUM(total_tokens),0) AS tok, MAX(ts) AS last, COUNT(DISTINCT ip)::int AS ips,
        COUNT(*) FILTER (WHERE effort IS NOT NULL OR thinking_tokens > 0)::int AS thinkers,
        string_agg(DISTINCT provider, ',') AS providers
        FROM calls WHERE ${W} GROUP BY 1 ORDER BY n DESC LIMIT 40`, P);
      // MAX(provider): Postgres will not let a bare column ride along outside GROUP BY the way
      // SQLite does. One row per model is the shape the UI wants, so collapse provider explicitly.
      const byModel = await dbRows(`SELECT req_model, MAX(provider) AS provider, COUNT(*)::int AS n,
        COALESCE(SUM(total_tokens),0) AS tok,
        COALESCE(SUM(prompt_tokens),0) AS ptok, COALESCE(SUM(completion_tokens),0) AS ctok, ROUND(AVG(duration_ms)) AS avg_ms
        FROM calls WHERE ${W} GROUP BY req_model ORDER BY tok DESC LIMIT 40`, P);
      const byProject = await dbRows(`SELECT COALESCE(NULLIF(project,''),'(none)') AS project, COUNT(*)::int AS n,
        COALESCE(SUM(total_tokens),0) AS tok, COALESCE(SUM(prompt_tokens),0) AS ptok, COALESCE(SUM(completion_tokens),0) AS ctok,
        ROUND(AVG(duration_ms)) AS avg_ms, COUNT(*) FILTER (WHERE status>=400)::int AS errors,
        MAX(ts) AS last, COUNT(DISTINCT req_model)::int AS models, string_agg(DISTINCT provider, ',') AS providers
        FROM calls WHERE ${W} GROUP BY 1 ORDER BY tok DESC LIMIT 60`, P);
      // Cost estimate: group by (project, sent_model, provider) to price each cohort, then fold into project/model.
      const prices = priceMap();
      const costRows = await dbRows(`SELECT COALESCE(NULLIF(project,''),'(none)') AS project, req_model, sent_model, provider,
        COALESCE(SUM(prompt_tokens),0) AS ptok, COALESCE(SUM(completion_tokens),0) AS ctok
        FROM calls WHERE ${W} GROUP BY 1, sent_model, req_model, provider`, P);
      let windowCost = 0; const costByProject = {}, costByModel = {};
      for (const r of costRows) {
        const c = costUsd(prices, r.sent_model, r.provider, r.ptok, r.ctok);
        windowCost += c;
        costByProject[r.project] = (costByProject[r.project] || 0) + c;
        costByModel[r.req_model] = (costByModel[r.req_model] || 0) + c;
      }
      for (const r of byProject) {
        r.usd = +(costByProject[r.project] || 0).toFixed(4);
        // attach the effective limit + live usage% over the limit's own window (not the stats window)
        const lim = r.project && r.project !== "(none)" ? limitFor(r.project) : null;
        if (lim) {
          const u = await projectUsage(r.project, WINDOW_MS[lim.window] || WINDOW_MS["24h"]);
          const pt = lim.tokens > 0 ? u.tokens / lim.tokens : 0, pc = lim.calls > 0 ? u.calls / lim.calls : 0;
          r.limit = { window: lim.window, tokens: lim.tokens, calls: lim.calls, hard: lim.hard, warnPct: lim.warnPct, slowPct: lim.slowPct };
          r.limitUsed = { tokens: u.tokens, calls: u.calls };
          r.limitPct = +(Math.max(pt, pc) * 100).toFixed(1);
        }
      }
      byModel.forEach((r) => { r.usd = +(costByModel[r.req_model] || 0).toFixed(4); });
      const oldestRow = await dbRow("SELECT MIN(ts) AS t FROM calls");
      return sendJson(res, 200, { dbReady: true, window: winKey, total: totalRow ? totalRow.n : 0,
        windowCalls: agg.calls || 0, windowErrors: agg.errors || 0, windowTokens: agg.tokens || 0,
        windowPromptTokens: agg.ptok || 0, windowCompletionTokens: agg.ctok || 0, windowJsonFails: agg.json_fails || 0,
        windowCost: +windowCost.toFixed(4),
        pricedProviders: ["crazyrouter"], byProvider, byKey, byClient, byModel, byProject,
        oldest: oldestRow ? oldestRow.t : null, retain: CFG.logging.retain });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // ── time-series history (tokens / calls / errors over time, grouped) ──
  // ?window=…&by=provider|project|model. Buckets auto-sized to ~60 points across the
  // window. Returns top series by total tokens (rest folded into "other").
  if (sub === "series" && req.method === "GET") {
    if (!dbUp()) return sendJson(res, 200, { dbReady: false });
    try {
      const q = url.parse(req.url, true).query;
      const WINDOWS = { "15m": 900000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
      const winKey = (q.window in WINDOWS || q.window === "all") ? q.window : "24h";
      const by = ["provider", "project", "model"].includes(q.by) ? q.by : "provider";
      const groupCol = by === "provider" ? "provider" : by === "model" ? "req_model" : "COALESCE(NULLIF(project,''),'(none)')";
      const oldestRow = await dbRow("SELECT MIN(ts) AS t FROM calls");
      const oldest = (oldestRow && oldestRow.t) || Date.now();
      const span = winKey === "all" ? Math.max(60000, Date.now() - oldest) : WINDOWS[winKey];
      const since = winKey === "all" ? oldest : Date.now() - span;
      // bucket width: aim for ~60 buckets, snapped to a sane floor of 1 minute.
      // bucketMs is derived here, never caller-supplied, so interpolating it is not an injection path.
      const bucketMs = Math.max(60000, Math.round(span / 60 / 60000) * 60000);
      const rows = await dbRows(`SELECT (ts/${bucketMs}) AS b, ${groupCol} AS g,
        COUNT(*)::int AS n, COALESCE(SUM(total_tokens),0) AS tok,
        COUNT(*) FILTER (WHERE status>=400)::int AS err
        FROM calls WHERE ts >= $1 GROUP BY b, g`, [since]);
      // top-8 series by total tokens; everything else → "other".
      const totals = {}; for (const r of rows) totals[r.g] = (totals[r.g] || 0) + r.tok;
      const top = Object.entries(totals).sort((a, b2) => b2[1] - a[1]).slice(0, 8).map(([k]) => k);
      const topSet = new Set(top); const hasOther = Object.keys(totals).length > top.length;
      const series = hasOther ? [...top, "other"] : top;
      const points = new Map(); // bucketStart -> {t, tok:{}, n:{}, totalTok, totalN, totalErr}
      for (const r of rows) {
        const t = r.b * bucketMs;
        let p = points.get(t);
        if (!p) { p = { t, tok: {}, n: {}, totalTok: 0, totalN: 0, totalErr: 0 }; points.set(t, p); }
        const key = topSet.has(r.g) ? r.g : "other";
        p.tok[key] = (p.tok[key] || 0) + r.tok; p.n[key] = (p.n[key] || 0) + r.n;
        p.totalTok += r.tok; p.totalN += r.n; p.totalErr += r.err;
      }
      const out = [...points.values()].sort((a, b2) => a.t - b2.t);
      return sendJson(res, 200, { dbReady: true, window: winKey, by, bucketMs, since, series, points: out });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  if (sub === "calls/clear" && req.method === "POST") {
    if (!dbUp()) return sendJson(res, 200, { ok: true, dbReady: false });
    try {
      await DB.clearCalls();
      console.log(`[admin] call log cleared ip=${ip}`);
      return sendJson(res, 200, { ok: true });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  return sendJson(res, 404, { error: "unknown admin endpoint" });
}

module.exports = { handleAdminApi, adminState, isAuthed, makeSession, COOKIE };
