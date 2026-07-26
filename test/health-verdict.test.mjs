// GET /api/health must not call a provider up when it knows it is not.
//
//   node test/health-verdict.test.mjs
//
// `local` and `crazyrouter` are really probed. `claudecode` deliberately is NOT — the only
// unauthenticated request we could make to api.anthropic.com reads as down, so a probe there would
// report a permanent outage. Its verdict is instead "do we hold a usable login", which is fine as a
// design and was wrong as an implementation: it was `pool.length > 0`, and the pool retains accounts
// the router itself auto-disabled after a 403 permission_error (a cancelled or refunded
// subscription). Every login dead therefore still answered up:true, and health.tsx renders
// "All healthy — providers up" whenever nothing reports !up.
//
// In-process on purpose: wire.test.mjs spawns the server as a child, so it can smoke the route but
// cannot pose the question that matters — what does this say when the pool is dead?
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const req_ = createRequire(import.meta.url);
const { CFG } = req_(join(ROOT, "src/config.js"));
const { ACCT_DEAD } = req_(join(ROOT, "src/db.js"));
const { health } = req_(join(ROOT, "src/diagnostics.js"));

let pass = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, why) => { console.log(`  FAIL  ${m}\n        ${why}`); process.exitCode = 1; };
const check = (m, actual, expected) => (actual === expected ? ok(m) : bad(m, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));

// The two real providers are probed over the network; point them at a dead port so this suite stays
// offline. Their verdicts are not what is under test here.
CFG.bases = { ...CFG.bases, local: "http://127.0.0.1:1", crazyrouter: "http://127.0.0.1:1" };

async function ask(pool, dead = []) {
  CFG.claudecodeAccountPool = pool;
  ACCT_DEAD.clear(); for (const n of dead) ACCT_DEAD.add(n);
  let body;
  await health({}, { writeHead() {}, setHeader() {}, end(b) { body = JSON.parse(b); } });
  return body.claudecode;
}

console.log("claudecode health verdict:");

{
  const r = await ask([{ name: "philip" }, { name: "cmejl3" }]);
  check("two living logins → up", r.up, true);
  check("...and both counted alive", r.alive, 2);
}

// The bug. This is not hypothetical: autoDisableAccount() sets `disabled` on a 403 permission_error
// from BOTH the live-limits probe and real inference traffic, and it never auto-re-enables.
{
  const r = await ask([{ name: "philip", disabled: true }, { name: "cmejl3", disabled: true }]);
  check("every login operator/auto-disabled → NOT up", r.up, false);
  check("...pool size still reported honestly", r.accounts, 2);
  check("...alongside how many can actually serve", r.alive, 0);
  if (/disabled/.test(r.note || "")) ok(`...with a note that says which failure this is (${r.note})`);
  else bad("the note distinguishes a dead pool from an empty one", `got ${JSON.stringify(r.note)}`);
}

// ACCT_DEAD is the runtime half of the same condition — a login observed dead this process, not yet
// persisted. A verdict that honours `disabled` but ignores this one is still wrong half the time.
{
  const r = await ask([{ name: "philip" }], ["philip"]);
  check("the only login in ACCT_DEAD → NOT up", r.up, false);
}

{
  const r = await ask([{ name: "philip", disabled: true }, { name: "cmejl3" }]);
  check("one dead, one alive → still up", r.up, true);
  check("...counting only the living one", r.alive, 1);
}

{
  const r = await ask([]);
  check("an empty pool → not up", r.up, false);
  check("...and says so, rather than blaming disabled accounts", r.note, "no accounts in the pool");
}

// A fabricated 200 made this entry indistinguishable on the wire from the two beside it that were
// genuinely measured — an inference wearing a measurement's clothes.
{
  const r = await ask([{ name: "philip" }]);
  check("no HTTP status is invented for a request never made", r.status, null);
  check("...and the entry says outright that it was not probed", r.probed, false);
}

ACCT_DEAD.clear();
console.log(`\n${pass} passed${process.exitCode ? " · FAILURES ABOVE" : ""}`);
