// Module size, as a ratchet rather than a wish.
//
//   node test/module-size.test.mjs
//
// CLAUDE.md has carried a 500-line budget per module for a long time and nothing enforced it, so it
// drifted both ways: `http.js` was documented as "536 lines, over the 500 budget" long after the
// jsonenforce split took it to 400, while `server.js` and `admin.js` grew past 500 with no note at
// all. A budget nobody measures is a comment.
//
// It is a RATCHET, not a hard 500: failing the gate today on two files that are already over would
// mean either a red build or a scramble to split them under time pressure, and a split under
// pressure is how `HOP_RES` lost its import. So each over-budget file gets a ceiling at its current
// size — it may shrink, never grow — and anything new has the real 500 to live within.
//
// When you split one of these: lower its ceiling to the new size in the same commit. The test tells
// you the number. When a ceiling reaches 500, delete the entry.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET = 500;

// Files already over budget when this test was written (2026-07-30). Each may only get smaller.
// These are not exemptions — they are debts with a number attached.
const CEILINGS = {
  "server.js": 590,      // the HTTP layer + the path table + boot; the dispatch handler is the bulk
  "src/admin.js": 529,   // was 1179 before the four route modules were lifted out on 2026-07-26
  "src/config.js": 534,  // env defaults + the /data/config.json merge; two literals of every key
  "src/routing.js": 519, // the routing chain AND all of account selection — see the note below
};

// RAISED 2026-08-04 twice: first for the `openrouter` provider, then again (+2 server.js,
// +8 config.js, +8 routing.js) for the `any-available` account strategy. Recorded here rather than
// absorbed, because this ratchet only works if every increase is a sentence someone had to write.
//
// What those lines actually bought: a fourth provider costs an import, a state field, a config patch
// and a boot hook in each of server.js and admin.js, and there is no way to add one without touching
// both — the leaf half already went into src/openrouter.js for exactly this reason. `config.js` and
// `routing.js` were sitting at 500 and 499 — dead on the budget, i.e. already full — so they crossed
// on the first feature to arrive after them.
//
// The real fix is a split, and it is `src/routing.js`: account selection (autoAccount, acctUsable,
// the ACCT_COOL cooldown, firstUsableAccount, accountFor, autoDisableAccount) is ~215 coherent lines
// that have nothing to do with turning a model id into a base URL. Lifting them into their own
// module would take this file to ~305 and give both halves room. It is NOT done here on purpose:
// this repo's control-plane extractions were verified byte-for-byte before landing (see CLAUDE.md),
// and doing a 215-line move in the same commit as two behaviour changes is how a split goes wrong.
// Do it on its own, and lower the ceiling to the new number in that commit.

const files = ["server.js", "translate.js",
  ...readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".js")).map((f) => `src/${f}`)];

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, why) => { fail++; console.log(`  FAIL  ${m}\n        ${why}`); };

console.log("module size — the documented budget, measured:");
for (const rel of files) {
  // Count like `wc -l` does — newlines, not fragments. Splitting on "\n" yields one extra for the
  // trailing newline every file here ends with, which is how the first ceilings landed one short.
  const txt = readFileSync(join(ROOT, rel), "utf8");
  const n = txt.split("\n").length - (txt.endsWith("\n") ? 1 : 0);
  const ceiling = CEILINGS[rel];
  if (ceiling === undefined) {
    if (n > BUDGET) bad(`${rel} is within the ${BUDGET}-line budget`,
      `${n} lines. Split it, or add a ceiling entry in this file with the reason — a new module over budget should be a decision, not a drift.`);
    else ok(`${rel} — ${n}`);
  } else if (n > ceiling) {
    bad(`${rel} does not grow past its ceiling`,
      `${n} lines, ceiling ${ceiling}. This file is already over the ${BUDGET}-line budget; it may shrink, never grow.`);
  } else if (n < ceiling) {
    // Shrinking without lowering the ceiling means the ratchet stops holding at the new size.
    bad(`${rel}'s ceiling matches its size`,
      `${n} lines but the ceiling still says ${ceiling}. Lower it to ${n} in test/module-size.test.mjs — that is what makes the ratchet hold.`);
  } else {
    ok(`${rel} — ${n}, at its ceiling (budget is ${BUDGET})`);
  }
}

// A ceiling for a file that no longer exists is a stale exemption that would silently permit the
// next file with that name to be born over budget.
for (const rel of Object.keys(CEILINGS)) {
  if (!files.includes(rel)) bad(`the ceiling for ${rel} still applies to a real file`, "no such file — remove the entry");
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
