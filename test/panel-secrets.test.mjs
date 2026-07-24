// The Next panel is a STATIC EXPORT shipped to the browser: every byte in panel/out is public. This
// asserts no secret ever lands in a client bundle — the same guard docs.test.mjs runs over the docs.
// Run after `cd panel && npm run build` (or in the Docker build). If panel/out is absent it FAILS
// loudly rather than silently passing, so a missing build can't hide a leak.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "panel", "out");
let pass = 0;
const fail = (m) => {
  console.error("  FAIL  " + m);
  process.exitCode = 1;
};
const ok = (m) => {
  console.log("  ok    " + m);
  pass++;
};

if (!existsSync(OUT)) {
  fail(`panel/out missing — run \`cd panel && npm run build\` first (${OUT})`);
  process.exit(1);
}

// Same regexes docs.test.mjs uses: admin password, Max setup token, a complete sk-llm key, a DSN.
const SECRETS = [
  [/\bddash\b/, "admin password 'ddash'"],
  // Match a REAL token (sk-ant-oat01-<long secret>), not the bare vendor prefix — the panel's
  // Accounts page legitimately renders `sk-ant-oat…` / `sk-ant-oat01-…` as help text, a placeholder,
  // and a `/^sk-ant-oat/` paste-validation regex, none of which are secrets.
  [/sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/, "Anthropic Max setup token (sk-ant-oat01-…)"],
  [/sk-llm-[0-9a-f]{8}-[\w-]{20,}/, "a complete sk-llm-<id>-<secret> API key"],
  [/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/, "a DATABASE_URL with credentials"],
];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (![".js", ".html", ".css", ".txt", ".json", ".map"].includes(extname(p))) continue;
    const body = readFileSync(p, "utf8");
    for (const [re, label] of SECRETS) {
      if (re.test(body)) fail(`${label} found in ${p.slice(OUT.length + 1)}`);
    }
  }
}
walk(OUT);
if (!process.exitCode) ok("no admin password, setup token, API key or DSN in the built panel bundle");

// Sanity: the export actually built the panel (index + the routes we expect).
for (const slug of ["", "overview", "calls", "routing", "identity", "settings"]) {
  const f = join(OUT, slug, "index.html");
  if (existsSync(f)) ok(`exported ${slug || "/"} → index.html`);
  else fail(`missing exported route: ${slug || "/"} (${f})`);
}

console.log(`\n${pass} passed${process.exitCode ? " · FAILURES ABOVE" : ""}`);
