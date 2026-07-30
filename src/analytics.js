// Consumption analytics: the three read-only rollups behind the panel's Usage tab and its charts.
//
// Split out of admin.js, which had grown to a 1179-line file whose handleAdminApi was a single
// ~900-line function. These three are the largest block in it that touches nothing else: no auth,
// no CFG mutation, no upstream call — just SELECTs over `calls` reduced into shapes the panel
// draws. Everything here is a GET, so nothing in this file can change state.
//
// Each handler keeps the exact signature the dispatcher calls it with, and the dispatcher keeps the
// auth gate — moving a route out must never move the lock that guards it.
const url = require("node:url");
const C = require("./config");
const { CFG } = C;
const { dbUp, dbRow, dbRows } = require("./db");
const { sendJson } = require("./http");
const { parseConsumer, consumerEntry } = require("./identity");
const { priceMap, costUsd, modelTier, isPremiumModel, listCostUsd } = require("./pricing");
const { limitFor, projectUsage } = require("./routing");

// ── consumption rollups: kind → owner → consumer → job, plus account×kind ──
// Grouping happens in JS, not SQL: the registry lives in CFG, and a 26-row group-by is cheaper to
// ship whole than to join against a config file.
async function usageRollup(req, res) {
  if (!dbUp()) return sendJson(res, 200, { dbReady: false });
  const q = url.parse(req.url, true).query;
  const WIN = { "1h": 36e5, "24h": 864e5, "7d": 6048e5, "30d": 2592e6 };
  const win = WIN[q.win] ? q.win : "24h";
  const since = Date.now() - WIN[win];
  // `billable` is what actually drains a Max account: a cache READ costs ~0.1x and barely moves the
  // 5h/7d window, so raw total_tokens ranks the wrong consumer first. Measured 2026-07-29: wmac was
  // the fleet's largest by raw tokens (78.2M / $394 list) and 6x SMALLER than a classifier bot on
  // this axis (2.8M, 96% cached). routing.js already quotas on exactly this expression.
  const rows = await dbRows(
    `SELECT project, split_part(key_label, ':', 2) AS acct, provider,
       COUNT(*)::int AS calls, COALESCE(SUM(total_tokens),0)::bigint AS tokens,
       COALESCE(SUM(GREATEST(total_tokens - cache_read, 0)),0)::bigint AS billable,
       COALESCE(SUM(cache_read),0)::bigint AS cached,
       COUNT(*) FILTER (WHERE status >= 400)::int AS errors
     FROM calls WHERE ts >= $1 AND project IS NOT NULL AND project <> '' GROUP BY 1,2,3`, [since]);
  const reg = CFG.consumers || {};
  const add = (m, k, r) => {
    const e = m.get(k) || { calls: 0, tokens: 0, billable: 0, cached: 0, errors: 0 };
    e.calls += r.calls; e.tokens += Number(r.tokens); e.errors += r.errors;
    e.billable += Number(r.billable); e.cached += Number(r.cached); m.set(k, e);
  };
  const byKind = new Map(), byOwner = new Map(), byConsumer = new Map(), byAcctKind = new Map();
  const jobsOf = new Map();
  for (const r of rows) {
    const { consumer, job } = parseConsumer(r.project);
    const e = reg[consumer];
    // An unregistered consumer is its own bucket. Folding it into "app" would be a guess, and the
    // whole point of the registry is that we stop guessing.
    const kind = e ? e.kind : "unregistered";
    add(byKind, kind, r);
    if (kind === "dev" && e.owner) add(byOwner, e.owner, r);
    add(byConsumer, consumer, r);
    if (r.acct) add(byAcctKind, `${r.acct}|${kind}`, r);
    if (job) { if (!jobsOf.has(consumer)) jobsOf.set(consumer, new Map()); add(jobsOf.get(consumer), job, r); }
  }
  // Ordered by BILLABLE, not raw tokens — see the query comment. Ranking a mostly-cached consumer
  // first is how "who is burning the pool" gets answered with the wrong name.
  const out = (m) => [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.billable - a.billable);
  return sendJson(res, 200, {
    dbReady: true, win, since,
    byKind: out(byKind), byOwner: out(byOwner),
    byConsumer: out(byConsumer).map((c) => ({
      ...c, kind: reg[c.key] ? reg[c.key].kind : "unregistered",
      owner: reg[c.key] && reg[c.key].owner || null,
      jobs: jobsOf.has(c.key) ? out(jobsOf.get(c.key)) : [],
    })),
    byAccountKind: out(byAcctKind).map((r) => { const [account, kind] = r.key.split("|"); return { account, kind, calls: r.calls, tokens: r.tokens, billable: r.billable, cached: r.cached, errors: r.errors }; }),
  });
}

// ── time-series history (tokens / calls / errors over time, grouped) ──
// ?window=…&by=provider|project|model. Buckets auto-sized to ~60 points across the
// window. Returns top series by total tokens (rest folded into "other").
async function seriesHistory(req, res) {
  if (!dbUp()) return sendJson(res, 200, { dbReady: false });
  try {
    const q = url.parse(req.url, true).query;
    const WINDOWS = { "15m": 900000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
    const winKey = (q.window in WINDOWS || q.window === "all") ? q.window : "24h";
    const by = ["provider", "project", "consumer", "model", "owner"].includes(q.by) ? q.by : "provider";
    // consumer folds jobs: `promopilot:generatetext` and `promopilot:l1_metadata` chart as one
    // series, so one busy consumer's jobs don't eat three of the top-8 series slots.
    // `owner` groups the same column and then maps consumer → the person who owns it, in JS: the
    // registry lives in CFG, not in Postgres, so there is nothing to join against.
    const groupCol = by === "provider" ? "provider" : by === "model" ? "req_model"
      : (by === "consumer" || by === "owner") ? "split_part(COALESCE(NULLIF(project,''),'(none)'), ':', 1)"
      : "COALESCE(NULLIF(project,''),'(none)')";
    const oldestRow = await dbRow("SELECT MIN(ts) AS t FROM calls");
    const oldest = (oldestRow && oldestRow.t) || Date.now();
    const span = winKey === "all" ? Math.max(60000, Date.now() - oldest) : WINDOWS[winKey];
    const since = winKey === "all" ? oldest : Date.now() - span;
    // bucket width: aim for ~60 buckets, snapped to a sane floor of 1 minute.
    // bucketMs is derived here, never caller-supplied, so interpolating it is not an injection path.
    const bucketMs = Math.max(60000, Math.round(span / 60 / 60000) * 60000);
    let rows = await dbRows(`SELECT (ts/${bucketMs}) AS b, ${groupCol} AS g,
      COUNT(*)::int AS n, COALESCE(SUM(total_tokens),0) AS tok,
      COALESCE(SUM(GREATEST(total_tokens - cache_read, 0)),0) AS bil,
      COUNT(*) FILTER (WHERE status>=400)::int AS err
      FROM calls WHERE ts >= $1 GROUP BY b, g`, [since]);
    // by=owner keeps ONLY traffic that belongs to a person — a dev-kind consumer with an owner.
    // Folding apps into one "(not a person)" series was the other option and it makes the chart
    // useless: autonoma alone runs ~10x every developer combined, so every human is a sliver at the
    // bottom of the stack. What is dropped is reported as `excluded` instead of vanishing.
    let excluded = null;
    if (by === "owner") {
      const reg = CFG.consumers || {};
      excluded = { calls: 0, tokens: 0 };
      rows = rows.filter((r) => {
        const e = reg[r.g];
        const own = e && e.kind === "dev" ? e.owner : null;
        if (!own) { excluded.calls += r.n; excluded.tokens += Number(r.tok); return false; }
        r.g = own; return true;
      });
    }
    // top-8 series by total tokens; everything else → "other". by=owner ranks on BILLABLE instead,
    // for the same reason usageRollup does — and because series order IS colour order: rank a person
    // 1st here on raw tokens while the Developers card ranks them 2nd on billable, and the same
    // human is blue in one card and green in the other, on the same screen.
    const rank = (r) => (by === "owner" ? Number(r.bil) : r.tok);
    const totals = {}; for (const r of rows) totals[r.g] = (totals[r.g] || 0) + rank(r);
    const top = Object.entries(totals).sort((a, b2) => b2[1] - a[1]).slice(0, 8).map(([k]) => k);
    const topSet = new Set(top); const hasOther = Object.keys(totals).length > top.length;
    const series = hasOther ? [...top, "other"] : top;
    const points = new Map(); // bucketStart -> {t, tok:{}, bil:{}, n:{}, totalTok, totalN, totalErr}
    for (const r of rows) {
      const t = r.b * bucketMs;
      let p = points.get(t);
      if (!p) { p = { t, tok: {}, bil: {}, n: {}, totalTok: 0, totalN: 0, totalErr: 0 }; points.set(t, p); }
      const key = topSet.has(r.g) ? r.g : "other";
      p.tok[key] = (p.tok[key] || 0) + r.tok; p.n[key] = (p.n[key] || 0) + r.n;
      p.bil[key] = (p.bil[key] || 0) + Number(r.bil);
      p.totalTok += r.tok; p.totalN += r.n; p.totalErr += r.err;
    }
    const out = [...points.values()].sort((a, b2) => a.t - b2.t);
    return sendJson(res, 200, { dbReady: true, window: winKey, by, bucketMs, since, series, points: out, excluded });
  } catch (e) { return sendJson(res, 500, { error: e.message }); }
}

async function statsSummary(req, res) {
  if (!dbUp()) return sendJson(res, 200, { dbReady: false });
  try {
    const q = url.parse(req.url, true).query;
    // time window: '15m','1h','6h','24h','7d','30d' or 'all'. Default 24h.
    const WINDOWS = { "15m": 900000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
    const winKey = (q.window in WINDOWS || q.window === "all") ? q.window : "24h";
    const since = winKey === "all" ? 0 : Date.now() - WINDOWS[winKey];
    const W = "ts >= $1"; const P = [since];
    // One scan for the window scalars instead of six. Postgres counts `FILTER (WHERE …)` in the
    // same pass, and this table is now big enough that six separate seq scans is the slow path.
    const agg = await dbRow(`SELECT
        COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE status >= 400)::int AS errors,
        COUNT(*) FILTER (WHERE error LIKE 'json_validation_failed%')::int AS json_fails,
        COALESCE(SUM(total_tokens),0) AS tokens,
        COALESCE(SUM(prompt_tokens),0) AS ptok,
        COALESCE(SUM(completion_tokens),0) AS ctok,
        COALESCE(SUM(cache_read),0) AS cache_read,
        COALESCE(SUM(cache_write),0) AS cache_write
      FROM calls WHERE ${W}`, P) || {};
    // WHY the failures happened, not just how many. An error RATE tells an operator that something
    // is wrong and nothing about what — on 2026-07-28 the image path went to 24% errors and the
    // reason ("LoRAs are an SDXL feature; this host serves SANA-Sprint") was only ever visible by
    // opening an individual call row. One caller sending one now-unsupported field looks identical
    // to a dead upstream from the Health tab, and they need opposite responses.
    //
    // Grouped on the first 120 chars so the same failure with different ids collapses into one line,
    // and capped at 3 — this is a pointer at the call log, not a replacement for it.
    const topErrors = await dbRows(`SELECT LEFT(error, 120) AS reason, COUNT(*)::int AS n
      FROM calls WHERE ${W} AND status >= 400 AND error IS NOT NULL AND error <> ''
      GROUP BY 1 ORDER BY n DESC LIMIT 3`, P);
    const totalRow = await dbRow("SELECT COUNT(*)::int AS n FROM calls");
    const byProvider = await dbRows(`SELECT provider, COUNT(*)::int AS n, COALESCE(SUM(total_tokens),0) AS tok,
      ROUND(AVG(duration_ms)) AS avg_ms, COUNT(*) FILTER (WHERE status>=400)::int AS errors
      FROM calls WHERE ${W} GROUP BY provider ORDER BY n DESC`, P);
    const byKey = await dbRows(`SELECT key_label, COUNT(*)::int AS n FROM calls WHERE ${W} GROUP BY key_label ORDER BY n DESC`, P);
    // By client (user-agent) — surfaces who's calling. thinkers = calls that sent extended thinking
    // or a reasoning_effort, so you can spot reasoning traffic per client at a glance.
    // string_agg replaces SQLite's GROUP_CONCAT, which does not exist here.
    const byClient = await dbRows(`SELECT COALESCE(NULLIF(ua,''),'(none)') AS ua, COUNT(*)::int AS n,
      COALESCE(SUM(total_tokens),0) AS tok, MAX(ts) AS last, COUNT(DISTINCT ip)::int AS ips,
      COUNT(*) FILTER (WHERE effort IS NOT NULL OR thinking_tokens > 0)::int AS thinkers,
      string_agg(DISTINCT provider, ',') AS providers
      FROM calls WHERE ${W} GROUP BY 1 ORDER BY n DESC LIMIT 40`, P);
    // One row per (requested model, ACTUAL provider) — and expose what was actually served.
    // Grouping by req_model alone and collapsing with MAX(provider) MISATTRIBUTED every rewrite:
    // redbut asks for `gemini-2.5-flash-lite` but a projectRoute rewrites it to `claude-haiku-4-5`
    // on the (free) subscription — yet MAX(provider) labeled all ~90k of those calls `crazyrouter`
    // (the paid provider, lexicographically largest), reading like a large cloud bill that never
    // happened. Splitting on provider keeps requested-vs-served honest; `sent_models` shows what
    // actually ran so a rewrite is visible instead of hidden behind the requested id.
    const byModel = await dbRows(`SELECT req_model, provider,
      string_agg(DISTINCT sent_model, ',') AS sent_models, COUNT(*)::int AS n,
      COALESCE(SUM(total_tokens),0) AS tok,
      COALESCE(SUM(prompt_tokens),0) AS ptok, COALESCE(SUM(completion_tokens),0) AS ctok,
      COALESCE(SUM(cache_read),0) AS cr, COALESCE(SUM(cache_write),0) AS cw, ROUND(AVG(duration_ms)) AS avg_ms
      FROM calls WHERE ${W} GROUP BY req_model, provider ORDER BY tok DESC LIMIT 60`, P);
    const byProject = await dbRows(`SELECT COALESCE(NULLIF(project,''),'(none)') AS project, COUNT(*)::int AS n,
      COALESCE(SUM(total_tokens),0) AS tok, COALESCE(SUM(prompt_tokens),0) AS ptok, COALESCE(SUM(completion_tokens),0) AS ctok,
      COALESCE(SUM(cache_read),0) AS cr, COALESCE(SUM(cache_write),0) AS cw,
      ROUND(AVG(duration_ms)) AS avg_ms, COUNT(*) FILTER (WHERE status>=400)::int AS errors,
      MAX(ts) AS last, COUNT(DISTINCT req_model)::int AS models, string_agg(DISTINCT provider, ',') AS providers
      FROM calls WHERE ${W} GROUP BY 1 ORDER BY tok DESC LIMIT 60`, P);
    // Cost estimate: group by (project, sent_model, provider) to price each cohort, then fold into project/model.
    const prices = priceMap();
    const costRows = await dbRows(`SELECT COALESCE(NULLIF(project,''),'(none)') AS project, req_model, sent_model, provider,
      COALESCE(SUM(total_tokens),0) AS tok,
      COALESCE(SUM(prompt_tokens),0) AS ptok, COALESCE(SUM(completion_tokens),0) AS ctok
      FROM calls WHERE ${W} GROUP BY 1, sent_model, req_model, provider`, P);
    let windowCost = 0; const costByProject = {}, costByModel = {};
    // WHICH MODELS each project ran, and how much of its spend went to each. byProject only ever
    // carried a COUNT of distinct models ("8 models") — which never answers "is this app on opus".
    // Folded off the cost query rather than a new group-by: it is already grouped per
    // (project, model) and already scanned the window. Keyed on req_model, the same id byModel and
    // every model reading on the panel/board uses — `sent_models` there is where a rewrite shows.
    const modelsByProject = {};
    for (const r of costRows) {
      const m = modelsByProject[r.project] || (modelsByProject[r.project] = {});
      m[r.req_model || "(none)"] = (m[r.req_model || "(none)"] || 0) + Number(r.tok || 0);
    }
    for (const r of costRows) {
      const c = costUsd(prices, r.sent_model, r.provider, r.ptok, r.ctok);
      windowCost += c;
      costByProject[r.project] = (costByProject[r.project] || 0) + c;
      // Key cost by (req_model, provider) — byModel is now split on provider, so folding on
      // req_model alone would smear a rewrite's (zero) subscription cost across the paid row.
      const mk = r.req_model + " " + r.provider;
      costByModel[mk] = (costByModel[mk] || 0) + c;
    }
    for (const r of byProject) {
      r.usd = +(costByProject[r.project] || 0).toFixed(4);
      // Top 4 by tokens: enough for a table cell, and the tail is already counted in `models`.
      r.topModels = Object.entries(modelsByProject[r.project] || {})
        .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m, tok]) => ({ m, tok }));
      // attach the effective limit + live usage% over the limit's own window (not the stats window)
      const lim = r.project && r.project !== "(none)" ? limitFor(r.project) : null;
      if (lim) {
        const u = await projectUsage(r.project, C.WINDOW_MS[lim.window] || C.WINDOW_MS["24h"]);
        const pt = lim.tokens > 0 ? u.tokens / lim.tokens : 0, pc = lim.calls > 0 ? u.calls / lim.calls : 0;
        r.limit = { window: lim.window, tokens: lim.tokens, calls: lim.calls, hard: lim.hard, warnPct: lim.warnPct, slowPct: lim.slowPct };
        r.limitUsed = { tokens: u.tokens, calls: u.calls };
        r.limitPct = +(Math.max(pt, pc) * 100).toFixed(1);
      }
    }
    byModel.forEach((r) => {
      r.usd = +(costByModel[r.req_model + " " + r.provider] || 0).toFixed(4);
      // Classify by what was ACTUALLY served (sent_model), not the requested id — a rewrite
      // (redbut asks gemini, gets haiku) must read as its real tier. `list_usd` is the notional
      // Anthropic list cost of this claudecode traffic (never billed — the sub is flat — but it
      // makes premium spend visible where `usd` is 0).
      const served = String(r.sent_models || "").split(",")[0] || r.req_model;
      r.tier = modelTier(served);
      r.premium = isPremiumModel(served);
      // null (not 0) when the served id has no price — see listCostUsd. A non-claudecode row is a
      // genuine 0: the sub is flat and local is free, so "no list cost" is the true answer there.
      const lc = r.provider === "claudecode" ? listCostUsd(served, r.ptok, r.ctok) : 0;
      r.list_usd = lc == null ? null : +lc.toFixed(4);
    });
    // Premium-usage warning: which PROJECTS (esp. apps) ran an opus/fable model in this window, and
    // how much. Devs choosing opus is expected; an app on premium is the cost signal worth surfacing.
    // Built from the served model so a rewrite is judged by what actually ran.
    const premRows = await dbRows(`SELECT COALESCE(NULLIF(project,''),'(none)') AS project, sent_model,
      COUNT(*)::int AS n, COALESCE(SUM(total_tokens),0) AS tok, COALESCE(SUM(prompt_tokens),0) AS ptok,
      COALESCE(SUM(completion_tokens),0) AS ctok, MAX(ts) AS last
      FROM calls WHERE ${W} AND provider='claudecode' AND sent_model IS NOT NULL
      GROUP BY 1, sent_model ORDER BY tok DESC`, P);
    const premiumUsage = [];
    for (const r of premRows) {
      if (!isPremiumModel(r.sent_model)) continue;
      const reg = r.project && r.project !== "(none)" ? consumerEntry(r.project) : null;
      const premListUsd = listCostUsd(r.sent_model, r.ptok, r.ctok);
      premiumUsage.push({ project: r.project, kind: reg ? reg.kind : null, model: r.sent_model,
        tier: modelTier(r.sent_model), calls: r.n, tokens: r.tok,
        list_usd: premListUsd == null ? null : +premListUsd.toFixed(4), last: r.last });
    }
    // Unattributed image traffic. /v1/images/* is dispatched in server.js BEFORE the auth gate and is
    // absent from `isInference`, so none of the usual controls reach it: no key is required,
    // throttleDelay("") is 0 and limitFor("") is null. It bills GPU seconds to nobody. Enforcing any
    // of that would 401 whoever is calling it today, which is an operator's decision — so the panel
    // at least says out loud that it is happening, beside the other things worth knowing on Health.
    const unattrImg = await dbRow(
      `SELECT COUNT(*)::int AS n, COUNT(DISTINCT ip)::int AS ips FROM calls
       WHERE ${W} AND provider = 'images' AND (project IS NULL OR project = '')`, P);
    const oldestRow = await dbRow("SELECT MIN(ts) AS t FROM calls");
    return sendJson(res, 200, { dbReady: true, window: winKey, total: totalRow ? totalRow.n : 0,
      windowCalls: agg.calls || 0, windowErrors: agg.errors || 0, windowTokens: agg.tokens || 0,
      windowPromptTokens: agg.ptok || 0, windowCompletionTokens: agg.ctok || 0, windowJsonFails: agg.json_fails || 0,
      windowCacheRead: agg.cache_read || 0, windowCacheWrite: agg.cache_write || 0,
      windowCost: +windowCost.toFixed(4),
      pricedProviders: ["crazyrouter"], byProvider, byKey, byClient, byModel, byProject, premiumUsage,
      unattributedImages: unattrImg ? { calls: unattrImg.n || 0, ips: unattrImg.ips || 0 } : null,
      topErrors: (topErrors || []).map((r) => ({ reason: r.reason, calls: r.n })),
      oldest: oldestRow ? oldestRow.t : null, retain: CFG.logging.retain });
  } catch (e) { return sendJson(res, 500, { error: e.message }); }
}


module.exports = { usageRollup, seriesHistory, statsSummary };
