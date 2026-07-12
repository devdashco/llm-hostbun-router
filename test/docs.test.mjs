// The docs site is PUBLIC and unauthenticated (docs.llm.hostbun.cc, and /docs/ on the router).
// Two things must hold, and neither is obvious from reading the markdown:
//   1. It renders. docsify fetches its markdown at runtime, so a bad basePath or a missing route is a
//      permanent "loading…" that no build step would catch.
//   2. It leaks nothing. A password, a Max token or an sk-llm key pasted into a doc is world-readable
//      the moment it deploys.
//
//   node test/docs.test.mjs
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, connect } from "node:net";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = await new Promise((r) => { const s = createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => r(port)); }); });
const BASE = `http://localhost:${PORT}`;

const server = spawn("node", [join(ROOT, "server.js")], {
  env: { ...process.env, PORT: String(PORT), CONFIG_FILE: "/tmp/llm-docs-test.json", ADMIN_PASSWORD: "test-only",
         DOCS_FILE: join(ROOT, "docs/index.html"), DATABASE_URL: "" },
  stdio: "ignore",
});
process.on("exit", () => server.kill());
await new Promise((r) => setTimeout(r, 2000));

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
};

console.log("routes:");
const code = async (p) => (await fetch(`${BASE}${p}`, { redirect: "manual" })).status;
check("/docs redirects to /docs/ (relative asset paths depend on it)", await code("/docs") === 301);
check("/docs/ serves the shell", await code("/docs/") === 200);
check("markdown is served", await code("/docs/README.md") === 200);
check("the sidebar is served (leading underscore)", await code("/docs/_sidebar.md") === 200);
check("the vendored bundle is served", await code("/docs/vendor/docsify.js") === 200);
check("an unknown page 404s", await code("/docs/nope.md") === 404);
// fetch() normalizes ".." out of the path before it leaves the process, so a traversal test written
// with fetch tests nothing at all. Speak HTTP directly.
const rawGet = (path) => new Promise((resolve) => {
  const sock = connect(PORT, "localhost", () => sock.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
  let buf = "";
  sock.on("data", (d) => { buf += d; });
  sock.on("end", () => resolve(buf.split("\r\n")[0]));
  sock.on("error", () => resolve("ERR"));
});
check("traversal is refused", /404/.test(await rawGet("/docs/../server.js")), await rawGet("/docs/../server.js"));
check("encoded traversal is refused", /404/.test(await rawGet("/docs/..%2f..%2fetc/passwd")));

const md = (p) => readFileSync(join(ROOT, "docs", p), "utf8");
const pages = readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md"));

console.log("every sidebar link resolves:");
for (const link of [...md("_sidebar.md").matchAll(/\(([^)]+\.md)\)/g)].map((m) => m[1]))
  check(`sidebar → ${link}`, pages.includes(link));

console.log("nothing secret is published:");
// The docs describe the panel and the key format; they must never carry a live value.
const all = pages.map(md).join("\n") + readFileSync(join(ROOT, "docs/index.html"), "utf8");
check("no admin password", !/\bddash\b/.test(all));
check("no Max setup token", !/sk-ant-oat/.test(all));
check("no complete API key", !/sk-llm-[0-9a-f]{8}-[\w-]{20,}/.test(all));
check("no DATABASE_URL", !/postgres(ql)?:\/\/[^\s`]+:[^\s`]+@/.test(all));

console.log("it renders (docsify fetches its markdown at runtime):");
const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (e) => pageErrors.push(String(e.message || e)));
const dom = await JSDOM.fromURL(`${BASE}/docs/`, {
  runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole,
});
const { window } = dom;
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
};
// docsify replaces the #app node outright once it mounts, so assert on the body, not on #app.
const text = () => window.document.body.textContent || "";
check("docsify loaded from the vendored bundle", await until(() => window.Docsify || window.$docsify));
// The home page's own words, not the site title in the sidebar: "One OpenAI-compatible endpoint".
const rendered = await until(() => /One OpenAI-compatible endpoint/.test(text()));
check("the home page renders its markdown", rendered, rendered ? "" : `body was: ${text().trim().slice(0, 140)}`);
check("the sidebar rendered", await until(() => /Routing and providers/.test(window.document.body.textContent)));

dom.window.close();
server.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
