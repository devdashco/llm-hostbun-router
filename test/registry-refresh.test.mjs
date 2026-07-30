// A refresh that cannot READ must not WRITE.
//
//   node test/registry-refresh.test.mjs      (also runs in `npm test`)
//
// `refresh()` is what projects the Postgres registry into CFG (what requests authenticate against)
// and into /data/config.json (what a cold boot authenticates against with the DB down). It read
// through `dbRows`, which swallows a query error and returns `[]` — indistinguishable from "no
// rows" — and then overwrote CFG.consumers unconditionally and persisted it.
//
// So one transient failure on the api_keys SELECT, on a link this repo's own notes flag as crossing
// the WAN, emptied every consumer's key list, wiped KEY_INDEX, and WROTE THAT TO DISK. Every caller
// then 401s with "unknown or revoked key" — indistinguishable from a mass revocation — and a restart
// does not recover it, because the mirror is now the empty version. Every registry write calls
// refresh(), including ones touching an unrelated consumer.
//
// No database: `dbExec` is stubbed on the db module before registry.js is required, the same way
// proxy-log.test.mjs stubs recordCall, and for the same reason — registry.js destructures at require
// time, so a later patch is captured too late to see.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const req_ = createRequire(import.meta.url);

const db = req_(join(ROOT, "src/db.js"));
const { CFG } = req_(join(ROOT, "src/config.js"));

// ONE stub, installed before the require and never replaced — registry.js destructures dbExec at
// require time, so reassigning db.dbExec later is captured too late to see. (Written that way first;
// the recovery case below failed for exactly that reason and not for the reason it was testing.)
// Everything variable is driven through these two knobs instead.
let failOn = null;          // a regex: which query dies this round
let keyRows = [{ id: "deadbeef", consumer_id: 1, hash: "h", created_at: 1, last_used_at: 0, revoked_at: null, note: null }];
let consumerNote = null;
let registered = new Set();     // which names the guards should see as live consumers
let aliasOf = new Map();        // which names are already an alias
const aliasWrites = [];         // params of every INSERT INTO consumer_aliases that got through
db.dbUp = () => true;
// dbRows is what setAlias/addConsumer read their guards through, and it must be stubbed BEFORE the
// require for the same reason dbExec is. (Installed after, the first time — the alias block below
// failed against the real dbRows and reported the wrong guard.)
db.dbRows = async (sql, params = []) => {
  if (/FROM consumers WHERE name=\$1/.test(sql)) return registered.has(params[0]) ? [{ id: 1 }] : [];
  if (/FROM consumer_aliases WHERE alias=\$1/.test(sql)) return aliasOf.has(params[0]) ? [{ target: aliasOf.get(params[0]) }] : [];
  return [];
};
db.dbExec = async (sql, params) => {
  if (/INSERT INTO consumer_aliases/.test(sql)) { aliasWrites.push(params); return { rows: [] }; }
  if (failOn && failOn.test(sql)) throw new Error("ECONNRESET");
  if (/FROM developers/.test(sql)) return { rows: [{ id: 9, name: "philip" }] };
  if (/FROM consumers/.test(sql)) return { rows: [{ id: 1, name: "acme", kind: "project", developer_id: null, note: consumerNote, allow_ua: null }] };
  if (/api_keys/.test(sql)) return { rows: keyRows };
  return { rows: [] };
};
const REG = req_(join(ROOT, "src/registry.js"));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, why) => { fail++; console.log(`  FAIL  ${m}\n        ${why}`); };
const check = (m, actual, expected) => (JSON.stringify(actual) === JSON.stringify(expected)
  ? ok(m) : bad(m, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));

console.log("registry refresh — a failed read must not blank the projection:");

await REG.refresh();
const keysNow = () => ((CFG.consumers || {}).acme || {}).keys || [];
check("a healthy refresh projects the consumer's key", keysNow().length, 1);

// The exact failure that produced the outage shape: the key query dies mid-refresh.
failOn = /api_keys/;
await REG.refresh();
check("a failed api_keys read leaves the key in place", keysNow().length, 1);
check("...and the consumer itself is still there", Object.keys(CFG.consumers || {}), ["acme"]);

// The other three reads matter the same way — a dead consumers query would empty the registry
// wholesale, which is the worse version of the same bug.
failOn = /FROM consumers/;
await REG.refresh();
check("a failed consumers read leaves the registry intact", Object.keys(CFG.consumers || {}), ["acme"]);

// And recovery: once the DB answers again, the projection updates. A guard that latched on the
// first error would be its own outage.
failOn = null;
keyRows = [];              // the key was genuinely revoked while we were blind
consumerNote = "back";
await REG.refresh();
check("a successful refresh still applies — including a genuine key removal", keysNow().length, 0);
check("...and the row it did read", ((CFG.consumers || {}).acme || {}).note, "back");

// ── an alias may not shadow a live consumer ─────────────────────────────────────────────────────
// Every guard in setAlias validated the TARGET. Nothing checked the alias NAME, so
// {from:"acme", to:"othercorp"} answered 200 while `acme` was still a registered consumer holding a
// key — and from then on every self-asserted `acme` call was attributed to othercorp, because
// normalizeConsumerPath() resolves aliases before asking whether the name is registered. Key-based
// auth is unaffected (the consumer comes from the key), so it is an attribution hijack: the kind of
// thing found months later in a cost review, if at all.
console.log("\nalias collisions:");
{
  registered = new Set(["acme", "othercorp"]);
  let err = null;
  try { await REG.setAlias({ from: "acme", to: "othercorp" }); } catch (e) { err = e; }
  if (!err) bad("aliasing a live consumer is refused", "it succeeded — acme's self-asserted traffic now bills othercorp");
  else {
    ok("aliasing a live consumer is refused");
    check("...as a conflict, not a validation error", err.status, 409);
    check("...and nothing was written", aliasWrites.length, 0);
    if (/registered consumer/.test(err.message)) ok("...saying why, and what an alias is for");
    else bad("the refusal explains itself", err.message);
  }
  // A LEGACY name — not registered — is exactly what an alias is for, and must still work.
  err = null;
  try { await REG.setAlias({ from: "old-name", to: "othercorp" }); } catch (e) { err = e; }
  if (err) bad("a legacy name can still be aliased onto a real consumer", err.message);
  else { ok("a legacy name can still be aliased onto a real consumer"); check("...and it was written", aliasWrites.length, 1); }

  // The collision from the other side: registering a consumer whose name is already an alias means
  // its traffic keeps landing on the alias target while the registry says it exists.
  aliasOf = new Map([["ghost", "othercorp"]]);
  err = null;
  try { await REG.addConsumer({ name: "ghost", kind: "project" }); } catch (e) { err = e; }
  if (!err) bad("registering over an existing alias is refused", "it succeeded — ghost would never receive its own traffic");
  else {
    ok("registering over an existing alias is refused");
    check("...as a conflict", err.status, 409);
    if (/alias for 'othercorp'/.test(err.message)) ok("...naming where the traffic is going instead");
    else bad("the refusal names the target", err.message);
  }
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
