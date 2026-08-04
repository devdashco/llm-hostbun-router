// Diagnostics: is each provider reachable, what does it advertise, what would this model id do, and
// what does one real call cost. Everything here is a question ABOUT the router rather than a use of
// it — none of it routes traffic, mutates config or touches the registry.
//
// Split out of admin.js on 2026-07-26 (583 lines, over budget). The dependency runs one way,
// diagnostics -> {config,db,http,routing,claudecode}, and none of those import this, so reaching
// back for sendJson/resolveRoute cannot cycle. The auth gate stays in the dispatcher, as with every
// other route module: a route may move, the lock that guards it may not.
const { CFG } = require("./config");
const { dbRows, ACCT_DEAD } = require("./db");
const { sendJson, readBody, readJson, mask, upstreamReason } = require("./http");
const { resolveRoute, isGated, accountFor } = require("./routing");
const { recordCall } = require("./db");
const TR = require("../translate");
const { upstreamCatalogs, localModelEntries } = require("./claudecode");
const { snapshot: gateSnapshot } = require("./gate");
const { alertHealth } = require("./alert");

async function probe(base, authToken) {
  const t0 = Date.now();
  try {
    const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const r = await fetch(base + "/v1/models", { headers, signal: AbortSignal.timeout(12000) });
    let count;
    try { const j = await r.json(); count = (j && j.data && j.data.length) || undefined; } catch { /* non-json */ }
    return { up: r.ok, status: r.status, ms: Date.now() - t0, count };
  } catch (e) { return { up: false, status: 0, ms: Date.now() - t0, error: e.message }; }
}

// Check a crazyrouter key (defaults to the configured one): billing + catalog reachability.
async function crazyCheck(key) {
  const k = key || CFG.crazyrouterKey;
  const out = { keySet: !!k, keyMasked: mask(k) };
  if (!k) return { ...out, error: "no key set" };
  const base = CFG.bases.crazyrouter;
  const hdr = { authorization: `Bearer ${k}` };
  async function get(p) {
    try {
      const r = await fetch(base + p, { headers: hdr, signal: AbortSignal.timeout(12000) });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, ok: r.ok, json: j, text: t };
    } catch (e) { return { status: 0, ok: false, error: e.message }; }
  }
  const [sub, usage, models] = await Promise.all([
    get("/dashboard/billing/subscription"), get("/dashboard/billing/usage"), get("/v1/models"),
  ]);
  out.keyValid = models.ok && !(sub.json && sub.json.error);
  if (sub.json && typeof sub.json.hard_limit_usd === "number") out.hardLimitUsd = sub.json.hard_limit_usd;
  if (usage.json && typeof usage.json.total_usage === "number") out.totalUsageUsd = usage.json.total_usage / 100; // cents
  if (out.hardLimitUsd != null && out.totalUsageUsd != null) out.remainingUsd = Math.round((out.hardLimitUsd - out.totalUsageUsd) * 100) / 100;
  out.modelCount = (models.json && models.json.data && models.json.data.length) || 0;
  out.statuses = { subscription: sub.status, usage: usage.status, models: models.status };
  const errMsg = (sub.json && sub.json.error && sub.json.error.message) || (models.json && models.json.error && models.json.error.message);
  if (errMsg) out.message = errMsg;
  return out;
}

// Run a chat completion through current routing (admin is trusted → auto-injects the gate token).
// The panel's "test call". It does NOT go through proxy() — there is no caller request to forward,
// only a form — which is why the two things below had to be done by hand here.
//
// 1. claudecode needs its own dialect. This posted /v1/chat/completions to api.anthropic.com with
//    no Authorization at all, so a test of ANY Claude model failed and reported the upstream's
//    complaint as though the router were broken. Anthropic wants /v1/messages, a pinned account's
//    token, the oauth beta headers and a translated body — the router has all four already.
// 2. It spends. crazyrouter is billed per token and claudecode draws a real subscription window, so
//    a test that leaves no call-log row is spend nobody can see — the same gap the image-template
//    render had. `admin:test-call` is not a registered consumer on purpose: the row says where it
//    came from, and an operator pressing a button belongs to no caller.
async function adminTest(model, prompt, maxTokens) {
  const route = resolveRoute(model);
  const sendModel = route.rewriteModel || model;
  const t0 = Date.now();
  const openai = { model: sendModel, messages: [{ role: "user", content: prompt || "Reply with a short greeting." }], max_tokens: maxTokens || 256, stream: false };
  const done = (r) => {
    recordCall({ ts: t0, ip: null, ua: "panel", method: "POST", path: "/api/test",
      reqModel: model, sentModel: sendModel, provider: route.provider, keyLabel: `admin:${route.provider}`,
      status: r.status || 0, ms: Date.now() - t0, error: r.ok ? null : (r.error || `upstream ${r.status}${r.why ? `: ${r.why}` : ""}`),
      project: "admin:test-call", usage: r.usage || {} });
    return r;
  };
  let url = route.base + "/v1/chat/completions";
  let headers = { "content-type": "application/json" };
  let body = openai;
  if (route.provider === "crazyrouter") headers.authorization = `Bearer ${CFG.crazyrouterKey}`;
  else if (route.provider === "local" && isGated(route.target) && CFG.oblitToken) headers.authorization = `Bearer ${CFG.oblitToken}`;
  else if (route.provider === "claudecode") {
    const acct = accountFor("admin");
    if (!acct) return done({ ok: false, status: 0, provider: route.provider, sentModel: sendModel, ms: 0,
      error: "no usable Claude account — every login in the pool is disabled or dead, so there is nothing to test with" });
    url = route.base + "/v1/messages";
    headers = { "content-type": "application/json", ...TR.anthropicHeaders(acct.token) };
    body = TR.openaiToAnthropic(openai);
  }
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    const oa = route.provider === "claudecode" && j && j.content ? TR.anthropicToOpenai(j, { model }) : j;
    const m = oa && oa.choices && oa.choices[0] && oa.choices[0].message;
    const content = (m && (m.content || m.reasoning_content)) || null;
    return done({ ok: r.ok, status: r.status, provider: route.provider, sentModel: sendModel, ms: Date.now() - t0, content,
      // Same reasoning as the proxy paths: the body is right here, and "which model" or "out of
      // credit" is the whole content of a failed test call.
      why: r.ok ? "" : upstreamReason(text), usage: (oa && oa.usage) || {},
      raw: content == null ? text.slice(0, 2000) : undefined });
  } catch (e) { return done({ ok: false, status: 0, provider: route.provider, sentModel: sendModel, ms: Date.now() - t0, error: e.message }); }
}

async function health(req, res) {
  const [local, crazyrouter] = await Promise.all([
    probe(CFG.bases.local), probe(CFG.bases.crazyrouter, CFG.crazyrouterKey),
  ]);
  // claudecode is deliberately NOT probed: the only unauthenticated request we could make to
  // api.anthropic.com reads as down, so a probe here would report a permanent outage. Its health is
  // therefore "do we hold a usable login" — but that has to actually mean usable. It used to be
  // `pool.length > 0`, which counts accounts the router itself has auto-disabled after a 403
  // permission_error (a cancelled or refunded subscription). With every login dead the endpoint
  // still answered up:true, and the Health tab rendered "All healthy — providers up".
  //
  // NOT acctUsable(): that also excludes cooling and quota-spent accounts, and a 429 is a usage
  // WINDOW, not a capability — the per-model probe was deleted in 2026-07-11 for exactly that
  // confusion. Only the permanent conditions belong in a health verdict.
  const pool = CFG.claudecodeAccountPool || [];
  const alive = pool.filter((a) => !a.disabled && !ACCT_DEAD.has(a.name));
  const claudecode = {
    up: alive.length > 0,
    // Not 200. Nothing was requested, so there is no status to report, and synthesizing one made
    // this entry indistinguishable on the wire from the two beside it that really were measured.
    status: null, probed: false, ms: 0,
    count: (CFG.claudecodeModels || []).length,
    accounts: pool.length, alive: alive.length,
    note: pool.length === 0 ? "no accounts in the pool"
      : alive.length === 0 ? `all ${pool.length} accounts are disabled or OAuth-dead`
      : undefined,
  };
  // Admission control, so "the local model is slow" and "twelve callers are queued behind one GPU"
  // are distinguishable without reading the logs. Reported for every gated provider even at zero
  // traffic — absent and unlimited must not look alike.
  // The human-facing alert channel (src/alert.js). A rotated bot token drops every premium-app
  // warning silently — "nobody has created an opus app" and "nobody has been told" look identical
  // from here otherwise, which is the same trap dbWriteHealth and shipHealth exist for.
  return sendJson(res, 200, { local, crazyrouter, claudecode, gates: gateSnapshot(), alerts: alertHealth() });
}

async function catalogs(req, res) {
  const { claudecode, crazyrouter } = await upstreamCatalogs();
  return sendJson(res, 200, { local: localModelEntries(), claudecode, crazyrouter });
}

// Latest per-account rate-limit snapshot harvested off real traffic (zero-token; see recordLimits).
// One row per anthropic org-id with live 5h/7d utilization + reset + status. Dashboards read this
// instead of probing. Rows go stale for accounts with no recent traffic (ts shows how fresh).
async function harvestedLimits(req, res) {
  const rows = await dbRows("SELECT org_id,ts,u5,u7,reset5,reset7,status,s5,s7,project,model FROM acct_limits ORDER BY ts DESC");
  return sendJson(res, 200, { rows, now: Date.now() });
}

async function crazyrouterStatus(req, res) {
  return sendJson(res, 200, await crazyCheck());
}

async function crazyrouterTest(req, res) {
  const body = await readBody(req, res); if (body === null) return;   // over the cap: already answered 413
  let key = "";
  try { key = JSON.parse(body.toString()).key || ""; } catch {}
  return sendJson(res, 200, await crazyCheck(key));
}

async function testCall(req, res) {
  const p = await readJson(req, res);
  if (!p) return;
  if (!p.model) return sendJson(res, 400, { error: "model required" });
  return sendJson(res, 200, await adminTest(p.model, p.prompt, p.max_tokens));
}

// Dry-run: show exactly where a model name routes, without calling upstream.
async function resolveTrace(req, res) {
  const p = await readJson(req, res);
  if (!p) return;
  const r = resolveRoute(p.model, p.project);
  const sent = r.rewriteModel || (r.provider === "local" ? r.target : p.model) || p.model || "";
  const gated = r.provider === "local" && isGated(r.target) && !!CFG.oblitToken;
  return sendJson(res, 200, {
    input: p.model || "", project: p.project || "", provider: r.provider, sentModel: sent, reason: r.reason || "",
    blocked: !!r.blocked, why: r.why, gated,
    base: r.base || (r.provider === "local" ? CFG.bases.local : r.provider === "claudecode" ? CFG.bases.claudecode : r.provider === "crazyrouter" ? CFG.bases.crazyrouter : ""),
  });
}

module.exports = { health, catalogs, harvestedLimits, crazyrouterStatus, crazyrouterTest, testCall, resolveTrace };
