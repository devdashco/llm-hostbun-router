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
import { readFileSync, readdirSync } from "node:fs";
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

console.log(`\n${failures ? "FAIL" : "PASS"} — ${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
