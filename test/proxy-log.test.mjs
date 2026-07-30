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

// ── the panel's image-template render — spend that never went through proxy() at all ────────────
// POST /api/image-templates/render calls crazyrouter with `fetch` directly (there is no caller
// request to forward, only a form submit), so none of proxy()'s recording machinery runs. It bills
// per token exactly like the public route, and every branch of it — success, upstream error, and a
// 200 that came back without an image — used to return with no row at all. A preview loop in the
// panel was therefore invisible in /api/stats and unfindable when the bill moved.
{
  const IT = req_(join(ROOT, "src/imagetemplates.js"));
  // Two upstream shapes on one server: a 200 carrying an image, and a 200 carrying none. The
  // second is the branch most worth a row — it BILLED and produced nothing usable.
  const cr = http.createServer((rq, rs) => {
    rs.writeHead(200, { "content-type": "application/json" });
    rs.end(JSON.stringify(/noimage/.test(rq.url)
      ? { usage: { prompt_tokens: 11, completion_tokens: 0, total_tokens: 11 } }
      : { data: [{ url: "https://example.invalid/i.png" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }));
  });
  await new Promise((r) => cr.listen(0, "127.0.0.1", r));
  const CR = `http://127.0.0.1:${cr.address().port}`;
  // A style-only template: no reference picture, so this exercises the billing path without
  // needing a file on disk. `reference` is optional by design (systemInstruction, reference, or both).
  const slug = "probe-style";
  CFG.imageTemplates = { ...(CFG.imageTemplates || {}), [slug]: { slug, name: "probe", systemInstruction: "in the style of a probe", model: "nano-banana" } };
  CFG.imageTemplateModels = ["nano-banana"];

  const render = async (base) => {
    CFG.bases = { ...(CFG.bases || {}), crazyrouter: base };
    rows.length = 0;
    const rq = fakeReq("/api/image-templates/render");
    rq.headers = { ...(rq.headers || {}), "content-type": "application/json" };
    const body = Buffer.from(JSON.stringify({ slug, prompt: "a cat" }));
    // readJson reads the request stream, so feed it one.
    const stream = new PassThrough();
    stream.end(body);
    Object.assign(rq, { on: stream.on.bind(stream), once: stream.once.bind(stream),
      removeListener: stream.removeListener.bind(stream), pipe: stream.pipe.bind(stream),
      [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
    const res = fakeRes();
    await IT.renderTemplate(rq, res, "127.0.0.1");
    return res;
  };

  if (!slug) bad("a seeded template exists to render", "CFG.imageTemplates is empty");
  else {
    const okRes = await render(CR);
    check("a successful panel render answers 200", okRes.status, 200);
    if (rows.length !== 1) bad("a successful panel render records exactly one row", `got ${rows.length} rows`);
    else {
      ok("a successful panel render records exactly one row");
      check("...against the provider that was actually billed", rows[0].provider, "crazyrouter");
      check("...naming where the spend came from", rows[0].project, "panel:image-template-render");
      check("...carrying the tokens upstream reported", rows[0].usage.total_tokens, 15);
    }
    const noneRes = await render(`${CR}/noimage`);
    check("a 200 with no image is reported as a 502 to the panel", noneRes.status, 502);
    if (rows.length !== 1) bad("...and still records the call that billed", `got ${rows.length} rows`);
    else {
      ok("...and still records the call that billed");
      check("...with the reason, not a silent success", /answered without an image/.test(rows[0].error || ""), true);
    }
  }
  // ── refusals on the PAID image route ──────────────────────────────────────────────────────────
  // /v1/images/generations with a template of ours is the one image path behind a key. A burst of
  // 401s there is someone probing the paid door and a burst of 403s is a locked key used from the
  // wrong client — and with no row, both read as "no image-template traffic", the same silence the
  // image-error branch used to produce. The text paths have recorded their refusals all along
  // (keyFail in server.js); this route did not.
  {
    const tpl = CFG.imageTemplates[slug];
    const prevAuth = CFG.auth;
    CFG.auth = { mode: "required" };
    rows.length = 0;
    const res = fakeRes();
    await IT.generate(fakeReq("/v1/images/generations"), res,
      { tpl, body: { template: slug, prompt: "a cat" }, ip: "203.0.113.9", docsUrl: "https://docs.invalid" });
    check("an unauthenticated call to the paid image route is 401", res.status, 401);
    if (rows.length !== 1) bad("...and is recorded, like the same refusal on a text path", `got ${rows.length} rows`);
    else {
      ok("...and is recorded, like the same refusal on a text path");
      check("...as blocked, since nothing reached an upstream", rows[0].provider, "blocked");
      check("...carrying the status a reader would filter on", rows[0].status, 401);
      check("...and the ip that was probing", rows[0].ip, "203.0.113.9");
      check("...and says a key is absent, in the one spelling the whole router uses", rows[0].error, "no key");
    }
    // The paid route must distinguish the two the same way the text paths and the ingest do: a
    // caller who needs a key, and a caller holding one for somewhere else. Three spellings of the
    // same condition also split it across three rows in the error rollups.
    {
      const rq2 = fakeReq("/v1/images/generations");
      rq2.headers = { ...rq2.headers, authorization: "Bearer 3b1c3830-dead-beef-0000-000000000000" };
      rows.length = 0;
      const res2b = fakeRes();
      await IT.generate(rq2, res2b, { tpl, body: { template: slug, prompt: "a cat" }, ip: "203.0.113.9", docsUrl: "https://docs.invalid" });
      check("a foreign credential on the paid image route says so", /not one of ours/.test(rows[0] ? rows[0].error : ""), true);
      check("...and never echoes the credential", /3b1c3830-dead/.test(JSON.stringify(rows[0] || {})), false);
    }

    // An AUTHENTICATED caller asking for a model this router will not render a template with. It
    // reaches no upstream and costs nothing, but it is a refusal an operator debugging a broken
    // integration needs to see — it is the difference between "they never called" and "we said no".
    rows.length = 0;
    CFG.auth = { mode: "off" };                 // skip the key gate; this branch is about validation
    const res2 = fakeRes();
    await IT.generate(fakeReq("/v1/images/generations"), res2,
      { tpl, body: { template: slug, model: "claude-opus-5", prompt: "a cat" }, ip: "203.0.113.9", docsUrl: "https://docs.invalid" });
    check("a non-image model on the template route is 400", res2.status, 400);
    if (rows.length !== 1) bad("...and is recorded too", `got ${rows.length} rows`);
    else {
      ok("...and is recorded too");
      check("...naming the model that was refused", rows[0].reqModel, "claude-opus-5");
      check("...with the reason", rows[0].error, "model_not_image_capable");
    }
    CFG.auth = prevAuth;
  }
  cr.close();
}

// ── an error PAGE is not an error message ───────────────────────────────────────────────────────
// When an ingress or CDN answers instead of the service, the body is a whole HTML document and the
// row's `error` used to be its first 120 characters. /api/stats groups on that string, so topErrors
// read `upstream 502: <!DOCTYPE html> <!--[if lt IE 7]>` — and the Health tab prints the dominant
// reason at the operator verbatim. Measured in prod 2026-07-30: 7,322 rows in 7 days, all that blob.
{
  const cf = http.createServer((rq, rs) => {
    rs.writeHead(502, { "content-type": "text/html" });
    rs.end(`<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie"> <![endif]-->\n<head><title>502 Bad Gateway</title></head><body>${"x".repeat(4000)}</body></html>`);
  });
  await new Promise((r) => cf.listen(0, "127.0.0.1", r));
  rows.length = 0;
  const res = fakeRes();
  await proxy(fakeReq("/v1/images/generations"), res, `http://127.0.0.1:${cf.address().port}`, {
    bodyBuf: Buffer.from(JSON.stringify({ model: "imagegen", prompt: "x" })),
    provider: "images", model: "imagegen", project: "someapp",
  });
  if (rows.length !== 1) bad("an html error page still records one row", `got ${rows.length} rows`);
  else {
    ok("an html error page still records one row");
    check("...with a reason a human can group on", rows[0].error, "upstream 502: html error page from the ingress: 502 Bad Gateway");
    check("...not the document itself", /DOCTYPE|<html/i.test(rows[0].error), false);
  }
  // The CALLER is unaffected: they still get the upstream's own body, verbatim.
  check("the caller still receives the upstream's message", /Bad Gateway/.test(JSON.parse(res.body || "{}").error?.message || ""), true);
  cf.close();
}

// ── a text-path upstream error kept its status and threw away its REASON ────────────────────────
// The body is already buffered on this path (it is what fills `respContent`), and the row still
// recorded a bare `upstream 500` — 4,195 such rows in the last 7 days, none of them saying why.
// Anthropic and crazyrouter both answer `{"error":{"type","message"}}`, and the type IS the answer.
{
  const jsonErr = http.createServer((rq, rs) => {
    rs.writeHead(500, { "content-type": "application/json" });
    rs.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
  });
  await new Promise((r) => jsonErr.listen(0, "127.0.0.1", r));
  rows.length = 0;
  const res = fakeRes();
  await proxy(fakeReq("/v1/chat/completions"), res, `http://127.0.0.1:${jsonErr.address().port}`, {
    bodyBuf: Buffer.from(JSON.stringify({ model: "gemini-2.5-flash", messages: [] })),
    provider: "crazyrouter", model: "gemini-2.5-flash", project: "someapp",
  });
  await new Promise((r) => { res.on("end", r); res.on("finish", r); setTimeout(r, 250); });
  if (rows.length !== 1) bad("a text-path upstream error records one row", `got ${rows.length} rows`);
  else {
    ok("a text-path upstream error records one row");
    check("...naming the upstream's own error type, not just the status",
      rows[0].error, "upstream 500: overloaded_error: Overloaded");
  }
  // A 200 must stay clean — a reason on a successful call would poison every error rollup.
  rows.length = 0;
  const okRes = fakeRes();
  const okSrv = http.createServer((rq, rs) => { rs.writeHead(200, { "content-type": "application/json" }); rs.end('{"choices":[]}'); });
  await new Promise((r) => okSrv.listen(0, "127.0.0.1", r));
  await proxy(fakeReq("/v1/chat/completions"), okRes, `http://127.0.0.1:${okSrv.address().port}`, {
    bodyBuf: Buffer.from(JSON.stringify({ model: "gemini-2.5-flash", messages: [] })),
    provider: "crazyrouter", model: "gemini-2.5-flash", project: "someapp",
  });
  await new Promise((r) => { okRes.on("end", r); okRes.on("finish", r); setTimeout(r, 250); });
  check("a 200 still records no error at all", rows.length === 1 && rows[0].error, null);
  jsonErr.close(); okSrv.close();
}

// ── the panel's test call ───────────────────────────────────────────────────────────────────────
// It bypasses proxy() (a form submit, no caller request to forward) and it SPENDS: crazyrouter per
// token, claudecode against a real subscription window. It recorded nothing, so an operator leaning
// on the button was invisible — the same gap the image-template render had. And for claudecode it
// posted /v1/chat/completions to api.anthropic.com with NO Authorization, so a test of any Claude
// model failed and blamed the router for the upstream's complaint.
{
  const DX = req_(join(ROOT, "src/diagnostics.js"));
  const { CFG: C } = req_(join(ROOT, "src/config.js"));
  const up = http.createServer((rq, rs) => {
    seen.push({ path: rq.url, auth: rq.headers.authorization || null, beta: rq.headers["anthropic-beta"] || null });
    rs.writeHead(200, { "content-type": "application/json" });
    rs.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
  });
  const seen = [];
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const UP = `http://127.0.0.1:${up.address().port}`;
  const prevBases = C.bases, prevRoutes = C.modelRoutes;
  C.bases = { ...C.bases, crazyrouter: UP };
  rows.length = 0;
  const res = fakeRes();
  const rq = fakeReq("/api/test");
  const stream = new PassThrough(); stream.end(Buffer.from(JSON.stringify({ model: "gemini-2.5-flash", prompt: "hi" })));
  Object.assign(rq, { on: stream.on.bind(stream), once: stream.once.bind(stream),
    removeListener: stream.removeListener.bind(stream), pipe: stream.pipe.bind(stream),
    [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  await DX.testCall(rq, res);
  if (rows.length !== 1) bad("a panel test call records one row", `got ${rows.length} rows`);
  else {
    ok("a panel test call records one row");
    check("...against the provider it actually billed", rows[0].provider, "crazyrouter");
    check("...naming where the spend came from", rows[0].project, "admin:test-call");
    check("...carrying the tokens upstream reported", rows[0].usage.prompt_tokens, 5);
  }
  // And the claudecode dialect: /v1/messages, a pinned account's token, the oauth beta header, and
  // a TRANSLATED body. Posting /v1/chat/completions there with no auth is what made every Claude
  // test fail and report the upstream's complaint as the router's fault.
  seen.length = 0; rows.length = 0;
  C.bases = { ...C.bases, claudecode: UP };
  const prevPool = C.claudecodeAccountPool, prevDefault = C.defaultAccount;
  C.claudecodeAccountPool = [{ name: "probe", token: "sk-ant-oat-fake" }];
  C.defaultAccount = "probe";
  const res2 = fakeRes();
  const rq2 = fakeReq("/api/test");
  const st2 = new PassThrough(); st2.end(Buffer.from(JSON.stringify({ model: "claude-haiku-4-5", prompt: "hi" })));
  Object.assign(rq2, { on: st2.on.bind(st2), once: st2.once.bind(st2),
    removeListener: st2.removeListener.bind(st2), pipe: st2.pipe.bind(st2),
    [Symbol.asyncIterator]: st2[Symbol.asyncIterator].bind(st2) });
  await DX.testCall(rq2, res2);
  if (!seen.length) bad("a claudecode test reaches the upstream", "nothing arrived");
  else {
    check("a claudecode test posts to /v1/messages, not /v1/chat/completions", seen[0].path, "/v1/messages");
    check("...with the pinned account's token", seen[0].auth, "Bearer sk-ant-oat-fake");
    check("...and the oauth beta header a Max token requires", /oauth-2025-04-20/.test(seen[0].beta || ""), true);
  }
  check("...and it is recorded against claudecode", rows.length === 1 && rows[0].provider, "claudecode");
  C.claudecodeAccountPool = prevPool; C.defaultAccount = prevDefault;

  C.bases = prevBases; C.modelRoutes = prevRoutes;
  up.close();
}

upstream.close();
console.log(`\n${pass} passed${process.exitCode ? " · FAILURES ABOVE" : ""}`);
