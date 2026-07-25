// The claudecode account pool, and the project pins that point at it.
//
// Third block out of admin.js's handleAdminApi (analytics.js and calllog.js were the first two).
// One subject: read the pool with its harvested headroom, add or rotate a token, disable a dead
// login, remove one, and pin a project to an account.
//
// Everything here except the pool read is a WRITE to /data/config.json — the account tokens live
// nowhere else, so each mutation persists and each one is logged with the ip that asked. The pins
// route merges a single entry on purpose: POST /api/config assigns projectAccounts wholesale, so a
// save built from a stale render would delete every other project's pin.
const { CFG, persistConfig } = require("./config");
const { dbRows, ACCT_DEAD, ORG_OF_ACCOUNT } = require("./db");
const { sendJson, readBody } = require("./http");
const { accountFor } = require("./routing");

async function listAccounts(req, res) {
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
async function setPin(req, res, ip) {
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
async function setAccountToken(req, res, ip) {
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
async function setAccountDisabled(req, res, ip) {
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
async function removeAccount(req, res, ip) {
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

module.exports = { listAccounts, setPin, setAccountToken, setAccountDisabled, removeAccount };
