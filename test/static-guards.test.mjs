// The guards on the only code that turns a URL into a file read.
//
//   node test/static-guards.test.mjs      (also runs in `npm test`)
//
// These lived in docs.test.mjs, which needs jsdom to prove the docsify site renders — a dev
// dependency, so the whole suite sits outside `npm test` and runs when someone remembers. That is
// the wrong home for a traversal probe and for the regression guard on a connection-exhaustion bug:
// both are about the SERVER, need no browser, and are exactly the checks you want on every push.
// Same split as docs-claims.test.mjs: divide by what a check NEEDS, not by what it is about.
//
// Everything here speaks raw HTTP. `fetch()` normalises `..` out of a path before the request leaves
// the process and rejects a NUL outright, so a traversal or NUL test written with fetch asserts
// nothing at all — it proves the client is well behaved, which was never in question.
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = await new Promise((r) => {
  const s = createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => r(port)); });
});

const server = spawn("node", [join(ROOT, "server.js")], {
  env: { ...process.env, PORT: String(PORT), CONFIG_FILE: "/tmp/llm-static-guards.json",
    ADMIN_PASSWORD: "test-only", DOCS_FILE: join(ROOT, "docs/index.html"),
    PANEL_DIR: join(ROOT, "panel/out"), DATABASE_URL: "" },
  stdio: "ignore",
});
process.on("exit", () => server.kill());
await new Promise((r) => setTimeout(r, 2000));

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
};

// One request, one socket, first response line only. A path is written verbatim into the request
// line — that is the whole point.
const rawGet = (path, timeoutMs = 4000) => new Promise((resolve) => {
  const sock = connect(PORT, "localhost", () => sock.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
  let buf = "";
  const t = setTimeout(() => { sock.destroy(); resolve("HUNG"); }, timeoutMs);
  sock.on("data", (d) => { buf += d; });
  sock.on("end", () => { clearTimeout(t); resolve(buf.split("\r\n")[0] || "EMPTY"); });
  sock.on("error", () => { clearTimeout(t); resolve("ERR"); });
});

console.log("static guards — nothing outside the served roots, and every request gets an answer:");

// Traversal, in the forms that actually differ. The panel guard resolves and normalises the path
// then checks it still starts with PANEL_DIR, so encoding does not help; the docs guard is a strict
// charset regex applied BEFORE decoding, so it cannot express a traversal at all.
for (const [label, path] of [
  ["literal ..", "/docs/../server.js"],
  ["encoded ..", "/docs/..%2f..%2fetc/passwd"],
  ["double-encoded ..", "/docs/%252e%252e%252fserver.js"],
  ["backslash", "/docs/..\\..\\server.js"],
  ["absolute path", "//etc/passwd"],
  ["panel root escape", "/../server.js"],
  ["panel encoded escape", "/%2e%2e%2fserver.js"],
]) {
  const line = await rawGet(path);
  // Anything that is not a 200 is a refusal; what matters is that no file content comes back and
  // that the connection is ANSWERED. A hang would read as "no leak" to a naive check.
  check(`${label} is refused`, /HTTP\/1\.1 \d{3}/.test(line) && !/ 200 /.test(line), line);
}

// A NUL byte made fs.readFile throw SYNCHRONOUSLY inside an async handler with no try/catch: the
// throw became an unhandled rejection the process guard only logged, no response was written, and
// the socket was never closed. `GET /x%00.js` held a connection open forever with zero bytes
// returned — cheap to repeat and needing no auth, so a connection-exhaustion primitive. The
// traversal guard passes it because a NUL does not break a string prefix check.
{
  const line = await rawGet("/panel-asset%00.js");
  check("a NUL byte in a path is ANSWERED, not left hanging", line !== "HUNG" && /HTTP\/1\.1 \d{3}/.test(line), line);
  check("...and the server still serves afterwards", /HTTP\/1\.1 200/.test(await rawGet("/docs/")), "");
}

// The redirect the docs site cannot work without: without it `vendor/docsify.js` resolves against
// `/` instead of `/docs/` and the page renders `loading…` forever.
check("/docs redirects to /docs/", /HTTP\/1\.1 301/.test(await rawGet("/docs")));

server.kill();
console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
