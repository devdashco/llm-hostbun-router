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
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const req_ = createRequire(import.meta.url);

// Bound the header wait to something a test can sit through. Set BEFORE http.js is required —
// it reads the env once at module load, exactly like HEADROOM_TIMEOUT_MS.
process.env.UPSTREAM_HEADER_TIMEOUT_MS = "400";

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
// A REAL Writable, not an object with write/end stubs. proxy()'s success path does `r.pipe(res)`,
// and pipe() calls dest.once/emit — a hand-rolled fake blows up with "dest.once is not a function"
// the moment a test stops exercising only the early-return branches. The first version of this file
// only ever drove a 504, so the omission was invisible until a 200 was tested.
const fakeRes = () => {
  const r = new PassThrough();
  r.status = 0; r.headers = null; r.body = "";
  r.on("data", (c) => { r.body += c; });
  r.writeHead = (s, h) => { r.status = s; r.headers = h; return r; };
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

// A GET through the image provider — /v1/templates and /v1/loras proxy to the same upstream as
// generations and sit above the auth gate, but they are GETs and match no path in the record regex,
// so nothing was ever written for them. In prod that showed as 200 of 200 image rows being
// `generations`: the other two could not be recorded, so an anonymous caller reaching an upstream we
// do not own left no durable trace and did not appear in the Health tab's unattributed-image count.
{
  rows.length = 0;
  const res = fakeRes();
  await proxy(fakeReq("/v1/templates", "GET"), res, BASE, { bodyBuf: Buffer.alloc(0), provider: "images" });
  // This one happens to record synchronously — the stub 504s, so the image-error branch writes the
  // row before proxy returns. Waiting anyway: the difference between this case and the vacuous one
  // below is only which branch the upstream steers into, and a stub that started answering 200 would
  // silently turn this into an assertion that cannot fail.
  await new Promise((r) => { res.on("end", r); res.on("finish", r); setTimeout(r, 250); });
  if (rows.length !== 1) bad("a GET through the image provider is recorded", `got ${rows.length} rows`);
  else {
    ok("a GET through the image provider is recorded");
    check("...with its own path, not folded into generations", rows[0].path, "/v1/templates");
    check("...and the image provider", rows[0].provider, "images");
  }
}

// A local read must STAY unlogged — it costs an upstream nothing and would drown the log.
//
// proxy() RETURNS BEFORE the response stream finishes: on the streaming path it calls r.pipe(res)
// and the row is written from the "end" handler. So asserting straight after the await checks
// nothing — the first version of this case passed identically with recordThis forced to `true`,
// which is a test that cannot fail. Wait for the response to actually end first.
{
  rows.length = 0;
  const res = fakeRes();
  await proxy(fakeReq("/v1/models", "GET"), res, BASE, { bodyBuf: Buffer.alloc(0), provider: "local" });
  await new Promise((r) => { res.on("end", r); res.on("finish", r); setTimeout(r, 250); });
  check("a local /v1/models GET is still not recorded", rows.length, 0);
}

// ── an upstream that accepts the connection and then says NOTHING ──
//
// Node's fetch has no default timeout, so this used to hang until the client, Cloudflare or a
// socket gave up — whichever came first — and the router recorded nothing at all. Measured against
// the image service on 2026-07-28: 115s+ per call, the caller shown Cloudflare's 524, and the call
// log silent about traffic that was actively failing. A stall must become OUR 504, with a row.
{
  const stall = http.createServer(() => { /* never respond, never close */ });
  await new Promise((r) => stall.listen(0, "127.0.0.1", r));
  const STALL = `http://127.0.0.1:${stall.address().port}`;
  rows.length = 0;
  const res = fakeRes();
  const t0 = Date.now();
  await proxy(fakeReq("/v1/images/generations"), res, STALL, {
    bodyBuf: Buffer.from(JSON.stringify({ model: "imagegen", prompt: "x" })),
    provider: "images", model: "imagegen", project: "stalled",
  });
  const ms = Date.now() - t0;
  check("a stalled upstream answers 504, not 502", res.status, 504);
  // The point of the timeout is that it RETURNS. Without one this line never runs at all, so the
  // bound is asserted rather than assumed — 5s is ~12x the configured 400ms, i.e. it fails on a
  // hang and not on a slow machine.
  check("...within the configured bound", ms < 5000, true);
  check("...saying the upstream sent no headers", /no response headers/.test(JSON.parse(res.body || "{}").error?.message || ""), true);
  if (rows.length !== 1) bad("a stalled upstream records exactly one row", `got ${rows.length} rows`);
  else {
    ok("a stalled upstream records exactly one row");
    check("...with 504, distinguishing a stall from an unreachable upstream", rows[0].status, 504);
    check("...attributed to the project that asked", rows[0].project, "stalled");
  }
  stall.close();
}

upstream.close();
console.log(`\n${pass} passed${process.exitCode ? " · FAILURES ABOVE" : ""}`);
