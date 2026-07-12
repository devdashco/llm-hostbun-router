// ─────────────────────────────────────────────────────────────────────────────
// Call log → Postgres (`llmrouter` DB on the pbox cluster; DATABASE_URL).
// One row per request that reaches a provider, refusals included.
//
// It used to be a SQLite file on the container's volume. That volume has no backup and dies with
// the app, and a rolling deploy put two containers on the same file — which is how logging silently
// disabled itself for a whole container lifetime. The log now lives in a real project database.
//
// `pg` is the router's ONLY dependency. Every DB call here is wrapped or fire-and-forget: losing the
// call log must never break proxying, which is the one job this process actually has.
const { Pool, types: pgTypes } = require("pg");
const { CFG } = require("./config");
const { priceMap, costUsd } = require("./pricing");

// Call log lives in the `llmrouter` Postgres, NOT on the container's volume. Unset => logging off;
// the router still proxies. Set in Coolify env, never in git — it carries the DB password.
const DATABASE_URL = process.env.DATABASE_URL || "";
// Max bytes of prompt / reply text stored per call (protects the DB from huge payloads).
const CONTENT_CAP = parseInt(process.env.CALL_CONTENT_CAP || "0", 10); // 0 = uncapped

// pg returns BIGINT (oid 20) as a STRING, because a 64-bit int can exceed Number.MAX_SAFE_INTEGER.
// Every bigint here is an epoch-ms timestamp, a row id, or a token count — all far inside that
// range. Left as strings they break `ts` arithmetic, JSON shapes the admin UI expects, and any
// SUM(). Parse them as numbers once, globally, instead of converting at 30 call sites.
pgTypes.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8
pgTypes.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric (SUM of ints)
let pool = null, insertsSincePrune = 0;
const dbUp = () => !!pool;

function initDb() {
  if (!DATABASE_URL) {
    console.error("[log] DATABASE_URL not set; call logging disabled");
    return;
  }
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    // The router is on hostbun and the DB is on pbox, so every query crosses the public internet.
    // A hung socket must not wedge a request handler.
    statement_timeout: 20_000,
    query_timeout: 20_000,
  });
  // A pool error (upstream restart, network blip) is emitted on the pool, not the query. Without a
  // listener Node treats it as an unhandled 'error' event and kills the process — taking the router
  // down because its *logging* backend hiccuped.
  pool.on("error", (e) => console.error(`[log] pg pool error: ${e.message}`));
  console.log(`[log] call DB → postgres ${DATABASE_URL.replace(/\/\/[^@]*@/, "//***@")}`);
  // acct_limits is keyed by Anthropic org-id, which is opaque — nothing in the row said WHICH of our
  // logins it belongs to, so the panel could only ever show accounts that had recently answered.
  // The table already exists in prod, so a CREATE TABLE IF NOT EXISTS would no-op here: it has to
  // be an explicit ADD COLUMN. Fire-and-forget, like every other write.
  dbWrite("ALTER TABLE acct_limits ADD COLUMN IF NOT EXISTS account TEXT", []);
}

// Fire-and-forget write. Never awaited on the hot path: an inference request must not wait on, or
// fail because of, a cross-internet INSERT.
function dbWrite(sql, params) {
  if (!pool) return;
  pool.query(sql, params).catch((e) => console.warn(`[log] write failed: ${e.message}`));
}
// Awaited read, used by the admin API. Returns [] rather than throwing so one bad panel can't 500
// the whole dashboard.
async function dbRows(sql, params = []) {
  if (!pool) return [];
  try { return (await pool.query(sql, params)).rows; }
  catch (e) { console.warn(`[log] query failed: ${e.message}`); return []; }
}
const dbRow = async (sql, params = []) => (await dbRows(sql, params))[0] || null;

// Awaited write that THROWS. dbWrite drops failures and dbRows swallows them — both are right for a
// call log, and both are wrong for the identity registry, where a lost INSERT means a consumer that
// looks registered in the panel and 401s on the wire. Returns the pg result (rowCount, rows).
async function dbExec(sql, params = []) {
  if (!pool) throw new Error("no database connection");
  return pool.query(sql, params);
}

// Latest rate-limit snapshot per Anthropic org, held in memory so acctHealth() can stay synchronous.
// recordLimits() refreshes it on every call that carries the headers; this primes it once at boot so
// a freshly restarted container still shows real headroom before the first Anthropic response lands.
const ACCT_CACHE = new Map();

// Accounts whose login itself is dead (403 permission_error: "OAuth authentication is currently not
// allowed for this organization"). A 429 waits for a reset; this does not — no window reset revives
// a cancelled subscription. Marked/cleared by refreshAccountLimits(); read by the auto account
// picker so it never selects a corpse. In-memory only: a restart re-learns it on the next sweep.
const ACCT_DEAD = new Set();

const FACET_CACHE = { at: 0, val: null };
// account name → Anthropic org-id, learned off response headers. Lets the accounts view join a pool
// entry to its acct_limits row without the caller having to know the opaque org id.
const ORG_OF_ACCOUNT = new Map();

async function primeAcctCache() {
  for (const r of await dbRows("SELECT org_id,u5,u7,reset5,reset7,s5,s7,ts,account FROM acct_limits")) {
    ACCT_CACHE.set(r.org_id, { u5: r.u5, u7: r.u7, reset5: r.reset5, reset7: r.reset7, s5: r.s5, s7: r.s7, ts: Number(r.ts) || 0 });
    if (r.account) ORG_OF_ACCOUNT.set(r.account, r.org_id);
  }
  if (ACCT_CACHE.size) console.log(`[log] primed headroom for ${ACCT_CACHE.size} account(s)`);
}
const clip = (s) => { const t = s == null ? "" : String(s); return (CONTENT_CAP > 0 && t.length > CONTENT_CAP) ? t.slice(0, CONTENT_CAP) : t; };


function recordLimits(headers, project, model, account) {
  if (!dbUp() || !headers) return;
  try {
    const h = (k) => headers.get(k);
    const org = h("anthropic-organization-id");
    const u5 = h("anthropic-ratelimit-unified-5h-utilization");
    const u7 = h("anthropic-ratelimit-unified-7d-utilization");
    if (!org || (u5 == null && u7 == null)) return;               // not an Anthropic-native reply
    if (account) ORG_OF_ACCOUNT.set(account, org);
    const num = (v) => (v == null || v === "" ? null : Number(v));
    dbWrite(
      `INSERT INTO acct_limits (org_id,ts,u5,u7,reset5,reset7,status,s5,s7,project,model,account)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (org_id) DO UPDATE SET
         ts=EXCLUDED.ts, u5=EXCLUDED.u5, u7=EXCLUDED.u7, reset5=EXCLUDED.reset5, reset7=EXCLUDED.reset7,
         status=EXCLUDED.status, s5=EXCLUDED.s5, s7=EXCLUDED.s7, project=EXCLUDED.project, model=EXCLUDED.model,
         account=COALESCE(EXCLUDED.account, acct_limits.account)`,
      [org, Date.now(), num(u5), num(u7),
        num(h("anthropic-ratelimit-unified-5h-reset")), num(h("anthropic-ratelimit-unified-7d-reset")),
        h("anthropic-ratelimit-unified-status") || null,
        h("anthropic-ratelimit-unified-5h-status") || null, h("anthropic-ratelimit-unified-7d-status") || null,
        project || null, model || null, account || null],
    );
    // Keep the in-process snapshot warm so acctHealth() stays synchronous (adminState is not async).
    ACCT_CACHE.set(org, { u5: num(u5), u7: num(u7),
      reset5: num(h("anthropic-ratelimit-unified-5h-reset")), reset7: num(h("anthropic-ratelimit-unified-7d-reset")),
      s5: h("anthropic-ratelimit-unified-5h-status") || null,
      s7: h("anthropic-ratelimit-unified-7d-status") || null, ts: Date.now() });
  } catch { /* never let limit-harvest break a request */ }
}

const CALL_COLS = "ts,ip,ua,method,path,req_model,provider,sent_model,key_label,status,duration_ms,stream," +
  "prompt_tokens,completion_tokens,total_tokens,error,req_content,resp_content,project,effort," +
  "thinking_tokens,max_tokens,temperature,user_id,cache_read,cache_write,stop_reason,tool_count," +
  "mcp_tools,tool_servers,tools_kb,msg_count,system_kb";
const CALL_PLACEHOLDERS = Array.from({ length: 33 }, (_, i) => `$${i + 1}`).join(",");

function recordCall(rec) {
  if (!dbUp() || !CFG.logging.enabled) return;
  try {
    const u = rec.usage || {};
    dbWrite(`INSERT INTO calls (${CALL_COLS}) VALUES (${CALL_PLACEHOLDERS})`, [
      rec.ts || Date.now(), rec.ip || null, rec.ua || null, rec.method || null, rec.path || null,
      rec.reqModel || null, rec.provider || null, rec.sentModel || null, rec.keyLabel || null,
      rec.status == null ? null : rec.status, rec.ms == null ? null : rec.ms, !!rec.stream,
      u.prompt_tokens ?? null, u.completion_tokens ?? null, u.total_tokens ?? null,
      rec.error || null,
      CFG.logging.content ? (rec.reqContent || null) : null,
      CFG.logging.content ? (rec.respContent == null ? null : (rec.full ? String(rec.respContent) : clip(rec.respContent))) : null,
      rec.project || null,
      rec.effort || null,
      rec.thinkingTokens == null ? null : rec.thinkingTokens,
      rec.maxTokens == null ? null : rec.maxTokens,
      rec.temperature == null ? null : rec.temperature,
      rec.userId || null,
      u.cache_read_input_tokens == null ? null : u.cache_read_input_tokens,
      u.cache_creation_input_tokens == null ? null : u.cache_creation_input_tokens,
      rec.stopReason || null,
      rec.toolCount == null ? null : rec.toolCount,
      rec.mcpTools == null ? null : rec.mcpTools,
      rec.toolServers || null,
      rec.toolsKb == null ? null : rec.toolsKb,
      rec.msgCount == null ? null : rec.msgCount,
      rec.systemKb == null ? null : rec.systemKb,
    ]);
    // retain=0 → keep every row forever (no pruning on any provider). Claude Code chats are exempt
    // and kept regardless; match both the pre- and post-rename provider names or one becomes prunable.
    if (CFG.logging.retain > 0 && ++insertsSincePrune >= 200) {
      insertsSincePrune = 0;
      dbWrite(
        `DELETE FROM calls WHERE provider NOT IN ('anthropic','claudecode')
           AND id NOT IN (SELECT id FROM calls WHERE provider NOT IN ('anthropic','claudecode')
                          ORDER BY id DESC LIMIT $1)`,
        [CFG.logging.retain]);
    }
  } catch (e) { /* never let logging break a request */ }
}

// Prime the harvested-headroom cache once the DB is up. Deferred, not awaited: a slow DB must never
// delay the first inference.
const primeAcctCacheSoon = () => setTimeout(() => { primeAcctCache().catch(() => {}); }, 1000).unref();

// The one destructive query in the API. Awaited (unlike every other write) because the admin caller
// is entitled to know whether the log is actually gone.
async function clearCalls() {
  if (!pool) return false;
  await pool.query("DELETE FROM calls");
  return true;
}

module.exports = {
  initDb, dbUp, dbRows, dbRow, dbExec, dbWrite, recordCall, recordLimits, primeAcctCache, primeAcctCacheSoon, clearCalls,
  ACCT_CACHE, ACCT_DEAD, ORG_OF_ACCOUNT, FACET_CACHE, clip, DATABASE_URL, CONTENT_CAP,
};
