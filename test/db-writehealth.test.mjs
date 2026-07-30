// A failed call-log write must be COUNTED, not just logged.
//
//   node test/db-writehealth.test.mjs
//
// `dbUp()` is `!!pool`, and a Pool is constructed the moment DATABASE_URL is set — pg does not
// connect until the first query. So `loggingDbReady: true` says "a config string was present",
// which is not the question anyone asks it. With the database unreachable the panel showed
// dbReady:true and an empty call log: indistinguishable from a quiet hour, while every row was
// being dropped into a stdout warning. Same failure the rest of this router keeps making — a
// plausible value standing in for an unknown.
//
// No network beyond loopback: the DSN points at a port with nothing listening, so every write
// fails with ECONNREFUSED. That is the honest simulation of the outage this counter exists for.
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const req_ = createRequire(import.meta.url);

let pass = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, why) => { console.log(`  FAIL  ${m}\n        ${why}`); process.exitCode = 1; };
const check = (m, actual, expected) => (actual === expected ? ok(m) : bad(m, `expected ${expected}, got ${actual}`));

// A port that is definitely closed: bind one, read the number, release it.
const probe = net.createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const DEAD_PORT = probe.address().port;
await new Promise((r) => probe.close(r));

process.env.DATABASE_URL = `postgres://u:p@127.0.0.1:${DEAD_PORT}/nope`;
const db = req_(join(ROOT, "src/db.js"));

console.log("call-log write health:");

check("a fresh process has recorded no failures", db.dbWriteHealth().failures, 0);
check("...and no last error", db.dbWriteHealth().lastError, null);

db.initDb();
// initDb fires its own ALTER TABLE, so a pool exists and at least that write is already in flight.
check("dbUp() is true with an UNREACHABLE database — this is the whole problem", db.dbUp(), true);

db.dbWrite("INSERT INTO calls (ts) VALUES ($1)", [1]);
db.dbWrite("INSERT INTO calls (ts) VALUES ($1)", [2]);

// The rejections land on the microtask queue after the socket gives up. ECONNREFUSED on loopback is
// immediate, but poll until it has actually happened rather than sleeping a guessed interval.
const deadline = Date.now() + 5000;
while (db.dbWriteHealth().failures < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));

const h = db.dbWriteHealth();
if (h.failures >= 3) ok(`every dropped write is counted (${h.failures} failures: the ALTER plus both INSERTs)`);
else bad("every dropped write is counted", `only ${h.failures} of 3 counted — a lost row left no trace`);

if (/ECONNREFUSED|connect/i.test(h.lastError || "")) ok(`the reason is kept, not just the count (${h.lastError})`);
else bad("the reason is kept", `lastError was ${JSON.stringify(h.lastError)}`);

if (h.lastErrorAt > 0 && h.lastErrorAt <= Date.now()) ok("...with a timestamp, so a stale outage is distinguishable from a live one");
else bad("lastErrorAt is a real timestamp", `got ${h.lastErrorAt}`);

// Reading must not clear the counters. An operator who opens the panel and sees 40k lost rows has
// to still see them on the next refresh — a self-clearing counter reports the outage exactly once,
// to whoever happened to look first.
const again = db.dbWriteHealth();
check("reading the counter does not reset it", again.failures, h.failures);

// And the panel has to actually receive it, or the counter is a private variable.
const { CFG } = req_(join(ROOT, "src/config.js"));
CFG.logging = { ...(CFG.logging || {}), enabled: true };
const { adminState } = req_(join(ROOT, "src/admin.js"));
const st = adminState();
check("adminState reports loggingDbReady", st.loggingDbReady, true);
if (st.loggingWrites && st.loggingWrites.failures === h.failures) ok("...alongside loggingWrites, which is what makes that flag readable");
else bad("adminState carries loggingWrites", `got ${JSON.stringify(st.loggingWrites)}`);

// A row can also be lost BEFORE the insert is attempted: recordCall shapes ~30 columns out of the
// record, and that whole block sat inside a catch that swallowed everything — no log, no counter,
// dbWriteHealth().failures still reading 0 while rows vanished. The file's promise is that write
// failures are COUNTED, not merely logged, and that only ever covered dbWrite's async catch. Same
// for recordLimits, which feeds ACCT_CACHE: stopping silently freezes every account's headroom at
// its last value.
{
  const before = db.dbWriteHealth().failures;
  db.recordCall(undefined);                   // throws inside the shaping, must not escape
  const after = db.dbWriteHealth();
  if (after.failures > before) ok("a row lost before the insert is counted like one pg rejected");
  else bad("a row lost before the insert is counted", `failures stayed at ${before} — it vanished`);
  if (/recordCall/.test(after.lastError || "")) ok("...naming which stage dropped it");
  else bad("the last error names the stage", `lastError was ${JSON.stringify(after.lastError)}`);

  const b2 = db.dbWriteHealth().failures;
  db.recordLimits({}, "acct", "org");         // no .get on the fake headers → throws inside
  if (db.dbWriteHealth().failures > b2) ok("a dropped limits harvest is counted too");
  else bad("a dropped limits harvest is counted", "it vanished");
}


console.log(`\n${pass} passed${process.exitCode ? " · FAILURES ABOVE" : ""}`);
process.exit(process.exitCode || 0);   // the pg pool keeps the loop alive with a dead upstream
