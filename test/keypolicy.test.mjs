// `allowUa` — the lock that stops a developer's key being used by an application.
//
// The bug it exists for was not on the wire: `pmac`'s key (a laptop) was serving 11,485 calls a week
// from 85.194.137.213 — a production box — while `bluebut` sat in the registry holding a key of its
// own. Everything authenticated, everything was logged, and the spend landed under a person.
//
// Three properties, each of which turns a mistake into an outage if it drifts:
//   · an EMPTY policy means unrestricted, never "nothing allowed". A save built from an empty form
//     must re-open the key, not take the consumer off the air.
//   · it REFUSES (403) rather than re-attributing the call to whoever it "should" have been. Guessing
//     an identity is what invariant 2 forbids on the routing side.
//   · the refusal names the fix. A 403 with no next step is a Slack message to whoever wrote this.
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  ok    ${n}`); pass++; };
const bad = (n, why) => { console.log(`  FAIL  ${n}\n        ${why}`); fail++; };
const check = (n, cond, why = "") => (cond ? ok(n) : bad(n, why));

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort(), UPSTREAM = await freePort();

const upstream = http.createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "x", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
await new Promise((r) => upstream.listen(UPSTREAM, r));

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const cfgPath = path.join(os.tmpdir(), `keypolicy-cfg-${process.pid}.json`);
fs.writeFileSync(cfgPath, JSON.stringify({
  bases: { local: `http://127.0.0.1:${UPSTREAM}`, crazyrouter: `http://127.0.0.1:${UPSTREAM}` },
  // Route the test model at the fake upstream explicitly: what this suite is about is the gate in
  // front of the proxy, not which provider a bare id resolves to.
  modelRoutes: { "fake-model": { provider: "crazyrouter" } }, crazyrouterKey: "test",
  auth: { mode: "required" }, logging: { enabled: false, content: false },
  consumers: {
    // A laptop, locked to the interactive client. This is the shape the fix ships as.
    pmac: { kind: "dev", owner: "philip", allowUa: ["claude-cli/"], keys: [{ id: "aaaa1111", hash: sha("pmacsecret") }] },
    // An app with no policy — the default, and the state every consumer is in until someone opts in.
    bluebut: { kind: "app", keys: [{ id: "bbbb2222", hash: sha("bluebutsecret") }] },
    // An explicitly empty list. Must behave EXACTLY like the absent field.
    wmac: { kind: "dev", owner: "philip", allowUa: [], keys: [{ id: "cccc3333", hash: sha("wmacsecret") }] },
  },
  consumerAliases: {},
}));

const srv = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(PORT), CONFIG_FILE: cfgPath, PRICES_FILE: "/nonexistent.json",
    ADMIN_PASSWORD: "ddash", SESSION_INSECURE: "1", DATABASE_URL: "", PANEL_DIR: "/nonexistent" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => (log += d));
srv.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 100 && !/llm-gateway on/.test(log); i++) await new Promise((r) => setTimeout(r, 100));

const call = async (key, ua) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "user-agent": ua },
    body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hi" }] }),
  });
  return { status: r.status, body: await r.text() };
};

try {
  check("boots", /llm-gateway on/.test(log), log.slice(-400));

  const app = await call("sk-llm-aaaa1111-pmacsecret", "node");
  check("an app using a locked developer key is REFUSED", app.status === 403, `${app.status} ${app.body.slice(0, 160)}`);
  check("...as a permission error, not an auth error", /client_not_allowed_for_key/.test(app.body), app.body.slice(0, 200));
  check("...naming the consumer the key belongs to", /pmac/.test(app.body));
  check("...and how to get its own key", /consumers\/keys/.test(app.body), app.body.slice(0, 300));

  const human = await call("sk-llm-aaaa1111-pmacsecret", "claude-cli/2.1.220 (external, cli)");
  check("the allowed client still gets through", human.status === 200, `${human.status} ${human.body.slice(0, 160)}`);
  const prefixOnly = await call("sk-llm-aaaa1111-pmacsecret", "CLAUDE-CLI/9.9.9");
  check("the match is a case-insensitive PREFIX, not equality", prefixOnly.status === 200, String(prefixOnly.status));

  // The whole point of the exercise: the app calling under its OWN name is unaffected.
  const owned = await call("sk-llm-bbbb2222-bluebutsecret", "node");
  check("an app with no policy is unrestricted", owned.status === 200, `${owned.status} ${owned.body.slice(0, 160)}`);
  const emptyList = await call("sk-llm-cccc3333-wmacsecret", "node");
  check("an EMPTY allowUa is unrestricted, not a lockout", emptyList.status === 200, String(emptyList.status));

  // A bad key must still read as a bad key. The policy check runs after authentication, so a broken
  // ordering here would answer 403 "wrong client" to someone whose real problem is a dead credential.
  //
  // The UA has to FAIL the policy for this to mean anything. It used to send `claude-cli/1`, which
  // pmac's allowUa accepts — so the request passed the policy under either ordering and answered
  // 401 either way. `node` is rejected by that policy, which is the only combination where
  // auth-first (401) and policy-first (403) give different answers.
  const badKey = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-llm-aaaa1111-wrong", "user-agent": "node" },
    body: JSON.stringify({ model: "fake-model", messages: [] }),
  });
  check("a bad secret is still 401, not 403 — authentication runs BEFORE the client policy",
    badKey.status === 401, String(badKey.status));
} finally {
  srv.kill("SIGKILL");
  upstream.close();
  try { fs.unlinkSync(cfgPath); } catch { /* gone */ }
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
