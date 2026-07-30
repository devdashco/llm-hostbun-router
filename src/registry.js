// The identity registry, in Postgres.
//
// Three entities, and they are NOT the same thing:
//
//   developer — a person.            philip, william
//   machine   — a person's box.      pmac, wmac, pbox, lprod        (belongs to a developer)
//   project   — code we deployed.    promopilot, redbut             (has NO owner: not a person)
//
// A machine and a project are both *callers*: either can appear on the wire as `<name>[:<job>]` and
// either can hold an API key. That is why they share ONE table, `consumers`, with one UNIQUE name —
// two tables would be two namespaces, and `pmac` could then exist as both a machine and a project
// while the wire name resolved to whichever query ran first. The distinction lives in `kind`, and
// the "a project has no owner" rule is a CHECK constraint, enforced by the database rather than by
// whichever code path happens to write the row.
//
// AVAILABILITY. The DB is the source of truth, but it is a cross-internet hop (see the cleartext
// warning in CLAUDE.md) and `authenticate()` runs on every inference request. So requests never
// touch Postgres: the registry is projected into CFG (in memory) and mirrored to /data/config.json
// on every change. A cold boot with Postgres down therefore still authenticates, from the mirror.
// If BOTH are gone the registry is empty and, with auth.mode=required, everything 401s — fail
// closed, on purpose. Losing the volume already loses the account tokens; this is not a new risk.
const { CFG, persistConfig, reindexKeys } = require("./config");
const { dbUp, dbRows, dbExec } = require("./db");
const { parseConsumer, sha256, mintKey } = require("./identity");

const now = () => Date.now();

// ── schema ────────────────────────────────────────────────────────────────
// Every statement is idempotent: initRegistry() runs on every boot.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS developers (
     id           BIGSERIAL PRIMARY KEY,
     name         TEXT NOT NULL UNIQUE,
     email        TEXT,
     created_at   BIGINT NOT NULL,
     disabled_at  BIGINT
   )`,
  `CREATE TABLE IF NOT EXISTS consumers (
     id           BIGSERIAL PRIMARY KEY,
     name         TEXT NOT NULL UNIQUE,
     kind         TEXT NOT NULL CHECK (kind IN ('machine','project')),
     developer_id BIGINT REFERENCES developers(id) ON DELETE RESTRICT,
     note         TEXT,
     created_at   BIGINT NOT NULL,
     disabled_at  BIGINT,
     CONSTRAINT consumer_ownership CHECK (
       (kind = 'machine' AND developer_id IS NOT NULL) OR
       (kind = 'project' AND developer_id IS NULL)
     )
   )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
     id           TEXT PRIMARY KEY,
     consumer_id  BIGINT NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
     hash         TEXT NOT NULL,
     created_at   BIGINT NOT NULL,
     last_used_at BIGINT,
     revoked_at   BIGINT,
     note         TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS api_keys_consumer ON api_keys (consumer_id)`,
  // Which clients may present this consumer's key — a comma-separated list of user-agent prefixes,
  // NULL/empty meaning unrestricted (see uaAllowed in identity.js). A separate ALTER rather than a
  // column in the CREATE above: `CREATE TABLE IF NOT EXISTS` no-ops against the table that is
  // already in prod, so a new column added there would exist only on a virgin database.
  `ALTER TABLE consumers ADD COLUMN IF NOT EXISTS allow_ua TEXT`,
  // An alias is a legacy caller name folded onto a canonical `<consumer>[:<job>]` path.
  `CREATE TABLE IF NOT EXISTS consumer_aliases (
     alias        TEXT PRIMARY KEY,
     target       TEXT NOT NULL,
     created_at   BIGINT NOT NULL
   )`,
];

// The wire name is a path; a consumer name may never contain the separator.
const cleanName = (s) => String(s || "").trim().toLowerCase();
const validName = (s) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s);

class RegistryError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// Reads fall back to the CFG mirror; a WRITE without the database would be a lie. It would look like
// it saved, live in memory until the next refresh(), and then vanish — which is exactly what the old
// CFG-writing key endpoint did. Refuse loudly instead.
function requireDb() {
  if (!dbUp()) throw new RegistryError("registry unavailable: no database connection", 503);
}

async function initRegistry() {
  if (!dbUp()) { console.warn("[registry] no DB — running from the /data/config.json mirror only"); return; }
  for (const sql of SCHEMA) await dbExec(sql);
  await seedFromMirror();
  await refresh();
}

// One-time import of the registry that used to live only in config.json. Idempotent: it only writes
// rows that are absent, so a re-run after the DB is authoritative is a no-op.
async function seedFromMirror() {
  const existing = await dbRows("SELECT COUNT(*)::int AS n FROM consumers");
  if (existing[0] && existing[0].n > 0) return;
  const mirror = CFG.consumers || {};
  if (!Object.keys(mirror).length) return;
  console.warn(`[registry] empty DB — importing ${Object.keys(mirror).length} consumer(s) from the config mirror`);
  for (const [name, e] of Object.entries(mirror)) {
    // The old model called a machine a "dev" and stored its owner as a bare string.
    const kind = e.kind === "dev" ? "machine" : "project";
    let devId = null;
    if (kind === "machine") {
      const owner = cleanName(e.owner) || "unknown";
      devId = await upsertDeveloper(owner);
    }
    await dbExec(
      `INSERT INTO consumers (name, kind, developer_id, note, created_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (name) DO NOTHING`, [name, kind, devId, e.note || null, now()]);
    const row = (await dbRows("SELECT id FROM consumers WHERE name=$1", [name]))[0];
    for (const k of (e.keys || [])) {
      await dbExec(
        `INSERT INTO api_keys (id, consumer_id, hash, created_at, last_used_at, revoked_at, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [k.id, row.id, k.hash, k.created || now(), k.lastUsed || null, k.revoked ? now() : null, k.note || null]);
    }
  }
  for (const [alias, target] of Object.entries(CFG.consumerAliases || {})) {
    await dbExec(`INSERT INTO consumer_aliases (alias, target, created_at) VALUES ($1,$2,$3)
                  ON CONFLICT (alias) DO NOTHING`, [alias, target, now()]);
  }
  console.warn("[registry] import complete");
}

async function upsertDeveloper(name, email) {
  requireDb();
  const n = cleanName(name);
  if (!validName(n)) throw new RegistryError(`invalid developer name '${name}'`);
  await dbExec(`INSERT INTO developers (name, email, created_at) VALUES ($1,$2,$3)
                ON CONFLICT (name) DO UPDATE SET email = COALESCE(EXCLUDED.email, developers.email)`,
    [n, email || null, now()]);
  const r = (await dbRows("SELECT id FROM developers WHERE name=$1", [n]))[0];
  return r.id;
}

// ── projection: DB -> CFG (what requests read) -> /data/config.json (the mirror) ──
// `kind` is projected back to the old dev/app words because identity.js, the pins and the panel all
// speak those. The DB is where the three-entity truth lives; this is its shadow.
// Read with dbExec, NOT dbRows. dbRows swallows a query error and returns [], which this function
// cannot tell apart from "no rows" — and it overwrites CFG.consumers unconditionally, then persists
// that to /data/config.json. So one transient failure on the api_keys SELECT (a link this repo's own
// notes flag as crossing the WAN) emptied every consumer's key list, wiped KEY_INDEX, and WROTE THAT
// TO DISK: every caller 401s with "unknown or revoked key", looking exactly like a mass revocation,
// and a restart does not recover it because the mirror is now the empty version. Reproduced.
// A refresh that cannot read is a refresh that must not write — the previous projection is stale at
// worst, and stale beats blank in the only direction that matters here.
const rowsOrThrow = async (sql) => (await dbExec(sql)).rows;

async function refresh() {
  if (!dbUp()) return;
  let devs, cons, keys, aliases;
  try {
    devs = await rowsOrThrow("SELECT id, name FROM developers WHERE disabled_at IS NULL");
    cons = await rowsOrThrow("SELECT id, name, kind, developer_id, note, allow_ua FROM consumers WHERE disabled_at IS NULL");
    keys = await rowsOrThrow("SELECT id, consumer_id, hash, created_at, last_used_at, revoked_at, note FROM api_keys");
    aliases = await rowsOrThrow("SELECT alias, target FROM consumer_aliases");
  } catch (e) {
    console.error(`[registry] refresh FAILED (${e.message}) — keeping the previous projection; CFG and the mirror are unchanged, so authentication keeps working on what we last read`);
    return;
  }
  const byId = new Map(devs.map((d) => [String(d.id), d.name]));

  const keysOf = new Map();
  for (const k of keys) {
    const list = keysOf.get(String(k.consumer_id)) || [];
    list.push({ id: k.id, hash: k.hash, created: Number(k.created_at) || 0,
      lastUsed: Number(k.last_used_at) || 0, revoked: !!k.revoked_at, note: k.note || undefined });
    keysOf.set(String(k.consumer_id), list);
  }
  const next = {};
  for (const c of cons) {
    const e = { kind: c.kind === "machine" ? "dev" : "app", keys: keysOf.get(String(c.id)) || [] };
    if (c.kind === "machine") e.owner = byId.get(String(c.developer_id)) || "unknown";
    if (c.note) e.note = c.note;
    // Only set when non-empty: `allowUa: []` and no field at all mean the same thing (unrestricted),
    // and carrying an empty array into the config mirror invites reading it as "nothing allowed".
    const allow = String(c.allow_ua || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (allow.length) e.allowUa = allow;
    next[c.name] = e;
  }
  CFG.consumers = next;
  CFG.consumerAliases = Object.fromEntries(aliases.map((a) => [a.alias, a.target]));
  persistConfig();   // writes the mirror AND reindexes the key lookup
  reindexKeys();     // belt and braces: persistConfig can fail on a read-only volume
}

// ── developers ────────────────────────────────────────────────────────────
async function listDevelopers() {
  return dbRows(`
    SELECT d.name, d.email, d.created_at,
      COALESCE(json_agg(c.name ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL), '[]') AS machines
    FROM developers d
    LEFT JOIN consumers c ON c.developer_id = d.id AND c.disabled_at IS NULL
    WHERE d.disabled_at IS NULL
    GROUP BY d.id, d.name, d.email, d.created_at ORDER BY d.name`);
}

// One consumer kind, listed with everything you need to decide whether it is healthy: who owns it
// (machines only), how many live keys it holds, and whether it has been used. A `project` with zero
// active keys cannot call the router at all now that auth is required — that is the number to watch.
async function listConsumers(kind) {
  // With no database this would return [] — which reads as "nothing is registered", not "I cannot
  // see". Serve the CFG mirror instead and say it is stale. An empty list and an unreachable
  // registry must never look alike.
  if (!dbUp()) {
    const want = kind === "machine" ? "dev" : "app";
    return Object.entries(CFG.consumers || {})
      .filter(([, e]) => e.kind === want)
      .map(([name, e]) => ({
        name, note: e.note,
        ...(kind === "machine" ? { developer: e.owner } : {}),
        activeKeys: (e.keys || []).filter((k) => !k.revoked).length,
        keyLastUsed: 0, created: 0,
        canCall: (e.keys || []).some((k) => !k.revoked),
        stale: true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const rows = await dbRows(`
    SELECT c.name, c.note, c.created_at, d.name AS developer,
      (SELECT COUNT(*)::int FROM api_keys k WHERE k.consumer_id = c.id AND k.revoked_at IS NULL) AS active_keys,
      (SELECT MAX(k.last_used_at) FROM api_keys k WHERE k.consumer_id = c.id) AS key_last_used
    FROM consumers c
    LEFT JOIN developers d ON d.id = c.developer_id
    WHERE c.kind = $1 AND c.disabled_at IS NULL
    ORDER BY c.name`, [kind]);
  return rows.map((r) => ({
    name: r.name, note: r.note || undefined,
    ...(kind === "machine" ? { developer: r.developer } : {}),
    activeKeys: r.active_keys, keyLastUsed: Number(r.key_last_used) || 0,
    created: Number(r.created_at) || 0,
    // Say it plainly rather than making the reader infer it from activeKeys === 0.
    canCall: r.active_keys > 0,
  }));
}

// Delete the call-log rows of a name that was never registered. Destructive and deliberately narrow:
// it REFUSES any name that is registered (use the consumer's own delete for those), refuses an empty
// name, and never takes a pattern — a bulk purge over a LIKE is how you lose promopilot's history to
// a typo. Returns the row count so the caller can see what it cost.
async function purgeUnregistered(name) {
  const n = cleanName(name);
  if (!n) throw new RegistryError("name required");
  requireDb();
  const registered = (await dbRows("SELECT 1 FROM consumers WHERE name = $1", [n]))[0];
  if (registered) throw new RegistryError(`'${n}' IS registered — delete the consumer instead of purging its history`, 409);
  const aliased = (await dbRows("SELECT 1 FROM consumer_aliases WHERE alias = $1", [n]))[0];
  if (aliased) throw new RegistryError(`'${n}' is an alias of a registered consumer — its calls are not orphans`, 409);
  // The log stores the full `<consumer>[:<job>]` path, so match the consumer half.
  const r = await dbExec("DELETE FROM calls WHERE split_part(project, ':', 1) = $1", [n]);
  return r.rowCount;
}

async function addDeveloper({ name, email }) {
  // Validate first, then demand a database — the rule addConsumer states and the rest of this file
  // did not follow. With the DB down, `POST /api/developers {}` answered `503 registry unavailable`
  // for a request that was malformed no matter what the database was doing, so a caller could not
  // tell "fix your request" from "come back later".
  if (!cleanName(name)) throw new RegistryError("name required");
  requireDb();
  await upsertDeveloper(name, email);
  await refresh();
}

// ON DELETE RESTRICT on consumers.developer_id makes the DB refuse this while a machine still points
// at the developer. Catch it and say what to do rather than surfacing a raw FK violation.
async function removeDeveloper(name) {
  const n = cleanName(name);
  if (!n) throw new RegistryError("name required");
  requireDb();
  const owned = await dbRows(
    `SELECT c.name FROM consumers c JOIN developers d ON d.id = c.developer_id WHERE d.name = $1`, [n]);
  if (owned.length) throw new RegistryError(
    `developer '${n}' still owns ${owned.length} machine(s)`, 409, { machines: owned.map((r) => r.name) });
  await dbExec("DELETE FROM developers WHERE name = $1", [n]);
  await refresh();
}

// ── consumers: machines and projects ──────────────────────────────────────
async function addConsumer({ name, kind, developer, note }) {
  const n = cleanName(name);
  if (!n) throw new RegistryError("name required");
  if (n.includes(":")) throw new RegistryError("register the consumer, not the job — drop everything after the ':'");
  if (!validName(n)) throw new RegistryError(`invalid name '${name}' — a-z 0-9 . _ - only`);
  if (kind !== "machine" && kind !== "project") throw new RegistryError("kind must be 'machine' or 'project'");
  // Refuse rather than drop it silently: an owner on a project is how "what do my developers cost"
  // quietly starts including cron jobs. This check, and every one above it, is true with or without
  // Postgres — so it answers before we demand a database. Everything below needs one.
  if (kind === "project" && cleanName(developer))
    throw new RegistryError("a project has no owner — it is not a person");
  if (kind === "machine" && !cleanName(developer))
    throw new RegistryError("a machine belongs to a developer — developer required");
  requireDb();

  // The same collision from the other side: registering a real consumer under a name that already
  // exists as an alias means every self-asserted call under that name keeps resolving to the alias
  // target, so the new consumer looks registered and silently never receives its own traffic.
  const aliased = (await dbRows("SELECT target FROM consumer_aliases WHERE alias=$1", [n]))[0];
  if (aliased) {
    throw new RegistryError(
      `'${n}' is an alias for '${aliased.target}' — its traffic would keep landing there. ` +
      `Remove the alias first (POST /api/registry/alias {from:"${n}", to:null}).`, 409);
  }

  let devId = null;
  if (kind === "machine") {
    const d = cleanName(developer);
    const known = (await dbRows("SELECT id FROM developers WHERE name=$1 AND disabled_at IS NULL", [d]))[0];
    if (!known) throw new RegistryError(`unknown developer '${d}' — register the person first`, 400);
    devId = known.id;
  }
  await dbExec(
    `INSERT INTO consumers (name, kind, developer_id, note, created_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (name) DO UPDATE SET kind=EXCLUDED.kind, developer_id=EXCLUDED.developer_id,
       note=COALESCE(EXCLUDED.note, consumers.note)`,
    [n, kind, devId, note || null, now()]);
  await refresh();
  return n;
}

async function removeConsumer(name) {
  const n = cleanName(name);
  if (!n) throw new RegistryError("name required");
  requireDb();
  const r = await dbExec("DELETE FROM consumers WHERE name = $1", [n]);
  if (!r.rowCount) throw new RegistryError(`unknown consumer '${n}'`, 404);
  await refresh();
}

// ── keys ──────────────────────────────────────────────────────────────────
// Issuing a key is how a consumer is registered when it does not exist yet: one call, so there is no
// separate "register" step to forget. The plaintext is returned once and never stored.
async function issueKey({ name, kind, developer, note }) {
  const n = cleanName(name);
  if (!n) throw new RegistryError("name required");
  if (n.includes(":")) throw new RegistryError("a key belongs to the consumer, not the job");
  requireDb();
  let row = (await dbRows("SELECT id FROM consumers WHERE name=$1", [n]))[0];
  if (!row) {
    if (!kind) throw new RegistryError(`'${n}' is new — say kind:"machine" or kind:"project" to create it`, 400, { kinds: ["machine", "project"] });
    await addConsumer({ name: n, kind, developer, note });
    row = (await dbRows("SELECT id FROM consumers WHERE name=$1", [n]))[0];
  }
  const k = mintKey();
  await dbExec(`INSERT INTO api_keys (id, consumer_id, hash, created_at, note) VALUES ($1,$2,$3,$4,$5)`,
    [k.id, row.id, sha256(k.secret), now(), note || null]);
  await refresh();
  return { consumer: n, keyId: k.id, key: k.raw };
}

async function revokeKey({ name, id }) {
  const n = cleanName(name);
  if (!n) throw new RegistryError("name required");
  if (!String(id || "").trim()) throw new RegistryError("key id required");
  requireDb();
  const r = await dbExec(
    `UPDATE api_keys SET revoked_at = $1 FROM consumers c
      WHERE api_keys.consumer_id = c.id AND c.name = $2 AND api_keys.id = $3 AND api_keys.revoked_at IS NULL`,
    [now(), n, String(id || "").trim()]);
  if (!r.rowCount) throw new RegistryError(`no active key '${id}' on consumer '${n}'`, 404);
  await refresh();
}

// ── aliases ───────────────────────────────────────────────────────────────
async function setAlias({ from, to }) {
  const f = cleanName(from);
  if (!f) throw new RegistryError("from required");
  if (f.includes(":")) throw new RegistryError("alias the consumer, not a job path");
  requireDb();
  if (to === null || to === "" || to === undefined) {
    await dbExec("DELETE FROM consumer_aliases WHERE alias = $1", [f]);
    await refresh();
    return;
  }
  const t = cleanName(to);
  if (t === f) throw new RegistryError("an alias to itself does nothing");
  // An alias whose NAME is a live consumer shadows it. Every guard below validates the TARGET; this
  // one validates the alias itself, and without it `{from:"acme", to:"othercorp"}` answered 200 and
  // silently re-attributed every self-asserted `acme` call to othercorp — the registry still listing
  // `acme` with its key, `normalizeConsumerPath()` resolving the alias before ever asking whether
  // the name is registered. Key-based auth is unaffected (the consumer comes from the key, never
  // through an alias), so this is attribution, not a credential bypass: exactly the kind of thing
  // that is discovered months later in a cost review. An alias exists to fold a LEGACY name onto a
  // real one — if the name is real, there is nothing to fold.
  const shadows = (await dbRows("SELECT 1 FROM consumers WHERE name=$1 AND disabled_at IS NULL", [f]))[0];
  if (shadows) {
    throw new RegistryError(
      `'${f}' is a registered consumer — aliasing it would silently bill its traffic to '${t}'. ` +
      `Alias a legacy name ONTO a consumer, not a consumer's own name away.`, 409);
  }
  const target = parseConsumer(t);
  const known = (await dbRows("SELECT 1 FROM consumers WHERE name=$1 AND disabled_at IS NULL", [target.consumer]))[0];
  // An alias onto an unregistered name is an outage disguised as a cleanup: it resolves to something
  // the registration gate then refuses.
  if (!known) throw new RegistryError(`alias target consumer '${target.consumer}' is not registered`, 400);
  const chained = (await dbRows("SELECT 1 FROM consumer_aliases WHERE alias=$1", [target.consumer]))[0];
  if (chained) throw new RegistryError(`'${target.consumer}' is itself an alias — chains are not resolved`, 400);
  await dbExec(`INSERT INTO consumer_aliases (alias, target, created_at) VALUES ($1,$2,$3)
                ON CONFLICT (alias) DO UPDATE SET target = EXCLUDED.target`, [f, t, now()]);
  await refresh();
}

// Which clients may present this consumer's key. `allowUa: []` (or null) CLEARS the lock — an empty
// list is "unrestricted", never "nothing allowed", so a save built from an empty form re-opens the
// key rather than taking a consumer off the air. Merge-safe by construction: one consumer per call,
// so this can never do what `POST config` does to the maps it assigns wholesale.
async function setClientPolicy({ name, allowUa }) {
  const n = cleanName(name);
  if (!n || !validName(n)) throw new RegistryError("valid consumer name required");
  requireDb();
  const known = (await dbRows("SELECT 1 FROM consumers WHERE name=$1 AND disabled_at IS NULL", [n]))[0];
  if (!known) throw new RegistryError(`consumer '${n}' is not registered`, 404);
  const list = (Array.isArray(allowUa) ? allowUa : String(allowUa || "").split(","))
    .map((s) => String(s).trim()).filter(Boolean);
  // A comma is the storage separator, so it cannot appear inside a prefix.
  if (list.some((p) => p.includes(","))) throw new RegistryError("a user-agent prefix may not contain a comma");
  await dbExec("UPDATE consumers SET allow_ua = $2 WHERE name = $1", [n, list.length ? list.join(",") : null]);
  await refresh();
  return { consumer: n, allowUa: list };
}

module.exports = {
  RegistryError, initRegistry, refresh, setClientPolicy,
  listDevelopers, addDeveloper, removeDeveloper,
  listConsumers, addConsumer, removeConsumer, purgeUnregistered,
  issueKey, revokeKey, setAlias,
};
