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
const MODULES = ["config", "db", "routing", "http", "identity", "telemetry", "claudecode", "pricing", "registry", "admin"];

const exportsOf = {};
for (const m of MODULES) {
  try { exportsOf[m] = require_(path.join(root, "src", `${m}.js`)); }
  catch (e) { console.error(`  cannot load src/${m}.js: ${e.message}`); process.exit(1); }
}

// Strip comments and string/template literals so a name inside a SQL string or a doc comment is not
// mistaken for a call.
const strip = (s) => s
  .replace(/\/\/.*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, "''");

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

console.log(failures ? `\n${checked} references checked, ${failures} unbound` : `  ok    ${checked} cross-module references, all bound`);
console.log(failures ? `\n0 passed, ${failures} failed` : "\n1 passed, 0 failed");
process.exit(failures ? 1 : 0);
