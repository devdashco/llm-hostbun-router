// The consumer registry's control surface: who is allowed to call this router, and under what key.
//
// Fourth block out of admin.js's handleAdminApi. src/registry.js is the only writer to the DB —
// these routes are its HTTP face, and they exist separately from the pool routes in accounts.js
// because a consumer calls IN and an account is what we call OUT.
//
// Two properties here are load-bearing and neither is obvious from the code:
//   · a key hash NEVER leaves the process. The registry entry carries hashes; these routes return
//     `activeKeys` and the public 8-char id, never `hash`. router.test.mjs asserts it.
//   · a registry write with no DB refuses with 503 rather than writing CFG. The legacy path issued
//     a key that authenticated until the next registry write and then silently vanished. Pure
//     validation still answers without a DB, so a caller's error is about their request.
//
// The auth GATES themselves (`auth`, `consumers/enforce`) deliberately stay in the dispatcher:
// turning either on with an unseeded registry is an instant outage, and they are not registry CRUD.
const url = require("node:url");

const { CFG } = require("./config");
const { dbRows, dbUp } = require("./db");
const { sendJson, readJson } = require("./http");
const { sha256 } = require("./identity");
// registry.js pulls config/db/identity and nothing pulls admin, so there is no cycle here — the
// four inline require()s this replaced were habit, not a guard.
const REG = require("./registry");

async function setAlias(req, res, ip) {
  const p = await readJson(req, res);
  if (!p) return;
  try {
    await REG.setAlias({ from: p.from, to: p.to });
    console.log(`[admin] alias ${p.from} -> ${p.to || "(removed)"} ip=${ip}`);
    return sendJson(res, 200, { ok: true, consumerAliases: CFG.consumerAliases });
  } catch (e) {
    if (e instanceof REG.RegistryError) return sendJson(res, e.status, { error: e.message, ...e.extra });
    return sendJson(res, 500, { error: e.message });
  }
}

async function listConsumers(req, res) {
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
    return { name, kind: e.kind, owner: e.owner, note: e.note, keys, allowUa: e.allowUa || [],
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
async function addConsumer(req, res, ip) {
  const p = await readJson(req, res);
  if (!p) return;
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
async function issueKey(req, res, ip) {
  const p = await readJson(req, res);
  if (!p) return;
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
async function revokeKey(req, res, ip) {
  const p = await readJson(req, res);
  if (!p) return;
  try {
    await REG.revokeKey({ name: p.name, id: p.id });
    console.warn(`[admin] key REVOKED ${p.name} id=${p.id} ip=${ip}`);
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    if (e instanceof REG.RegistryError) return sendJson(res, e.status, { error: e.message, ...e.extra });
    return sendJson(res, 500, { error: e.message });
  }
}

// Lock a consumer's key to the clients it is supposed to be used by. Its own endpoint rather than a
// field on `POST consumers`, and logged, for the same reason as `auth` and `enforce`: setting it
// wrong 403s a live caller, so it should read as a deliberate act in the log, not as a side effect
// of a form save. Sending `allowUa: []` clears it.
async function setClientPolicy(req, res, ip) {
  const p = await readJson(req, res);
  if (!p) return;
  try {
    const out = await REG.setClientPolicy({ name: p.name, allowUa: p.allowUa });
    console.warn(`[admin] client policy ${out.consumer} allowUa=${out.allowUa.join(",") || "(cleared)"} ip=${ip}`);
    return sendJson(res, 200, { ok: true, ...out });
  } catch (e) {
    if (e instanceof REG.RegistryError) return sendJson(res, e.status, { error: e.message, ...e.extra });
    return sendJson(res, 500, { error: e.message });
  }
}

// WHO is actually using each key — distinct user-agent + source IP per consumer over a window.
// This is the reading you need BEFORE locking anything: it is what turned "developer keys are
// probably being shared" into "pmac's key ran 11,485 calls from a production box last week". Locking
// blind is the mistake this endpoint exists to prevent — the same one the image auth gate is still
// waiting on. Read-only, no DB → empty list plus `available:false`, never a confident zero.
async function listClients(req, res) {
  const q = url.parse(req.url, true).query;
  const days = Math.min(90, Math.max(1, parseInt(q.days || "7", 10) || 7));
  const since = Date.now() - days * 86400000;
  const rows = await dbRows(
    `SELECT split_part(project, ':', 1) AS consumer, COALESCE(ua,'') AS ua, ip,
            COUNT(*)::int AS calls,
            COALESCE(SUM(COALESCE(prompt_tokens,0) + COALESCE(completion_tokens,0)),0)::bigint AS tokens,
            MAX(ts) AS last_ts
       FROM calls
      WHERE ts > $1 AND project IS NOT NULL AND project <> '' AND provider <> 'blocked'
      GROUP BY 1,2,3 HAVING COUNT(*) > 0 ORDER BY 4 DESC LIMIT 500`, [since]);
  const reg = CFG.consumers || {};
  const clients = rows.map((r) => {
    const e = reg[r.consumer];
    const allow = (e && e.allowUa) || [];
    return {
      consumer: r.consumer, kind: e ? e.kind : null, ua: r.ua || null, ip: r.ip || null,
      calls: r.calls, tokens: Number(r.tokens), lastTs: Number(r.last_ts),
      allowUa: allow,
      // What WOULD happen if this consumer's current policy were enforced against this client. Null
      // when there is no policy: "no rule" and "allowed by the rule" are different answers.
      wouldBlock: allow.length ? !allow.some((p) => String(r.ua || "").toLowerCase().startsWith(String(p).toLowerCase())) : null,
    };
  });
  return sendJson(res, 200, { available: !!rows.length || dbUp(), days, clients });
}

// Auth mode. Separate + logged, like `consumers/enforce`: going to "required" 401s every caller
// that has not been issued a key, so the panel refuses to do it blind.
// Account-selection strategy. Its own logged endpoint (like auth/enforce), never POST config:
// flipping it is a deliberate act — it changes WHICH subscription every app bills to.

module.exports = { setAlias, listConsumers, addConsumer, issueKey, revokeKey, setClientPolicy, listClients };
