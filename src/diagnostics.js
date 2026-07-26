// Diagnostics: is each provider reachable, what does it advertise, what would this model id do, and
// what does one real call cost. Everything here is a question ABOUT the router rather than a use of
// it — none of it routes traffic, mutates config or touches the registry.
//
// Split out of admin.js on 2026-07-26 (583 lines, over budget). The dependency runs one way,
// diagnostics -> {config,db,http,routing,claudecode}, and none of those import this, so reaching
// back for sendJson/resolveRoute cannot cycle. The auth gate stays in the dispatcher, as with every
// other route module: a route may move, the lock that guards it may not.
const { CFG } = require("./config");
const { dbRows } = require("./db");
const { sendJson, readBody, readJson, mask } = require("./http");
const { resolveRoute, isGated } = require("./routing");
const { upstreamCatalogs, localModelEntries } = require("./claudecode");

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
async function adminTest(model, prompt, maxTokens) {
  const route = resolveRoute(model);
  const headers = { "content-type": "application/json" };
  if (route.provider === "crazyrouter") headers.authorization = `Bearer ${CFG.crazyrouterKey}`;
  else if (route.provider === "local" && isGated(route.target) && CFG.oblitToken) headers.authorization = `Bearer ${CFG.oblitToken}`;
  const sendModel = route.rewriteModel || model;
  const body = { model: sendModel, messages: [{ role: "user", content: prompt || "Reply with a short greeting." }], max_tokens: maxTokens || 256, stream: false };
  const t0 = Date.now();
  try {
    const r = await fetch(route.base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    const m = j && j.choices && j.choices[0] && j.choices[0].message;
    const content = (m && (m.content || m.reasoning_content)) || null;
    return { ok: r.ok, status: r.status, provider: route.provider, sentModel: sendModel, ms: Date.now() - t0, content, raw: content == null ? text.slice(0, 2000) : undefined };
  } catch (e) { return { ok: false, status: 0, provider: route.provider, sentModel: sendModel, ms: Date.now() - t0, error: e.message }; }
}

async function health(req, res) {
  const [local, crazyrouter] = await Promise.all([
    probe(CFG.bases.local), probe(CFG.bases.crazyrouter, CFG.crazyrouterKey),
  ]);
  const accounts = (CFG.claudecodeAccountPool || []).length;
  const claudecode = {
    up: accounts > 0, status: accounts > 0 ? 200 : 0, ms: 0,
    count: (CFG.claudecodeModels || []).length, accounts,
    note: accounts > 0 ? undefined : "no accounts in the pool",
  };
  return sendJson(res, 200, { local, crazyrouter, claudecode });
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
  const body = await readBody(req); let key = "";
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
