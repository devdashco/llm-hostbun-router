// Static check: every cross-module function call is actually bound in the file that makes it.
//
// Splitting the 2.9k-line monolith into src/ left TWELVE module-level identifiers behind — defined
// in one file, still referenced from another, with no import. Node does not complain at require
// time; each one throws a ReferenceError the first time its code path runs. The process-wide
// fatal-guard swallowed the throw, so the container stayed "healthy" while serving 502s.
//
// They were found one at a time, over hours, by hitting routes in production:
//   HOP_REQ, HOP_RES, HEADROOM_URL, IMAGE_MODEL_IDS, CONTENT_CAP, WINDOW_MS x2,
//   jsonEnforce, wantsJsonFormat, isGated x2, url, dbRow, extractRequestContent,
//   shipError, limitFor, projectUsage, dbUp
//
// This test finds all of them in about a second, without a database, a network, or a browser.
// It is deliberately conservative: it only flags a bare `name(` call when `name` is exported by
// another one of our modules and is NOT declared or destructured in the calling file. Property
// access (`C.WINDOW_MS`, `DB.dbRows`) is fine and is not flagged.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, "..");
// EVERY module in src/, derived — not a hand-kept list. The list used to be literal, and by
// 2026-07-26 it named ten modules while src/ held fifteen: analytics, calllog, accounts, consumers
// and jsonenforce were all split out during that session and none was added here. Those files were
// still SCANNED as callers, so the omission was invisible — what was missing is knowledge of their
// EXPORTS, so calling `usageRollup()` from another file without importing it would have passed.
// A hand-maintained list sitting next to a directory scan will drift; this cannot.
const MODULES = fs.readdirSync(path.join(root, "src"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => f.replace(/\.js$/, ""))
  .sort();

const exportsOf = {};
for (const m of MODULES) {
  try { exportsOf[m] = require_(path.join(root, "src", `${m}.js`)); }
  catch (e) { console.error(`  cannot load src/${m}.js: ${e.message}`); process.exit(1); }
}

// Strip comments and string/template literals so a name inside a SQL string or a doc comment is not
// mistaken for a call.
//
// The quoted-string classes are NEWLINE-BOUNDED (`[^"\\\n]`), and that is load-bearing rather than
// tidiness. A JS string literal cannot contain a raw newline, but the old `[^"\\]*` could, so a
// single unpaired quote anywhere — one apostrophe in a regex, one lone `"` — matched on to the next
// quote far below and blanked everything in between. The test then scanned the wreckage and found
// nothing to complain about. Measured before this fix: it was inspecting 11% of telemetry.js, 31% of
// db.js, 32% of config.js, 57% of registry.js, 58% of server.js. That is how `clip` sat unimported
// in telemetry.js from the 2026-07-10 split until 2026-07-26 — the one bug this file exists to
// catch, invisible to it for sixteen days. Bounding each class to a line caps the damage of a
// mispaired quote at that line. Template literals legitimately span lines and stay unbounded.
const strip = (s) => s
  .replace(/\/\/.*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
  .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
  .replace(/'(?:\\.|[^'\\\n])*'/g, "''");

const files = ["server.js", ...fs.readdirSync(path.join(root, "src")).filter((f) => f.endsWith(".js")).map((f) => `src/${f}`)];

let failures = 0, checked = 0;
for (const rel of files) {
  const raw = fs.readFileSync(path.join(root, rel), "utf8");
  const src = strip(raw);
  const reported = new Set();

  for (const [mod, exp] of Object.entries(exportsOf)) {
    if (rel === `src/${mod}.js`) continue;               // a module may call its own functions
    for (const name of Object.keys(exp)) {
      if (typeof exp[name] !== "function" || reported.has(name)) continue;
      // a bare call: `name(` not preceded by a dot or word char
      const calls = [...src.matchAll(new RegExp(`(^|[^.\\w])${name}\\s*\\(`, "g"))].length;
      if (!calls) continue;
      checked++;
      const declared =
        new RegExp(`(?:const|let|var|function|class)\\s+${name}\\b`).test(src) ||
        new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=`, "s").test(src);   // destructured from anything
      if (!declared) {
        console.log(`  FAIL  ${rel}: ${name}() called ${calls}x but never imported — lives in src/${mod}.js`);
        reported.add(name);
        failures++;
      }
    }
  }
}

// Node builtins that a split can lose just as easily (a missing `url` require cost us a hung
// endpoint and a 500). `path` and `url` are also perfectly ordinary local names — admin.js takes the
// request path as a parameter called `path` — so a name bound as a function parameter is not a
// missing import. Checking that distinction is the difference between a useful test and a noisy one.
const paramNames = (src) => {
  const names = new Set();
  for (const m of src.matchAll(/(?:function\s*\w*|\)\s*=>|\(([^()]*)\)\s*=>)?\s*\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const group of [m[1], m[2]]) {
      if (!group) continue;
      for (const p of group.split(",")) {
        const n = p.trim().split(/[=:\s]/)[0].replace(/^\.\.\./, "");
        if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
      }
    }
  }
  return names;
};

for (const rel of files) {
  const src = strip(fs.readFileSync(path.join(root, rel), "utf8"));
  const params = paramNames(src);
  for (const b of ["url", "crypto", "fs", "os", "net"]) {
    if (params.has(b)) continue;                       // it is a local, not the module
    if (!new RegExp(`(^|[^.\\w])${b}\\.\\w+\\s*\\(`).test(src)) continue;
    checked++;
    const bound = new RegExp(`(?:const|let|var)\\s+${b}\\b|\\{[^}]*\\b${b}\\b[^}]*\\}\\s*=`).test(src);
    if (!bound) { console.log(`  FAIL  ${rel}: uses ${b}.* but never requires it`); failures++; }
  }
}


// ── second pass: an export used as an OBJECT, never bound here ──────────────────────────────────
// The pass above only sees a bare `name(` CALL. `claudecodeCatalog.source` is neither a call nor a
// namespace access — it is an unbound identifier being read as an object — so admin.js threw
// ReferenceError on every GET /api/claudecode/models until 2026-07-26, and this file stayed green.
//
// Deliberately NARROW. A general "any dotted name that is not bound" check was tried first and
// flagged eleven things on a clean tree — locals declared in multi-declarator form, SQL fragments
// surviving the strip — and a check that cries wolf eleven times gets switched off. Starting from
// the known export list instead means it cannot flag a local, a parameter or a string.
//
// `bound` requires the name on the LEFT of an `=`. The first version accepted
// `const cat = claudecodeCatalog;` as a binding of claudecodeCatalog — the value, not the binding —
// so it could never fail. Verified both ways: zero hits clean, one hit with the bug reintroduced.
// The names pass 2 looks for: every module's EXPORTS, plus its module-scope SCREAMING_CASE consts.
// The second half is not decoration — HOP_RES was exactly that when it broke: defined at the top of
// http.js, NOT exported, and read as `HOP_RES.has(...)` in jsonenforce.js after the 8dc6ca3 split.
// With exports alone this file passes on that state; verified by reproducing it.
//
// SCREAMING_CASE is what keeps the widening free of noise. A lowercase set would collide with the
// `out` / `params` / `models` locals that live in half these files; measured on the clean tree, this
// adds 35 checks and zero false positives.
const scopeConsts = Object.fromEntries(MODULES.map((m) => [m,
  new Set([...fs.readFileSync(path.join(root, "src", `${m}.js`), "utf8")
    .matchAll(/^const\s+([A-Z][A-Z0-9_]*)\s*=/gm)].map((x) => x[1]))]));

for (const rel of files) {
  const src = strip(fs.readFileSync(path.join(root, rel), "utf8"));
  for (const [mod, exp] of Object.entries(exportsOf)) {
    if (rel === `src/${mod}.js`) continue;
    for (const name of new Set([...Object.keys(exp), ...(scopeConsts[mod] || [])])) {
      if (!new RegExp(`(^|[^.\\w$])${name}\\s*\\.`).test(src)) continue;   // used as an object
      if (new RegExp(`(^|[^.\\w$])${name}\\s*\\(`).test(src)) continue;    // a call — pass 1 owns it
      checked++;
      const bound = new RegExp(`(?:const|let|var|function|class)\\s+${name}\\b`).test(src)
                 || new RegExp(`(?:const|let|var)\\s[^;\\n]*?\\b${name}\\s*=`).test(src)
                 // BOTH destructuring forms. Object-only missed `const [sub, usage, models] = ...`,
                 // which is how three of the first version's false positives arose.
                 || new RegExp(`[\\{\\[][^{}\\[\\]]*\\b${name}\\b[^{}\\[\\]]*[\\}\\]]\\s*=`).test(src);
      if (!bound) {
        console.log(`  FAIL  ${rel}: ${name}.… read as an object but never bound — lives in src/${mod}.js`);
        failures++;
      }
    }
  }
}

console.log(failures ? `\n${checked} references checked, ${failures} unbound` : `  ok    ${checked} cross-module references, all bound`);
console.log(failures ? `\n0 passed, ${failures} failed` : "\n1 passed, 0 failed");
process.exit(failures ? 1 : 0);
