// Admission control — src/gate.js, driven through the REAL server against slow fake upstreams.
//
//   node test/gate.test.mjs      (also runs in `npm test`)
//
// The whole value of a gate is a number you cannot observe from the router's own 200s: "how many of
// these were in flight upstream at once". So the fakes COUNT, and the count is the assertion.
//
// Three things here would each silently un-gate the gate, and all three are pinned:
//
//   1. Releasing the slot when the work RESOLVES instead of when the response ends. proxy() returns
//      the moment it wires `r.pipe(res)` — the streamed body is still to come — so a release on
//      return hands the GPU to the next caller mid-render, which is the exact bug (concurrent
//      diffusers renders swapping each other's LoRA adapters) the gate exists to stop. The fake
//      upstreams therefore send headers IMMEDIATELY and dribble the body out over BODY_MS: under a
//      release-on-return bug the observed peak is the whole burst, not 1.
//   2. Gating the cloud providers too. claudecode and crazyrouter run their own concurrency and
//      their 429 is a signal to surface, not absorb — serialising them would be a self-inflicted
//      outage that no 500 would ever reveal. Pinned by asserting the cloud peak is > 1.
//   3. Leaking a slot when a queued caller hangs up. That one is invisible until the Nth request,
//      when the gate is permanently full and every caller 503s against an idle GPU.
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (name) => { console.log(`  ok    ${name}`); pass++; };
const bad = (name, why) => { console.log(`  FAIL  ${name}\n        ${why}`); fail++; };
const check = (name, cond, why) => (cond ? ok(name) : bad(name, why));

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

const BODY_MS = 400;          // how long the upstream takes to finish a body it has already headed
const QUEUE_MAX = 3;          // small on purpose: the overflow branch needs to be reachable

// A slow streaming upstream that reports the most requests it ever had in flight at once.
function slowUpstream() {
  const state = { live: 0, peak: 0, seen: 0 };
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      // Catalog GETs answer instantly and are NOT counted. The router sweeps /v1/models at boot and
      // on every mergedModels() call; counting those would put traffic nobody in this file sent into
      // the very concurrency number the file asserts on.
      if (req.method !== "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "fake-model", object: "model" }] }));
      }
      state.seen++;
      state.live++;
      if (state.live > state.peak) state.peak = state.live;
      // Headers NOW, body later — see note 1 above.
      res.writeHead(200, { "content-type": "application/json" });
      const payload = JSON.stringify({
        id: "chatcmpl-gate", object: "chat.completion", model: "fake",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.write(payload.slice(0, 10));
      setTimeout(() => { state.live--; res.end(payload.slice(10)); }, BODY_MS);
    });
  });
  return { state, server };
}

const local = slowUpstream(), cloud = slowUpstream();
const PORT = await freePort(), LOCAL_PORT = await freePort(), CLOUD_PORT = await freePort();
await new Promise((r) => local.server.listen(LOCAL_PORT, r));
await new Promise((r) => cloud.server.listen(CLOUD_PORT, r));

const cfgPath = path.join(os.tmpdir(), `gate-cfg-${process.pid}.json`);
fs.writeFileSync(cfgPath, JSON.stringify({
  bases: { local: `http://127.0.0.1:${LOCAL_PORT}`, crazyrouter: `http://127.0.0.1:${CLOUD_PORT}`,
    claudecode: `http://127.0.0.1:${CLOUD_PORT}`, images: `http://127.0.0.1:${LOCAL_PORT}` },
  // An id nothing else claims: the env-seeded modelRoutes sends the legacy `local`/`gemma` ids to
  // claudecode, and modelRoutes wins over localMap.
  localMap: { "gate-local": "fake-model" },
  crazyrouterKey: "test", requireProject: false, requireRegisteredConsumer: false,
  auth: { mode: "off" }, logging: { enabled: false, content: false },
  consumers: {}, consumerAliases: {},
}));

const srv = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(PORT), CONFIG_FILE: cfgPath, PRICES_FILE: "/nonexistent.json",
    ADMIN_PASSWORD: "ddash", SESSION_INSECURE: "1", DATABASE_URL: "", PANEL_DIR: "/nonexistent",
    GATE_LOCAL: "1", GATE_QUEUE_MAX: String(QUEUE_MAX) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => (log += d));
srv.stderr.on("data", (d) => (log += d));

const done = (code) => { srv.kill("SIGKILL"); local.server.close(); cloud.server.close(); process.exit(code); };

const up = async () => {
  for (let i = 0; i < 100; i++) {
    if (/llm-gateway on :/.test(log)) { try { await fetch(`http://127.0.0.1:${PORT}/v1/models`); return true; } catch {} }
    if (srv.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};
if (!(await up())) { console.error("server never came up. log:\n" + log); done(1); }

// Resolves only once the WHOLE body has been read — a status alone would say nothing about whether
// the slot was still held while the body streamed.
const call = (model, opts = {}) => fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, max_tokens: 4, messages: [{ role: "user", content: "hi" }] }),
  signal: opts.signal || AbortSignal.timeout(30_000),
}).then(async (r) => { await r.text(); return r.status; }).catch((e) => `ERR ${e.name}`);

console.log("gate");

// ── 1. a burst on the gated provider is serialised, and everything that fits in the queue is SERVED.
// This is the user-facing promise: send a pile, they go through one at a time, nobody is dropped.
{
  const burst = 1 + QUEUE_MAX;                       // one running + a full queue = all served
  const codes = await Promise.all(Array.from({ length: burst }, () => call("gate-local")));
  check(`a burst of ${burst} on a gated provider all return 200`,
    codes.every((c) => c === 200), `got ${JSON.stringify(codes)}`);
  check("the gated upstream never saw two at once",
    local.state.peak === 1, `peak concurrency upstream was ${local.state.peak}, expected 1`);
  check("every request actually reached the upstream (queued, not dropped)",
    local.state.seen === burst, `upstream saw ${local.state.seen} of ${burst}`);
}

// ── 2. the cloud providers are NOT gated. If this goes green-by-accident the gate has quietly been
// applied to api.anthropic.com, where it costs latency and hides real 429s.
{
  const codes = await Promise.all(Array.from({ length: 4 }, () => call("gate-cloud")));
  check("an ungated provider still answers a burst", codes.every((c) => c === 200), JSON.stringify(codes));
  check("an ungated provider runs them in PARALLEL",
    cloud.state.peak > 1, `cloud peak was ${cloud.state.peak} — the cloud lane has been gated`);
}

// ── 3. past the queue cap the answer is a refusal, not an unbounded wait. 1 in flight + QUEUE_MAX
// waiting are served; the rest are told to come back. All of them are issued in the same tick and
// the upstream holds each for BODY_MS, so none can complete before the last arrives.
{
  const before = local.state.seen;
  const codes = await Promise.all(Array.from({ length: 2 * (1 + QUEUE_MAX) }, () => call("gate-local")));
  const served = codes.filter((c) => c === 200).length;
  const refused = codes.filter((c) => c === 503).length;
  check("a full queue refuses with 503", refused > 0, `no 503 in ${JSON.stringify(codes)}`);
  check("exactly capacity+queue are served", served === 1 + QUEUE_MAX, `served ${served}, expected ${1 + QUEUE_MAX}`);
  check("a refused request never reaches the upstream",
    local.state.seen - before === served, `upstream saw ${local.state.seen - before} for ${served} served`);
  check("the gate still never ran two at once", local.state.peak === 1, `peak ${local.state.peak}`);
}

// ── 4. a caller that hangs up WHILE QUEUED is dropped from the queue and its slot is not leaked.
// The leak is the dangerous half: it is invisible until the gate is permanently full.
{
  const before = local.state.seen;
  const running = call("gate-local");                       // takes the only slot
  await new Promise((r) => setTimeout(r, 60));
  const ac = new AbortController();
  const abandoned = call("gate-local", { signal: ac.signal });   // queued behind it
  await new Promise((r) => setTimeout(r, 60));
  ac.abort();
  await Promise.all([running, abandoned]);
  await new Promise((r) => setTimeout(r, 100));
  check("an abandoned queued request is never sent upstream",
    local.state.seen - before === 1, `upstream saw ${local.state.seen - before}, expected 1`);
  // The real assertion: the gate is usable afterwards. A leaked slot 503s this.
  const after = await Promise.all([call("gate-local"), call("gate-local")]);
  check("the slot is not leaked by an abandoned caller", after.every((c) => c === 200), JSON.stringify(after));
}

// ── 5. /api/health reports the gates, including ones with no traffic. "absent" and "unlimited" must
// not look alike on a page whose job is to say whether anything is backed up.
{
  // /api/health sits behind the admin cookie like the rest of the control plane.
  const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: "POST", body: '{"password":"ddash"}' });
  const cookie = (String(login.headers.get("set-cookie") || "").match(/hb_admin=[^;]+/) || [])[0] || "";
  check("the harness got an admin cookie", !!cookie, "login failed — the checks below would be vacuous");
  const h = await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { cookie } })
    .then((r) => r.json()).catch(() => null);
  // The local gate is keyed per GPU BOX (`local@<host>`, see keyFor) — pbox and ww each get their
  // own queue — so the snapshot no longer has a plain `local` row to read. Find it by prefix.
  const localGate = h && h.gates && Object.entries(h.gates).find(([k]) => k === "local" || k.startsWith("local@"));
  check("/api/health carries a gate snapshot", !!localGate, JSON.stringify(h && h.gates));
  check("the images gate is reported at limit 1 before any image traffic",
    !!(h && h.gates && h.gates.images && h.gates.images.limit === 1),
    `images gate: ${JSON.stringify(h && h.gates && h.gates.images)}`);
  check("the gate drains — nothing is left holding a slot",
    !!(localGate && localGate[1].active === 0 && localGate[1].queued === 0), JSON.stringify(localGate));
}

// ── 6. the shipped defaults, read straight off the module. These are hardware facts (one diffusers
// pipeline; llama.cpp n_parallel 2), and a default silently changed to 0 is a gate that is gone.
{
  const { limitFor } = await import("../src/gate.js").then((m) => m.default || m);
  check("images defaults to 1 — one GPU, one pipeline", limitFor("images") === 1, String(limitFor("images")));
  check("claudecode is ungated by default", limitFor("claudecode") === 0, String(limitFor("claudecode")));
  check("crazyrouter is ungated by default", limitFor("crazyrouter") === 0, String(limitFor("crazyrouter")));
}

console.log(`\n${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
