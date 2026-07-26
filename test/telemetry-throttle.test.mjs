// shipError/shipEvent collapse REPEATS of a signal already reported, and nothing else.
//
//   node test/telemetry-throttle.test.mjs
//
// Written after measuring the real thing: on 2026-07-26 the dead image ingress had put 601 copies of
// "upstream 504 POST /v1/images/generations" into HyperDX against ~529 rows of every other signal
// combined. An error channel where one stuck fault outnumbers everything else is one an operator
// stops reading.
//
// The property that matters is NOT "fewer logs" — it is that a DISTINCT signal is never delayed. A
// throttle that batched by time would hide a new fault behind an old one; this keys on the signal
// itself, so a first occurrence always ships immediately.
//
// HDX_KEY must be set before requiring telemetry.js (it is read at module scope), and fetch is
// stubbed so nothing leaves the process.
process.env.HYPERDX_INGEST_API_KEY = "test-key";
process.env.SHIP_WINDOW_MS = "60";   // 60ms, so the window actually elapses inside a test
process.env.HYPERDX_OTLP_URL = "http://127.0.0.1:1/v1/logs";
const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);

const sent = [];
globalThis.fetch = async (_url, init) => {
  const rec = JSON.parse(init.body).resourceLogs[0].scopeLogs[0].logRecords[0];
  sent.push({ body: rec.body.stringValue, attrs: Object.fromEntries((rec.attributes || []).map((a) => [a.key, a.value.stringValue])) });
  return { ok: true };
};
const { shipError, shipEvent } = req(new URL("../src/telemetry.js", import.meta.url).pathname);

let pass = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const fail = (m, why) => { console.log(`  FAIL  ${m}\n        ${why}`); process.exitCode = 1; };
const eq = (m, a, b) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : fail(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));

console.log("telemetry repeat-collapse:");

// 50 copies of one fault — the image-ingress shape.
for (let i = 0; i < 50; i++) shipError("upstream 504 POST /v1/images/generations", { ip: "1.2.3." + i });
eq("50 identical errors ship once", sent.length, 1);
eq("...and the one that shipped is the first, not a summary", sent[0].body, "upstream 504 POST /v1/images/generations");

// A DIFFERENT fault must not wait behind it. This is the whole point.
shipError("upstream 429 POST /v1/chat/completions", { account: "philip" });
eq("a distinct error is never delayed by a noisy one", sent.length, 2);

// Same text, different severity, is a different signal: an operator alerting on WARN must still see
// it even while the ERROR of the same wording is being suppressed.
shipEvent("upstream 429 POST /v1/chat/completions", { event: "account_cooldown" });
eq("severity is part of the signature", sent.length, 3);

// After the window, the repeat ships again AND carries how many were missed. The count is what makes
// suppression honest: without it, "601 identical errors" would become "1 error" and the operator
// would read a stuck fault as a one-off.
await new Promise((r) => setTimeout(r, 90));
shipError("upstream 504 POST /v1/images/generations", { ip: "9.9.9.9" });
eq("the repeat ships again once the window elapses", sent.length, 4);
eq("...and says how many it stood in for", sent[3].attrs.repeats_suppressed, "49");
if (/\+49 more/.test(sent[3].body)) ok("...in the message body too, where an operator will see it");
else fail("the summary body should name the count", sent[3].body);

shipError("a brand new fault", {});
eq("a brand new fault ships immediately", sent.length, 5);
eq("...and carries no repeat annotation", sent[4].attrs.repeats_suppressed, undefined);

console.log(`\n${pass} passed${process.exitCode ? " · FAILURES ABOVE" : ""}`);
