// proxy()'s early-return branches must still record a call-log row.
//
//   node test/proxy-log.test.mjs
//
// A row is how a call becomes attributable — who asked, what it cost, whether it worked. proxy()
// has several paths that answer the caller and `return` before reaching the normal recording code
// at the bottom, and each one is a chance to drop the row silently. The image-error branch did
// exactly that: an image call that SUCCEEDED was logged, one that failed upstream was not, so the
// log read "no image traffic" during an outage rather than "image traffic failing".
//
// No database and no network beyond loopback: `recordCall` is stubbed at the db module BEFORE
// http.js is loaded, because http.js destructures it at require time and a later patch would be
// captured too late to see.
import { createRequire } from "node:module";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const req_ = createRequire(import.meta.url);

const rows = [];
const db = req_(join(ROOT, "src/db.js"));
db.recordCall = (row) => rows.push(row);          // must precede the http.js require below
const { CFG } = req_(join(ROOT, "src/config.js"));
CFG.logging = { ...(CFG.logging || {}), enabled: true };
const { proxy } = req_(join(ROOT, "src/http.js"));

let pass = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, why) => { console.log(`  FAIL  ${m}\n        ${why}`); process.exitCode = 1; };
const check = (m, actual, expected) => (JSON.stringify(actual) === JSON.stringify(expected)
  ? ok(m) : bad(m, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));

// An upstream that fails the way the image service fails when its ingress is broken: an HTTP error
// status with a bare-text body, NOT a refused connection (that path is handled elsewhere and always
// did record, which is why the gap stayed hidden).
const upstream = http.createServer((rq, rs) => {
  rs.writeHead(504, { "content-type": "text/plain" });
  rs.end("upstream timed out");
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${upstream.address().port}`;

const fakeReq = (url, method = "POST") => ({
  url, method, headers: { "content-type": "application/json", "user-agent": "test" },
  socket: { remoteAddress: "127.0.0.1" },
  on() { /* body is supplied via bodyBuf, never read off the stream here */ },
});
const fakeRes = () => {
  const r = { status: 0, body: "", headers: null };
  r.writeHead = (s, h) => { r.status = s; r.headers = h; return r; };
  r.write = (c) => { r.body += c; return true; };
  r.end = (c) => { if (c) r.body += c; r.ended = true; return r; };
  r.on = () => r;
  return r;
};

console.log("proxy() early returns still record:");

// ── the image-error branch ──
{
  rows.length = 0;
  const res = fakeRes();
  await proxy(fakeReq("/v1/images/generations"), res, BASE, {
    bodyBuf: Buffer.from(JSON.stringify({ model: "sd-turbo", prompt: "x" })),
    provider: "images", model: "sd-turbo", project: "someapp",
  });
  check("an image upstream error answers the caller with the status", res.status, 504);
  check("...as an OpenAI-shaped JSON error", !!JSON.parse(res.body || "{}").error, true);
  if (rows.length !== 1) bad("an image upstream error records exactly one row", `got ${rows.length} rows`);
  else {
    ok("an image upstream error records exactly one row");
    const row = rows[0];
    check("...with the upstream status, not a 200", row.status, 504);
    check("...attributed to the image provider", row.provider, "images");
    check("...and to the project that asked", row.project, "someapp");
    check("...carrying the upstream's own message", /504/.test(row.error || "") && /timed out/.test(row.error || ""), true);
  }
}

upstream.close();
console.log(`\n${pass} passed${process.exitCode ? " · FAILURES ABOVE" : ""}`);
