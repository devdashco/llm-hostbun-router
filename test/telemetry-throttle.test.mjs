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
const T = req(new URL("../src/telemetry.js", import.meta.url).pathname);
const { shipError, shipEvent } = T;

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

// The alerting channel's OWN failure must be visible. `.catch(() => {})` on the delivery fetch meant
// a HyperDX outage or a rotated ingest key dropped every WARN and ERROR with nothing anywhere
// saying so: an operator watching for `account_disabled` or `waste_burn` sees silence and reads it
// as nothing to report. Same failure dbWriteHealth() exists to prevent, one level deeper — not "the
// scan crashed" but "the scan found something and telling anyone about it failed".
{
  const before = T.shipHealth().failures;
  globalThis.fetch = () => Promise.reject(new Error("ECONNREFUSED"));
  T.shipError("delivery probe", { from: "test" });
  await new Promise((r) => setTimeout(r, 50));
  const h = T.shipHealth();
  if (h.failures > before) ok("a failed delivery is counted, not swallowed");
  else fail("a failed delivery is counted", `failures stayed at ${before} — the alert vanished`);
  if (/ECONNREFUSED/.test(h.lastError || "")) ok("...with the reason kept");
  else fail("the reason is kept", `lastError was ${JSON.stringify(h.lastError)}`);
  // A non-2xx is a failure too: a rotated key answers 401 and resolves the promise, so a
  // catch-only guard would have counted nothing at all for the most likely outage there is.
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 401 });
  const b2 = T.shipHealth().failures;
  T.shipError("delivery probe 2", { from: "test" });
  await new Promise((r) => setTimeout(r, 50));
  if (T.shipHealth().failures > b2) ok("a 401 from the ingest counts as a failure, not a delivery");
  else fail("a non-2xx counts", "a rotated ingest key would look like success");
}

console.log(`\n${pass} passed${process.exitCode ? " · FAILURES ABOVE" : ""}`);
