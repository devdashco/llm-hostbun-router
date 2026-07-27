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
const { dbUp, dbWriteHealth, dbRow, dbRows, ACCT_CACHE, ACCT_DEAD, ORG_OF_ACCOUNT, FACET_CACHE } = DB;
const { unpricedModels } = require("./pricing");
const { sha256 } = require("./identity");
const { resolveRoute, accountFor, autoAccount, acctHealth, isGated, throttleSnapshot } = require("./routing");
const { readBody, readJson, sendJson, mask, buildHeaders } = require("./http");
const CC = require("./claudecode");
const { refreshClaudecodeModels, refreshAccountLimits, upstreamCatalogs, localModelEntries } = CC;
// The three read-only consumption rollups. Split out on 2026-07-26 — see src/analytics.js.
const AN = require("./analytics");
// The call-log reads plus the destructive clear. Split out on 2026-07-26 — see src/calllog.js.
const CL = require("./calllog");
// The Claude Max pool and its pins. Split out on 2026-07-26 — see src/accounts.js.
const AC = require("./accounts");
// The registry's HTTP face. Split out on 2026-07-26 — see src/consumers.js. The auth GATES stay here.
const CO = require("./consumers");
// Provider health, catalogs, resolve tracer, one-shot test call. Split out 2026-07-26.
const DX = require("./diagnostics");
// The image-template store — see src/imagetemplates.js. The admin GATE stays in this dispatcher.
const IT = require("./imagetemplates");

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
    // Advertised claudecode ids with no token cost defined in the pricing catalog — a coverage warning
    // so a newly-shipped Anthropic id shows up here instead of silently reading as $0 / no tier.
    unpricedModels: unpricedModels(CFG.claudecodeModels),
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
    // ...and what that flag does NOT tell you. loggingDbReady is `!!pool` — true the moment
    // DATABASE_URL is set, whether or not the database answers. Failed writes are the only signal
    // that the log is lying, and they were going to stdout alone.
    loggingWrites: dbWriteHealth(),

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
    const patch = await readJson(req, res);
    if (!patch) return;
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
    // claudecode.js exports this as a GETTER — `claudecodeCatalog: () => claudecodeCatalog` — because
    // the catalog is reassigned on every refresh, so a value captured at require time would freeze at
    // the boot seed. This read used the name as a bare variable and never imported it either way, so
    // the route threw ReferenceError on EVERY call; the process-wide fatal-guard swallowed it and the
    // container stayed healthy while the panel's Models tab got nothing.
    const cat = CC.claudecodeCatalog();
    return sendJson(res, 200, {
      advertised: CFG.claudecodeModels,
      seed: [...C.CLAUDECODE_MODEL_SEED],
      aliases: [...C.CLAUDECODE_MODEL_ALIASES],
      source: cat.source,
      checkedAt: cat.ts || null,
      sweptAccounts: cat.accounts || [],
      failedAccounts: cat.failed || [],
      error: cat.error,
      // `accounts` = which orgs list this id. An id offered by only some accounts will 404 on the
      // others, so a project pinned to one of those cannot use it however it is advertised.
      models: (cat.models || []).map((m) => ({ id: m.id, display_name: m.display_name, created_at: m.created_at, accounts: m.accounts || [] })),
    });
  }

  // Actively refresh the live usage window for one account (or the whole pool). One cheap haiku
  // ping each, reading the `anthropic-ratelimit-unified-*` headers and writing them through the same
  // recordLimits() the passive harvest uses — so the Accounts bars show the TRUE window on demand,
  // not the last reading a real request happened to harvest (which freezes when an account is idle,
  // e.g. after Anthropic refunds a window). Serial, so we hit one org's limiter at a time.
  if (sub === "claudecode/limits" && req.method === "POST") {
    const p = await readJson(req, res);
    if (!p) return;
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


  // Everything the operator needs to answer "who is spending each subscription, and how much window
  // is left". The pool is the spine — an account with no traffic still gets a row, which is exactly
  // the case the old org-keyed limits table could not represent.
  // ── the account pool and its project pins ── (src/accounts.js)
  if (sub === "reveal" && req.method === "POST") return AC.revealToken(req, res);
  if (sub === "accounts" && req.method === "GET") return AC.listAccounts(req, res);
  if (sub === "pins" && req.method === "POST") return AC.setPin(req, res, ip);
  if (sub === "routes" && req.method === "POST") {
    const p = await readJson(req, res);
    if (!p) return;
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
  if (sub === "accounts/token" && req.method === "POST") return AC.setAccountToken(req, res, ip);
  if (sub === "accounts/disable" && req.method === "POST") return AC.setAccountDisabled(req, res, ip);
  if (sub === "accounts/remove" && req.method === "POST") return AC.removeAccount(req, res, ip);
  // ── image templates ── (src/imagetemplates.js). The store behind `template` on
  // POST /v1/images/generations: a reference picture plus a style instruction. Editing one is a
  // config write like any other; the pictures live beside config.json on the same volume.
  if (sub === "image-templates" && req.method === "GET") return IT.listAdmin(res);
  if (sub === "image-templates" && req.method === "POST") return IT.saveTemplate(req, res, ip);
  if (sub === "image-templates/remove" && req.method === "POST") return IT.removeTemplate(req, res, ip);
  // ── the consumer registry ── (src/consumers.js)
  if (sub === "consumers/alias" && req.method === "POST") return CO.setAlias(req, res, ip);
  if (sub === "consumers" && req.method === "GET") return CO.listConsumers(req, res);
  if (sub === "consumers" && req.method === "POST") return CO.addConsumer(req, res, ip);
  if (sub === "consumers/keys" && req.method === "POST") return CO.issueKey(req, res, ip);
  if (sub === "consumers/keys/revoke" && req.method === "POST") return CO.revokeKey(req, res, ip);
  if (sub === "claudecode/strategy" && req.method === "POST") {
    const p = await readJson(req, res);
    if (!p) return;
    if (!["pinned", "soonest-weekly-reset"].includes(p.mode))
      return sendJson(res, 400, { error: "mode must be pinned | soonest-weekly-reset" });
    CFG.accountStrategy = p.mode;
    const persisted = persistConfig();
    const auto = p.mode === "soonest-weekly-reset" ? ((autoAccount() || {}).name || null) : null;
    console.warn(`[admin] accountStrategy=${p.mode} auto=${auto || "-"} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, mode: p.mode, autoAccount: auto });
  }

  if (sub === "auth" && req.method === "POST") {
    const p = await readJson(req, res);
    if (!p) return;
    if (!C.AUTH_MODES.includes(p.mode)) return sendJson(res, 400, { error: `mode must be ${C.AUTH_MODES.join(" | ")}` });
    CFG.auth = { mode: p.mode };
    const persisted = persistConfig();
    console.warn(`[admin] auth.mode=${p.mode} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, mode: p.mode });
  }

  // Turn the gate on/off. Separate from `config` so it is a deliberate, logged act — flipping it on
  // with an unseeded registry is an instant outage for every caller not yet registered.
  if (sub === "consumers/enforce" && req.method === "POST") {
    const p = await readJson(req, res);
    if (!p) return;
    CFG.requireRegisteredConsumer = !!p.enabled;
    const persisted = persistConfig();
    console.warn(`[admin] requireRegisteredConsumer=${CFG.requireRegisteredConsumer} ip=${ip} persisted=${persisted}`);
    return sendJson(res, 200, { ok: true, persisted, enforcing: CFG.requireRegisteredConsumer });
  }

  if (sub === "usage" && req.method === "GET") return AN.usageRollup(req, res);

  // One shape for all three providers: {up, status, ms, count}. claudecode used to answer `{ok}`
  // instead, so the panel — which reads `.up` — showed it permanently DOWN with "status —", on a
  // provider that was serving every Claude call we made. Never let one member of a set speak a
  // different dialect than its siblings.
  //
  // claudecode is not probed over HTTP: api.anthropic.com/v1/models needs a Max token, so an
  // unauthenticated GET answers 401 and would read as DOWN. Its health IS "do we hold accounts".
  // ── diagnostics ── (src/diagnostics.js)
  if (sub === "health" && req.method === "GET") return DX.health(req, res);
  if (sub === "models" && req.method === "GET") return DX.catalogs(req, res);
  if (sub === "limits" && req.method === "GET") return DX.harvestedLimits(req, res);
  if (sub === "crazyrouter" && req.method === "GET") return DX.crazyrouterStatus(req, res);
  if (sub === "crazyrouter/test" && req.method === "POST") return DX.crazyrouterTest(req, res);
  if (sub === "test" && req.method === "POST") return DX.testCall(req, res);
  if (sub === "resolve" && req.method === "POST") return DX.resolveTrace(req, res);

  // ── call log ── (src/calllog.js)
  if (sub === "calls" && req.method === "GET") return CL.listCalls(req, res);
  if (sub === "calls/facets" && req.method === "GET") return CL.callFacets(req, res);
  if (sub === "call" && req.method === "GET") return CL.getCall(req, res);
  if (sub === "export" && req.method === "GET") return CL.exportCalls(req, res);
  if (sub === "stats" && req.method === "GET") return AN.statsSummary(req, res);

  if (sub === "series" && req.method === "GET") return AN.seriesHistory(req, res);

  if (sub === "calls/clear" && req.method === "POST") return CL.clearCallLog(req, res, ip);

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
