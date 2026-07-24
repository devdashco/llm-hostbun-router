// The control-plane API. Password-gated with an HMAC cookie; every mutating route logs who and what.
//
// The control plane lives at /api/*. The old /admin/api/* prefix is gone; claudectl, the statusline
// tools hardcode it (claudectl/server/claudectl_server.py). /api/* is the alias the panel itself
// uses. The cookie is the gate; the prefix is just a name.
//
// Three endpoints deliberately MERGE instead of replacing, because POST config assigns its fields
// wholesale and a save built from a stale render would delete every sibling:
//   • /pins    one project -> account
//   • /routes  one project -> rule
//   • /consumers, /consumers/keys  one registry entry
const crypto = require("node:crypto");
// url.parse() reads the query string on the GET endpoints (calls, stats, usage, …). The split left
// this require behind: those routes threw AFTER the headers were written, so they surfaced as a hang
// rather than a 500.
const url = require("node:url");
const fs = require("node:fs");
const TR = require("../translate");
const C = require("./config");
const { CFG, setCFG, persistConfig, mergeConfig, envDefaults, loadConfig, reindexKeys, CANON, OBLIT, E4B,
        PROVIDERS, normProvider, sanitizeRule, sanitizeLimit, IMAGE_MODEL_IDS, CONFIG_FILE } = C;
const DB = require("./db");
const { dbUp, dbRow, dbRows, ACCT_CACHE, ACCT_DEAD, ORG_OF_ACCOUNT, FACET_CACHE } = DB;
const { priceMap, costUsd } = require("./pricing");
const { mintKey, sha256, parseConsumer } = require("./identity");
const { resolveRoute, accountFor, autoAccount, acctHealth, isGated, localTarget, limitFor, projectUsage, throttleSnapshot } = require("./routing");
const { readBody, sendJson, mask, buildHeaders } = require("./http");
const CC = require("./claudecode");
const { refreshClaudecodeModels, refreshAccountLimits, upstreamCatalogs, localModelEntries } = CC;

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
    // "pinned" (default) or "soonest-weekly-reset". autoAccount = what the picker would choose right
    // now (null when off or no usable weekly reading — then pins decide, exactly as before).
    accountStrategy: CFG.accountStrategy || "pinned",
    autoAccount: CFG.accountStrategy === "soonest-weekly-reset" ? ((autoAccount() || {}).name || null) : null,
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
    // Apps currently back-pressured for drawing real upstream 429s (invariant: devs never appear here).
    // In-memory, per-process; empty when nothing is throttled. Read by the throttle watcher.
    throttles: throttleSnapshot(),
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
      return { name: a.name, org: a.org, email: a.email || "", tokenMasked: mask(a.token),
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

async function handleAdminApi(req, res, path, prefix = "/api/") {
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
    // Path=/ — the panel is served from the root and calls /api/*, so a narrower cookie path is
    // never sent back and the login silently loops. `Secure` is set unconditionally:
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
      seed: [...C.CLAUDECODE_MODEL_SEED],
      aliases: [...C.CLAUDECODE_MODEL_ALIASES],
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

  // Actively refresh the live usage window for one account (or the whole pool). One cheap haiku
  // ping each, reading the `anthropic-ratelimit-unified-*` headers and writing them through the same
  // recordLimits() the passive harvest uses — so the Accounts bars show the TRUE window on demand,
  // not the last reading a real request happened to harvest (which freezes when an account is idle,
  // e.g. after Anthropic refunds a window). Serial, so we hit one org's limiter at a time.
  if (sub === "claudecode/limits" && req.method === "POST") {
    const body = await readBody(req);
    let p = {}; try { p = JSON.parse(body.toString()); } catch {}
    const pool = CFG.claudecodeAccountPool || [];
    if (p.all || !p.account) {
      const out = [];
      for (const a of pool) out.push(await refreshAccountLimits(a));
      return sendJson(res, 200, { accounts: out, checkedAt: Date.now() });
    }
    const acct = pool.find((a) => a.name.toLowerCase() === String(p.account).trim().toLowerCase());
    if (!acct) return sendJson(res, 400, { error: "no such account", accounts: pool.map((a) => a.name) });
    return sendJson(res, 200, await refreshAccountLimits(acct));
  }

  // Reveal the FULL setup-token for one account — admin-gated (isAuthed above). Every
  // other Accounts response masks the token (tokenMasked); this is the ONE endpoint
  // that returns the raw sk-ant-oat, so a direct-mode box can resync its stale local
  // ~/.claude-accounts/<name>.token to the live pool token after a rotation (else the
  // old local copy 401s on direct while the gateway still works on the fresh one).
  if (sub === "reveal" && req.method === "POST") {
    const body = await readBody(req);
    let p = {}; try { p = JSON.parse(body.toString()); } catch {}
    const pool = CFG.claudecodeAccountPool || [];
    const acct = pool.find((a) => a.name.toLowerCase() === String(p.account || "").trim().toLowerCase());
    if (!acct) return sendJson(res, 400, { error: "no such account", accounts: pool.map((a) => a.name) });
    return sendJson(res, 200, { name: acct.name, org: acct.org || "", token: acct.token || "" });
  }

  // Everything the operator needs to answer "who is spending each subscription, and how much window
  // is left". The pool is the spine — an account with no traffic still gets a row, which is exactly
  // the case the old org-keyed limits table could not represent.
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
      return {
        name: a.name, org,
        email: a.email || null,
        // disabled = config flag (set here / never routed). dead = runtime: the live limit refresh
        // saw a 403 permission_error (OAuth disabled) this process. Both mean "don't route to it".
        disabled: !!a.disabled,
        dead: ACCT_DEAD.has(a.name),
        projects: Object.keys(pins).filter((p) => pins[p] === a.name).sort(),
        limits: l ? { ts: Number(l.ts) || 0, u5: l.u5, u7: l.u7, reset5: l.reset5, reset7: l.reset7,
          status: l.status, s5: l.s5, s7: l.s7, lastProject: l.project, lastModel: l.model } : null,
        usage: { calls: s.calls || 0, tokens: Number(s.tokens) || 0, lastTs: Number(s.last_ts) || 0,
          rateLimited: s.rate_limited || 0, errors: s.errors || 0,
          calls24h: s24.calls || 0, tokens24h: Number(s24.tokens) || 0 },
      };
    });
    accounts.sort((x, y) => x.name.localeCompare(y.name));
    return sendJson(res, 200, {
      accounts, now: Date.now(), defaultAccount: CFG.defaultAccount || "",
      advertisedModels: (CFG.claudecodeModels || []).length,
      // A pinned project naming an account that no longer exists in the pool 403s at request time.
      orphanPins: Object.entries(pins).filter(([, acc]) => !pool.some((a) => a.name === acc)).map(([p, acc]) => ({ project: p, account: acc })),
      summary: { accounts: accounts.length },
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
    const name = String(p.account || p.name || "").trim();
    const token = String(p.token || "").replace(/\s+/g, ""); // paste often line-wraps the token; it has no spaces
    // email/disabled: "" or false clears, a value sets, undefined leaves it as-is.
    const email = p.email !== undefined ? String(p.email || "").trim() : undefined;
    const disabled = p.disabled !== undefined ? !!p.disabled : undefined;
    if (!name || !token) return sendJson(res, 400, { error: "account and token required" });
    if (!/^sk-ant-oat/.test(token)) return sendJson(res, 400, { error: "expected a Max setup-token (sk-ant-oat…)" });
    const pool = [...(CFG.claudecodeAccountPool || [])];
    const i = pool.findIndex((a) => String(a.name).toLowerCase() === name.toLowerCase());
    // Create-if-absent: this is the ONLY add path (there is no separate accounts/add), which is why
    // the MCP tool and the panel both call it "Import or rotate". A new entry is minimal {name,org,token};
    // org is learned later from the anthropic-organization-id header on the first catalog sweep.
    const created = i < 0;
    if (created) {
      if (!/^[a-z0-9._-]+$/i.test(name)) return sendJson(res, 400, { error: "account name must be [a-z0-9._-]" });
      const entry = { name, org: "", token };
      if (email) entry.email = email;
      if (disabled) entry.disabled = true;
      pool.push(entry);
    } else {
      const cur = { ...pool[i], token };
      if (email !== undefined) { if (email) cur.email = email; else delete cur.email; }
      if (disabled !== undefined) { if (disabled) cur.disabled = true; else delete cur.disabled; }
      pool[i] = cur;
    }
    CFG.claudecodeAccountPool = pool;
    CFG.anthropicPool = pool;   // legacy name, kept in sync so a rollback still boots
    const persisted = persistConfig();
    console.warn(`[admin] account ${created ? "ADDED" : "token rotated"} name=${name} email=${email ?? "(kept)"} disabled=${disabled === undefined ? "(kept)" : disabled} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, account: name, created });
  }

  // Disable / re-enable ONE account without touching its token (POST /api/accounts/disable
  // {account, disabled?}). A disabled account is skipped by routing: accountFor() returns null for a
  // project whose pin points at it, so that project gets the honest `403 no_account_for_project`
  // (re-pin it) instead of the router hammering a dead subscription. Default disabled=true.
  if (sub === "accounts/disable" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const name = String(p.account || p.name || "").trim();
    if (!name) return sendJson(res, 400, { error: "account required" });
    const disabled = p.disabled === undefined ? true : !!p.disabled;
    const pool = [...(CFG.claudecodeAccountPool || [])];
    const i = pool.findIndex((a) => String(a.name).toLowerCase() === name.toLowerCase());
    if (i < 0) return sendJson(res, 400, { error: `unknown account '${name}'`, accounts: pool.map((a) => a.name) });
    const cur = { ...pool[i] };
    if (disabled) cur.disabled = true; else delete cur.disabled;
    pool[i] = cur;
    CFG.claudecodeAccountPool = pool;
    CFG.anthropicPool = pool;
    const persisted = persistConfig();
    const pins = CFG.projectAccounts || CFG.consumerAccounts || {};
    const stranded = Object.keys(pins).filter((pj) => String(pins[pj]).toLowerCase() === cur.name.toLowerCase()).sort();
    console.warn(`[admin] account ${disabled ? "DISABLED" : "re-enabled"} name=${cur.name} stranded=${stranded.join(",") || "-"} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, account: cur.name, disabled: !!cur.disabled, stranded });
  }

  // Remove ONE account from the pool, credential and all. Filters by name server-side so every other
  // account's token stays intact (the panel never holds them, so it could not rebuild the pool via
  // `POST config`). Refuses if any project still pins it — removing a pinned account silently strands
  // that project on `403 no_account_for_project` — unless `force:true`, which drops those pins too.
  // The pool in /data/config.json is the only copy of these tokens: removing one is irreversible here.
  if (sub === "accounts/remove" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const name = String(p.name || p.account || "").trim();
    if (!name) return sendJson(res, 400, { error: "name required" });
    const pool = CFG.claudecodeAccountPool || [];
    const acct = pool.find((a) => String(a.name).toLowerCase() === name.toLowerCase());
    if (!acct) return sendJson(res, 400, { error: `unknown account '${name}'`, accounts: pool.map((a) => a.name) });
    const pins = CFG.projectAccounts || {};
    const pinned = Object.keys(pins).filter((pj) => String(pins[pj]).toLowerCase() === acct.name.toLowerCase());
    if (pinned.length && !p.force) {
      return sendJson(res, 409, { error: `account '${acct.name}' is still pinned by ${pinned.join(", ")} — re-pin them first, or pass force:true to drop those pins`, pinned });
    }
    if (pinned.length) { for (const pj of pinned) delete pins[pj]; CFG.projectAccounts = pins; }
    const next = pool.filter((a) => String(a.name).toLowerCase() !== acct.name.toLowerCase());
    CFG.claudecodeAccountPool = next;
    CFG.anthropicPool = next;   // legacy mirror kept in sync so a rollback still boots
    const persisted = persistConfig();
    console.warn(`[admin] account REMOVED name=${acct.name} ip=${ip} persisted=${persisted} droppedPins=${pinned.join(",") || "none"}`);
    return sendJson(res, 200, { ok: true, removed: acct.name, droppedPins: pinned, remaining: next.map((a) => a.name), persisted });
  }

  // Merge one alias. `POST config` assigns consumerAliases wholesale (same hazard as pins/routes).
  // Send {to:null} to drop one.
  // Alias a legacy caller name onto a canonical <consumer>[:<job>] path. Writes the DB, like every
  // other registry mutation — CFG is only its projection.
  if (sub === "consumers/alias" && req.method === "POST") {
    const REG = require("./registry");
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    try {
      await REG.setAlias({ from: p.from, to: p.to });
      console.log(`[admin] alias ${p.from} -> ${p.to || "(removed)"} ip=${ip}`);
      return sendJson(res, 200, { ok: true, consumerAliases: CFG.consumerAliases });
    } catch (e) {
      if (e instanceof REG.RegistryError) return sendJson(res, e.status, { error: e.message, ...e.extra });
      return sendJson(res, 500, { error: e.message });
    }
  }
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
  // ── consumers: the panel's door onto the registry ────────────────────────────
  // These three used to write CFG.consumers directly. The registry now lives in Postgres and
  // registry.refresh() REBUILDS CFG.consumers from it, so a key issued into CFG authenticated
  // until the next registry write and then silently vanished. There is exactly one writer now.
  //
  // The panel still speaks the old vocabulary (kind: dev|app). The DB speaks machine|project.
  // Translate at this edge rather than teaching either side the other's words.
  const KIND = { dev: "machine", app: "project" };

  if (sub === "consumers" && req.method === "POST") {
    const REG = require("./registry");
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    try {
      if (p.remove) {
        await REG.removeConsumer(p.name);
        console.log(`[admin] consumer removed ${p.name} ip=${ip}`);
      } else {
        const kind = KIND[p.kind];
        if (!kind) return sendJson(res, 400, { error: "kind must be 'dev' or 'app'" });
        await REG.addConsumer({ name: p.name, kind, developer: p.owner, note: p.note });
        console.log(`[admin] consumer ${p.name} -> ${kind}${p.owner ? "/" + p.owner : ""} ip=${ip}`);
      }
      return sendJson(res, 200, { ok: true, consumers: CFG.consumers });
    } catch (e) {
      if (e instanceof REG.RegistryError) return sendJson(res, e.status, { error: e.message, ...e.extra });
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Issue a key. This IS the registration step: one call creates the consumer if it does not exist
  // and hands back the only copy of the secret. Two steps — register a name, then separately
  // authenticate — is what let a self-asserted header masquerade as identity in the first place.
  // The plaintext is returned ONCE; only its sha256 is stored.
  if (sub === "consumers/keys" && req.method === "POST") {
    const REG = require("./registry");
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    try {
      const out = await REG.issueKey({ name: p.name, kind: p.kind ? KIND[p.kind] : undefined, developer: p.owner, note: p.note });
      console.log(`[admin] key issued ${out.consumer} id=${out.keyId} ip=${ip}`);
      return sendJson(res, 200, { ok: true, ...out, warning: "this is the only time the key is shown — store it in keyvault now" });
    } catch (e) {
      if (e instanceof REG.RegistryError) return sendJson(res, e.status, { error: e.message, ...e.extra });
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Revoke one key. The consumer, its pins and its history survive; only this credential dies.
  if (sub === "consumers/keys/revoke" && req.method === "POST") {
    const REG = require("./registry");
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    try {
      await REG.revokeKey({ name: p.name, id: p.id });
      console.warn(`[admin] key REVOKED ${p.name} id=${p.id} ip=${ip}`);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      if (e instanceof REG.RegistryError) return sendJson(res, e.status, { error: e.message, ...e.extra });
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Auth mode. Separate + logged, like `consumers/enforce`: going to "required" 401s every caller
  // that has not been issued a key, so the panel refuses to do it blind.
  // Account-selection strategy. Its own logged endpoint (like auth/enforce), never POST config:
  // flipping it is a deliberate act — it changes WHICH subscription every app bills to.
  if (sub === "claudecode/strategy" && req.method === "POST") {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body.toString()); } catch { return sendJson(res, 400, { error: "bad json" }); }
    if (!["pinned", "soonest-weekly-reset"].includes(p.mode))
      return sendJson(res, 400, { error: "mode must be pinned | soonest-weekly-reset" });
    CFG.accountStrategy = p.mode;
    const persisted = persistConfig();
    const auto = p.mode === "soonest-weekly-reset" ? ((autoAccount() || {}).name || null) : null;
    console.warn(`[admin] accountStrategy=${p.mode} auto=${auto || "-"} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, mode: p.mode, autoAccount: auto });
  }

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

  // One shape for all three providers: {up, status, ms, count}. claudecode used to answer `{ok}`
  // instead, so the panel — which reads `.up` — showed it permanently DOWN with "status —", on a
  // provider that was serving every Claude call we made. Never let one member of a set speak a
  // different dialect than its siblings.
  //
  // claudecode is not probed over HTTP: api.anthropic.com/v1/models needs a Max token, so an
  // unauthenticated GET answers 401 and would read as DOWN. Its health IS "do we hold accounts".
  if (sub === "health" && req.method === "GET") {
    const [local, crazyrouter] = await Promise.all([
      probe(CFG.bases.local), probe(CFG.bases.crazyrouter, CFG.crazyrouterKey),
    ]);
    const accounts = (CFG.claudecodeAccountPool || []).length;
    const claudecode = {
      up: accounts > 0, status: accounts > 0 ? 200 : 0, ms: 0,
      count: (CFG.claudecodeModels || []).length, accounts,
      note: accounts > 0 ? undefined : "no accounts in the pool",
    };
    return sendJson(res, 200, { local, crazyrouter, claudecode });
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
    if (q.project) {
      // A bare consumer name covers its jobs too (`promopilot` matches `promopilot:generatetext`),
      // mirroring how routing resolves. A value with a colon is an exact job path; a TRAILING colon
      // (`promopilot:`) is the consumer's job-less calls only — the stats drilldown needs all three.
      const pj = String(q.project).toLowerCase();
      if (pj === "(none)") where.push("(project IS NULL OR project = '')");
      else if (pj.endsWith(":")) where.push(`project = ${ph(pj.slice(0, -1))}`);
      else if (pj.includes(":")) where.push(`project = ${ph(pj)}`);
      else where.push(`(project = ${ph(pj)} OR project LIKE ${ph(pj + ":%")})`);
    }
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
          COALESCE(SUM(completion_tokens),0) AS ctok,
          COALESCE(SUM(cache_read),0) AS cache_read,
          COALESCE(SUM(cache_write),0) AS cache_write
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
      // One row per (requested model, ACTUAL provider) — and expose what was actually served.
      // Grouping by req_model alone and collapsing with MAX(provider) MISATTRIBUTED every rewrite:
      // redbut asks for `gemini-2.5-flash-lite` but a projectRoute rewrites it to `claude-haiku-4-5`
      // on the (free) subscription — yet MAX(provider) labeled all ~90k of those calls `crazyrouter`
      // (the paid provider, lexicographically largest), reading like a large cloud bill that never
      // happened. Splitting on provider keeps requested-vs-served honest; `sent_models` shows what
      // actually ran so a rewrite is visible instead of hidden behind the requested id.
      const byModel = await dbRows(`SELECT req_model, provider,
        string_agg(DISTINCT sent_model, ',') AS sent_models, COUNT(*)::int AS n,
        COALESCE(SUM(total_tokens),0) AS tok,
        COALESCE(SUM(prompt_tokens),0) AS ptok, COALESCE(SUM(completion_tokens),0) AS ctok,
        COALESCE(SUM(cache_read),0) AS cr, COALESCE(SUM(cache_write),0) AS cw, ROUND(AVG(duration_ms)) AS avg_ms
        FROM calls WHERE ${W} GROUP BY req_model, provider ORDER BY tok DESC LIMIT 60`, P);
      const byProject = await dbRows(`SELECT COALESCE(NULLIF(project,''),'(none)') AS project, COUNT(*)::int AS n,
        COALESCE(SUM(total_tokens),0) AS tok, COALESCE(SUM(prompt_tokens),0) AS ptok, COALESCE(SUM(completion_tokens),0) AS ctok,
        COALESCE(SUM(cache_read),0) AS cr, COALESCE(SUM(cache_write),0) AS cw,
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
        // Key cost by (req_model, provider) — byModel is now split on provider, so folding on
        // req_model alone would smear a rewrite's (zero) subscription cost across the paid row.
        const mk = r.req_model + " " + r.provider;
        costByModel[mk] = (costByModel[mk] || 0) + c;
      }
      for (const r of byProject) {
        r.usd = +(costByProject[r.project] || 0).toFixed(4);
        // attach the effective limit + live usage% over the limit's own window (not the stats window)
        const lim = r.project && r.project !== "(none)" ? limitFor(r.project) : null;
        if (lim) {
          const u = await projectUsage(r.project, C.WINDOW_MS[lim.window] || C.WINDOW_MS["24h"]);
          const pt = lim.tokens > 0 ? u.tokens / lim.tokens : 0, pc = lim.calls > 0 ? u.calls / lim.calls : 0;
          r.limit = { window: lim.window, tokens: lim.tokens, calls: lim.calls, hard: lim.hard, warnPct: lim.warnPct, slowPct: lim.slowPct };
          r.limitUsed = { tokens: u.tokens, calls: u.calls };
          r.limitPct = +(Math.max(pt, pc) * 100).toFixed(1);
        }
      }
      byModel.forEach((r) => { r.usd = +(costByModel[r.req_model + " " + r.provider] || 0).toFixed(4); });
      const oldestRow = await dbRow("SELECT MIN(ts) AS t FROM calls");
      return sendJson(res, 200, { dbReady: true, window: winKey, total: totalRow ? totalRow.n : 0,
        windowCalls: agg.calls || 0, windowErrors: agg.errors || 0, windowTokens: agg.tokens || 0,
        windowPromptTokens: agg.ptok || 0, windowCompletionTokens: agg.ctok || 0, windowJsonFails: agg.json_fails || 0,
        windowCacheRead: agg.cache_read || 0, windowCacheWrite: agg.cache_write || 0,
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
      const by = ["provider", "project", "consumer", "model"].includes(q.by) ? q.by : "provider";
      // consumer folds jobs: `promopilot:generatetext` and `promopilot:l1_metadata` chart as one
      // series, so one busy consumer's jobs don't eat three of the top-8 series slots.
      const groupCol = by === "provider" ? "provider" : by === "model" ? "req_model"
        : by === "consumer" ? "split_part(COALESCE(NULLIF(project,''),'(none)'), ':', 1)"
        : "COALESCE(NULLIF(project,''),'(none)')";
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

  // ── identity registry (Postgres): developers → machines, and projects ──
  // Every write goes to the DB and re-projects into CFG; none of them can be reached through
  // `POST config`, which assigns wholesale and would wipe key hashes it never had.
  // HANDLED is a sentinel, NOT the return value of sendJson() — sendJson returns undefined, so
  // returning it would read as "not my route" and the dispatcher would then write a 404 on top of
  // the response already sent (ERR_HTTP_HEADERS_SENT).
  if (await registryRoutes(req, res, sub, ip) === HANDLED) return;

  return sendJson(res, 404, { error: "unknown admin endpoint" });
}

// Split out so the dispatcher above stays a flat list of `sub ===` checks. Returns a truthy value
// when it handled the request, undefined when the path was not ours.
const HANDLED = Symbol("handled");

async function registryRoutes(req, res, sub, ip) {
  const REG = require("./registry");
  const body = async () => {
    const b = await readBody(req);
    try { return JSON.parse(b.toString() || "{}"); } catch { throw new REG.RegistryError("bad json"); }
  };
  const guard = async (fn) => {
    try { await fn(); }
    catch (e) {
      if (e instanceof REG.RegistryError) sendJson(res, e.status, { error: e.message, ...e.extra });
      else { console.error(`[registry] ${e.message}`); sendJson(res, 500, { error: e.message }); }
    }
    return HANDLED;   // the response is written either way
  };

  if (sub === "developers" && req.method === "GET")
    return guard(async () => sendJson(res, 200, { developers: await REG.listDevelopers() }));

  if (sub === "developers" && req.method === "POST")
    return guard(async () => {
      const p = await body();
      if (p.remove) { await REG.removeDeveloper(p.name); console.log(`[admin] developer removed ${p.name} ip=${ip}`); }
      else { await REG.addDeveloper(p); console.log(`[admin] developer ${p.name} ip=${ip}`); }
      return sendJson(res, 200, { ok: true, developers: await REG.listDevelopers() });
    });

  // machines and projects are the same table; the route just fixes `kind` so a caller cannot create
  // a project that owns a developer, or a machine that owns nobody.
  // machines and projects are the same table; the route fixes `kind` so a caller cannot create a
  // project that owns a developer, or a machine that owns nobody.
  for (const [path, kind] of [["machines", "machine"], ["projects", "project"]]) {
    if (sub === path && req.method === "GET")
      return guard(async () => {
        const list = await REG.listConsumers(kind);
        const stale = list.some((x) => x.stale);
        return sendJson(res, 200, { [path]: list, ...(stale ? { stale: true, warning: "registry DB unreachable — this is the /data/config.json mirror, possibly out of date" } : {}) });
      });
    if (sub === path && req.method === "POST")
      return guard(async () => {
        const p = await body();
        if (p.remove) { await REG.removeConsumer(p.name); console.log(`[admin] ${kind} removed ${p.name} ip=${ip}`); }
        else { await REG.addConsumer({ ...p, kind }); console.log(`[admin] ${kind} ${p.name} ip=${ip}`); }
        return sendJson(res, 200, { ok: true });
      });
  }

  if (sub === "registry/keys" && req.method === "POST")
    return guard(async () => {
      const out = await REG.issueKey(await body());
      console.log(`[admin] key issued ${out.consumer} id=${out.keyId} ip=${ip}`);
      return sendJson(res, 200, { ok: true, ...out, warning: "this is the only time the key is shown — store it in keyvault now" });
    });

  if (sub === "registry/keys/revoke" && req.method === "POST")
    return guard(async () => {
      const p = await body();
      await REG.revokeKey(p);
      console.warn(`[admin] key REVOKED ${p.name} id=${p.id} ip=${ip}`);
      return sendJson(res, 200, { ok: true });
    });

  // Delete the call-log history of a name that was never registered — the junk left over from probes
  // and typos (`test`, `smoketest`, `totally-made-up-xyz`). Refuses any name that IS registered, or
  // that is an alias of one: those calls are somebody's history, not orphans. One name at a time, no
  // patterns — a bulk purge over a LIKE is how you lose promopilot to a typo.
  if (sub === "consumers/purge" && req.method === "POST")
    return guard(async () => {
      const p = await body();
      const rows = await REG.purgeUnregistered(p.name);
      console.warn(`[admin] PURGED ${rows} call(s) of unregistered '${p.name}' ip=${ip}`);
      return sendJson(res, 200, { ok: true, name: p.name, deleted: rows });
    });

  if (sub === "registry/alias" && req.method === "POST")
    return guard(async () => {
      const p = await body();
      await REG.setAlias(p);
      console.log(`[admin] alias ${p.from} -> ${p.to || "(removed)"} ip=${ip}`);
      return sendJson(res, 200, { ok: true });
    });

  return undefined;   // not our path — let the dispatcher keep looking
}

module.exports = { handleAdminApi, adminState, isAuthed, makeSession, COOKIE };
