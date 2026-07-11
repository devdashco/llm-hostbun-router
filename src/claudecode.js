// The claudecode provider's model catalog: the ids the router will route to Anthropic. These are
// subscription (Claude Max) logins, so the pool serves whatever Claude Code serves — the router does
// not second-guess per-account model availability (a 429 is a subscription usage window, not a
// capability, and treating it as one only misled the panel).
const TR = require("../translate");
const { CFG, persistConfig, IMAGE_MODEL_IDS, CLAUDECODE_MODEL_SEED, CLAUDECODE_MODEL_ALIASES, CLAUDECODE_MODEL_REFRESH_MS } = require("./config");
const { ORG_OF_ACCOUNT, recordLimits } = require("./db");
const { localTarget } = require("./routing");

function localModelEntries() {
  const ids = new Set();
  const out = [];
  for (const [alias, target] of Object.entries(CFG.localMap)) {
    for (const id of [alias, target]) {
      if (!ids.has(id)) { ids.add(id); out.push({ id, object: "model", owned_by: "local" }); }
    }
  }
  return out;
}

// Fetch the crazyrouter catalog (best-effort). claudecode ids are static (claude-*), so they are
// listed from config rather than probed — probing would spend a real token on a real account.
async function upstreamCatalogs() {
  let crazyrouter = [];
  try {
    const c = await fetch(CFG.bases.crazyrouter + "/v1/models", { headers: { authorization: `Bearer ${CFG.crazyrouterKey}` }, signal: AbortSignal.timeout(8000) });
    const cj = await c.json();
    crazyrouter = ((cj && cj.data) || []).map((m) => ({ ...m, owned_by: "crazyrouter" }));
  } catch { /* crazyrouter down — skip */ }
  // Ids come from Anthropic (refreshClaudecodeModels), floored by CLAUDECODE_MODEL_SEED.
  const meta = new Map((claudecodeCatalog.models || []).map((m) => [m.id, m]));
  const claudecode = (CFG.claudecodeModels || []).map((id) => {
    const m = meta.get(id);
    return { id, object: "model", owned_by: "claudecode", ...(m && m.display_name ? { display_name: m.display_name } : {}) };
  });
  return { claudecode, crazyrouter };
}


// ── claudecode catalog, straight from Anthropic ──────────────────────────────
// `claudecodeModels` used to be a hand-typed list in config.json. It drifted: Anthropic served 9
// ids while we advertised 5. Nothing broke loudly — the four missing ids just 400'd as "not
// routable", which reads like a caller typo. So we ask the source instead.
//
// The catalog is PER-ACCOUNT and PAGINATED, and both facts cost us ids.
//
//   per-account: `philip` lists claude-opus-4-1; `cmejl3` 404s it. Reading one account's view and
//                calling it "the catalog" silently drops every model the other orgs can see.
//   paginated:   /v1/models answers `has_more` + `last_id`. One page is not the list.
//
// So: sweep EVERY account, follow EVERY page, union the lot. Each model records which accounts
// offer it (`accounts`), so an id only one org can see is still surfaced.
//
// A failed sweep is a no-op, never a downgrade: CFG keeps whatever it already had. A partial sweep
// (some accounts erroring) still unions what it did get, floored by CLAUDECODE_MODEL_SEED.
let claudecodeCatalog = { source: "seed", ts: 0, accounts: [], failed: [], models: [], error: null };

async function fetchAccountModels(acct) {
  const out = [];
  let after = null;
  for (let page = 0; page < 10; page++) {   // 10×100 ids is far past any real catalog; no infinite loop
    const qs = new URLSearchParams({ limit: "100", ...(after ? { after_id: after } : {}) });
    const r = await fetch(`${CFG.bases.claudecode}/v1/models?${qs}`,
      { headers: TR.anthropicHeaders(acct.token), signal: AbortSignal.timeout(8000) });
    // The catalog sweep is the only request we make on behalf of an account with no traffic, so it
    // is where a cold-started router learns which opaque org-id belongs to which of our logins.
    // Without this the accounts view shows `limits: null` until the account happens to serve a call.
    const org = r.headers.get("anthropic-organization-id");
    if (org) ORG_OF_ACCOUNT.set(acct.name, org);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const page_ = (j.data || []).filter((m) => m && typeof m.id === "string" && m.id.trim());
    out.push(...page_);
    if (!j.has_more || !page_.length) break;
    after = j.last_id || page_[page_.length - 1].id;
  }
  return out;
}

async function fetchAnthropicModels() {
  const pool = CFG.claudecodeAccountPool || [];
  const settled = await Promise.all(pool.map(async (a) => {
    try { return { account: a.name, models: await fetchAccountModels(a) }; }
    catch (e) { return { account: a.name, error: e.message }; }
  }));
  const ok = settled.filter((s) => s.models && s.models.length);
  if (!ok.length) return null;

  // Union by id; remember every account that offers each one.
  const byId = new Map();
  for (const { account, models } of ok) {
    for (const m of models) {
      const prev = byId.get(m.id);
      if (prev) prev.accounts.push(account);
      else byId.set(m.id, { ...m, accounts: [account] });
    }
  }
  return {
    models: [...byId.values()],
    accounts: ok.map((s) => s.account),
    failed: settled.filter((s) => s.error).map((s) => ({ account: s.account, error: s.error })),
  };
}

async function refreshClaudecodeModels(why) {
  const hit = await fetchAnthropicModels();
  if (!hit) {
    claudecodeCatalog = { ...claudecodeCatalog, error: "no account could read api.anthropic.com/v1/models" };
    console.warn(`[models] claudecode refresh (${why}) FAILED — keeping ${CFG.claudecodeModels.length} known ids`);
    return claudecodeCatalog;
  }
  // Anthropic is authoritative, but never let a partial sweep shrink us below the seed.
  const live = hit.models.map((m) => m.id);
  // Aliases are appended after the live catalog: Anthropic serves them but never lists them, so a
  // sweep alone would drop `claude-haiku-4-5` — the id most callers send.
  CFG.claudecodeModels = [...new Set([...live, ...CLAUDECODE_MODEL_SEED, ...CLAUDECODE_MODEL_ALIASES])];
  claudecodeCatalog = { source: "anthropic", ts: Date.now(), accounts: hit.accounts, failed: hit.failed, models: hit.models, error: null };
  const fail = hit.failed.length ? ` (${hit.failed.length} account(s) unreadable)` : "";
  console.log(`[models] claudecode refresh (${why}) across ${hit.accounts.length} account(s)${fail}: ${live.length} live → advertising ${CFG.claudecodeModels.length}`);
  return claudecodeCatalog;
}

async function mergedModels(res) {
  const local = localModelEntries();
  const { claudecode, crazyrouter } = await upstreamCatalogs();
  const images = IMAGE_MODEL_IDS.map((id) => ({ id, object: "model", owned_by: "pbox" }));
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify({ object: "list", data: [...local, ...images, ...claudecode, ...crazyrouter] }));
}

// Actively read ONE account's live usage window. A single cheap haiku ping (max_tokens:1) so the
// `anthropic-ratelimit-unified-*` headers come back fresh, then fed through the same recordLimits()
// the passive harvest uses — so the acct_limits row the Accounts bars read is updated on demand.
//
// This is NOT the per-model probe that was removed: it pings ONE model, ONCE, to read the 5h/7d
// window (the real, honest number a subscription reports), never to guess model capability. The
// passive harvest only learns from real traffic, so an idle account's bars freeze at their last
// reading — a manual refresh (e.g. after Anthropic refunds a window) is the only way to see truth
// without waiting for the account to serve a call.
async function refreshAccountLimits(acct) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${CFG.bases.claudecode}/v1/messages`, {
      method: "POST", headers: TR.anthropicHeaders(acct.token), signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    const org = r.headers.get("anthropic-organization-id");
    if (org) ORG_OF_ACCOUNT.set(acct.name, org);
    recordLimits(r.headers, null, "claude-haiku-4-5", acct.name);   // persists to acct_limits (fire-and-forget)
    const h = (k) => r.headers.get("anthropic-ratelimit-unified-" + k);
    const num = (v) => (v == null || v === "" ? null : Number(v));
    const has = h("5h-utilization") != null || h("7d-utilization") != null;
    // No headers means no reading. WHY matters and differs sharply: a 429 is a spent window (resets),
    // but a 403 permission_error ("OAuth authentication is currently not allowed for this
    // organization") is a dead account — the login itself has been disabled, and no window reset
    // fixes it. Read the error body so the panel can tell them apart.
    let errType = null, errMsg = null;
    if (!has && !r.ok) { try { const b = (await r.json()).error || {}; errType = b.type || null; errMsg = b.message || null; } catch {} }
    return {
      account: acct.name, org: org || null, status: r.status, checkedAt: Date.now(), ms: Date.now() - t0,
      errType, errMsg,
      reading: has ? {
        unified: h("status") || null,
        u5: num(h("5h-utilization")), s5: h("5h-status") || null, reset5: num(h("5h-reset")),
        u7: num(h("7d-utilization")), s7: h("7d-status") || null, reset7: num(h("7d-reset")),
      } : null,
    };
  } catch (e) { return { account: acct.name, error: e.message, checkedAt: Date.now(), ms: Date.now() - t0, reading: null }; }
}

module.exports = {
  localModelEntries, upstreamCatalogs, mergedModels, fetchAccountModels, fetchAnthropicModels,
  refreshClaudecodeModels, refreshAccountLimits, claudecodeCatalog: () => claudecodeCatalog,
  CLAUDECODE_MODEL_REFRESH_MS,
};
