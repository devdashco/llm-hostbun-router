// A suite may not call an assertion helper it does not define.
//
//   node test/test-helpers.test.mjs      (also runs in `npm test`)
//
// Twenty suites, and no two agree on what the helpers are called: `check(name, actual, expected)`
// here, `check(name, bool)` there, `ok`/`bad` in nine files, `ok`/`fail` in four, `eq` in one,
// `expect` in another, and in waste.test.mjs `fail` is a COUNTER, not a function. That is fine —
// each suite is standalone by design, zero deps, and unifying them would be churn across every file
// for no behaviour.
//
// What is not fine is the failure mode. A helper that does not exist throws a ReferenceError only on
// the line that calls it, and the passing branch is usually a DIFFERENT function — so a check whose
// `else` calls a missing `bad()` looks perfectly green until the day it is supposed to fail, and
// then crashes instead of reporting. It happened three times in one session while writing these
// tests, and the first probe of a real bug read as "0 failures" because of it.
//
// So this is deliberately narrow: only the known assertion vocabulary, only calls, only in test
// files. A general "any undefined identifier" version of this over src/ was tried before and flagged
// eleven things on a clean tree — a check that cries wolf gets switched off.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Deliberately not `is`, `same` or `must`: they are English as often as they are code, and with
// strings in scope `...which failure this is (${r.note})` reads as a call. A name that has to be
// disambiguated by context does not belong in a check whose value is that it never cries wolf.
const HELPERS = ["ok", "bad", "fail", "check", "eq", "assert", "expect"];

const files = [
  ...readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => `test/${f}`),
  "translate.test.js",
];

let pass = 0, failures = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, why) => { failures++; console.log(`  FAIL  ${m}\n        ${why}`); };

// COMMENTS only. Blanking string and template literals too — the way imports.test.mjs does — is
// wrong here: several of these files contain regex literals that themselves hold backticks and
// quotes (this one included), so a template-aware strip swallows the rest of the file and the
// check silently inspects nothing. Measured: with strings stripped, this file and
// translate.test.js both reported "no helper calls" while plainly making them. A prose mention
// inside a string is a possible false positive; a whole file blanked is a guaranteed false
// negative, and this check exists precisely because a green result was hiding something.
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

console.log("every assertion helper a suite calls is one it defines:");
for (const rel of files) {
  const src = strip(readFileSync(join(ROOT, rel), "utf8"));
  // Defined how? `const ok =`, `let fail =`, `function check(`, a destructured import, or a
  // parameter (evaluate(rows, baseline, now, fired) style helpers passed in).
  const defined = new Set();
  for (const h of HELPERS) {
    const def = new RegExp(`(?:const|let|var|function)\\s+${h}\\b|\\b${h}\\s*(?::[^,}]*)?[,}]\\s*=\\s*require|\\{[^}]*\\b${h}\\b[^}]*\\}\\s*=`);
    if (def.test(src)) defined.add(h);
  }
  const called = new Set();
  for (const h of HELPERS) if (new RegExp(`(?<![.\\w])${h}\\s*\\(`).test(src)) called.add(h);
  const missing = [...called].filter((h) => !defined.has(h));
  if (missing.length) {
    bad(`${rel} calls ${missing.join(", ")} without defining it`,
      `this suite's helpers are: ${[...defined].join(", ") || "(none)"} — a call to a missing one throws only on the line that runs it, so the failing branch crashes instead of reporting and the check reads green until the day it should go red`);
  } else {
    ok(`${rel} — ${[...called].join(", ") || "no helper calls"}`);
  }
}

// ── a stub must precede the require of whatever destructures it ─────────────────────────────────
// `src/http.js`, `src/registry.js`, `src/imagetemplates.js` and friends do
// `const { recordCall } = require("./db")` at module load, so a test that patches `db.recordCall`
// AFTER requiring them patches something nobody is holding. The failure is silent in the worst way:
// the suite runs, the assertions read an empty array, and you conclude the code under test never
// recorded anything. It cost three debugging detours in one session — once reporting a real bug as
// "0 failures", once failing a recovery case for the wrong reason, once blaming the wrong guard.
//
// The rule, statically checkable: no `db.<fn> = ` assignment may appear after the first require of a
// src module other than db.js and config.js (those two are the stub's own dependencies).
console.log("\ndb stubs are installed before the module that captures them:");
for (const rel of files.filter((f) => f.startsWith("test/"))) {
  const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
  const firstConsumer = lines.findIndex((l) =>
    /req_?\(join\(ROOT, "(src\/|server\.js)/.test(l) && !/src\/(db|config)\.js/.test(l));
  const late = lines.map((l, i) => [l, i]).filter(([l, i]) =>
    /^\s*db\.[a-zA-Z]+\s*=/.test(l) && firstConsumer >= 0 && i > firstConsumer);
  if (late.length) {
    bad(`${rel} stubs db AFTER requiring the module that captures it`,
      `line ${late[0][1] + 1}: ${late[0][0].trim().slice(0, 60)} — the require on line ${firstConsumer + 1} already destructured it, so this patch is invisible and the assertions below will read whatever the real function does`);
  } else if (lines.some((l) => /^\s*db\.[a-zA-Z]+\s*=/.test(l))) {
    ok(`${rel} — stubs first, then requires`);
  }
}

// ── the cccc MCP bundle is a COPY, and must stay byte-identical ─────────────────────────────────
// `cccc/server/claudectl_server.py` is canonical; `cccc/plugins/claudectl/mcp/claudectl_server.py`
// is the bundle the plugin cache imports. Which one loads depends on how cccc was installed, so a
// change to one and not the other means two machines running the same version answer differently —
// and the difference is invisible until someone compares outputs. deploy.sh resyncs them; nothing
// checked they were in sync, and this file was edited today.
console.log("\nthe cccc MCP server and its plugin bundle agree:");
{
  const a = join(ROOT, "cccc/server/claudectl_server.py");
  const b = join(ROOT, "cccc/plugins/claudectl/mcp/claudectl_server.py");
  if (!existsSync(a) || !existsSync(b)) ok("(one of the two copies is absent — nothing to compare)");
  else if (readFileSync(a, "utf8") === readFileSync(b, "utf8")) ok("cccc/server ≡ cccc/plugins/claudectl/mcp");
  else bad("the two copies of claudectl_server.py are identical",
    "they have drifted — fix cccc/server/claudectl_server.py, then copy it over the plugin bundle (cccc/deploy.sh does this)");
}

console.log(`\n${failures ? "FAIL" : "PASS"} — ${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
