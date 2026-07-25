// The call log: the panel's Call log page and the cursor export behind it.
//
// Second block out of admin.js's handleAdminApi (see src/analytics.js for the first). These five
// are one subject — read the log, read one row, read the filter facets, page it out, clear it —
// and they share nothing with the rest of the control plane but the auth gate, which stays with
// the dispatcher.
//
// `clearCalls` is the only writer here, and the only one that takes `ip`: it is destructive, so it
// is logged with who asked.
const url = require("node:url");
const { CFG } = require("./config");
const DB = require("./db");
const { dbUp, dbRow, dbRows, FACET_CACHE } = DB;
const { sendJson } = require("./http");

  // ── call log ──
async function listCalls(req, res) {
  if (!dbUp()) return sendJson(res, 200, { rows: [], total: 0, dbReady: false });
  const q = url.parse(req.url, true).query;
  const where = [], params = [];
  const ph = (v) => { params.push(v); return `$${params.length}`; };   // positional, in push order
  if (q.provider) where.push(`provider = ${ph(String(q.provider))}`);
  if (q.model) where.push(`req_model = ${ph(String(q.model))}`);
  if (q.key) where.push(`key_label = ${ph(String(q.key))}`);
  if (q.project) {
    // A bare consumer name covers its jobs too (`promopilot` matches `promopilot:generatetext`),
    // mirroring how routing resolves. A value with a colon is an exact job path; a TRAILING colon
    // (`promopilot:`) is the consumer's job-less calls only — the stats drilldown needs all three.
    const pj = String(q.project).toLowerCase();
    if (pj === "(none)") where.push("(project IS NULL OR project = '')");
    else if (pj.endsWith(":")) where.push(`project = ${ph(pj.slice(0, -1))}`);
    else if (pj.includes(":")) where.push(`project = ${ph(pj)}`);
    else where.push(`(project = ${ph(pj)} OR project LIKE ${ph(pj + ":%")})`);
  }
  if (q.status === "error") where.push("status >= 400");
  else if (q.status === "ok") where.push("status < 400");
  else if (q.status) where.push(`status = ${ph(parseInt(q.status, 10))}`);
  if (q.since) where.push(`ts >= ${ph(parseInt(q.since, 10))}`);
  // Tri-state facets. "" = don't filter; the columns are nullable, so the negative
  // arm must spell out IS NULL or it silently drops every un-stamped row.
  if (q.effort === "(none)") where.push("(effort IS NULL OR effort = '')");
  else if (q.effort) where.push(`effort = ${ph(String(q.effort))}`);
  if (q.stream === "1") where.push("stream = true");
  else if (q.stream === "0") where.push("(stream IS NULL OR stream = false)");
  if (q.thinking === "1") where.push("thinking_tokens > 0");
  else if (q.thinking === "0") where.push("(thinking_tokens IS NULL OR thinking_tokens = 0)");
  if (q.tools === "1") where.push("tool_count > 0");
  else if (q.tools === "0") where.push("(tool_count IS NULL OR tool_count = 0)");
  if (q.cached === "1") where.push("cache_read > 0");
  else if (q.cached === "0") where.push("(cache_read IS NULL OR cache_read = 0)");
  if (q.client) where.push(`ua ILIKE ${ph("%" + String(q.client) + "%")}`);
  if (q.stop) where.push(`stop_reason = ${ph(String(q.stop))}`);
  if (q.minTok) where.push(`total_tokens >= ${ph(parseInt(q.minTok, 10))}`);
  if (q.minMs) where.push(`duration_ms >= ${ph(parseInt(q.minMs, 10))}`);
  // Live-tail cursor: only rows newer than what the client already holds. `total` then
  // means "new since afterId", not "matching overall" — the SPA adds it to its own count.
  if (q.afterId) where.push(`id > ${ph(parseInt(q.afterId, 10))}`);
  if (q.q) {
    const like = ph("%" + String(q.q) + "%");   // one placeholder, reused across the OR
    where.push(`(req_model ILIKE ${like} OR sent_model ILIKE ${like} OR ip ILIKE ${like}
      OR ua ILIKE ${like} OR req_content ILIKE ${like} OR resp_content ILIKE ${like})`);
  }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const limit = Math.min(parseInt(q.limit, 10) || 100, 500);
  const offset = parseInt(q.offset, 10) || 0;
  const totalRow = await dbRow(`SELECT COUNT(*)::int AS n FROM calls ${w}`, params);
  // List view: omit big content blobs; send short previews instead.
  const rows = await dbRows(`SELECT id,ts,ip,ua,method,path,req_model,provider,sent_model,key_label,status,duration_ms,stream,
    prompt_tokens,completion_tokens,total_tokens,error,project,effort,thinking_tokens,max_tokens,temperature,
    user_id,cache_read,cache_write,stop_reason,
    tool_count,mcp_tools,tool_servers,tools_kb,msg_count,system_kb,
    left(req_content,160) AS req_preview, left(resp_content,200) AS resp_preview
    FROM calls ${w} ORDER BY id DESC LIMIT ${ph(limit)} OFFSET ${ph(offset)}`, params);
  return sendJson(res, 200, { rows, total: totalRow ? totalRow.n : 0, limit, offset, dbReady: true });
}

// Distinct values behind the filter dropdowns. Five sequential scans over `calls`, so it is
// cached — the panel refetches it on every mount and the live tail must not pay for it.
async function callFacets(req, res) {
  if (!dbUp()) return sendJson(res, 200, { projects: [], models: [], keys: [], efforts: [], clients: [], stops: [] });
  if (FACET_CACHE.at && Date.now() - FACET_CACHE.at < 30000) return sendJson(res, 200, FACET_CACHE.val);
  const col = async (expr, extra = "") => (await dbRows(
    `SELECT ${expr} AS v, COUNT(*)::int AS n FROM calls WHERE ${expr} IS NOT NULL AND ${expr}::text <> '' ${extra}
     GROUP BY 1 ORDER BY n DESC LIMIT 60`)).map((r) => ({ v: String(r.v), n: r.n }));
  const val = {
    projects: await col("project"), models: await col("req_model"), keys: await col("key_label"),
    efforts: await col("effort"), stops: await col("stop_reason"),
    // UA strings are unbounded; the leading token is the client name and that is all we filter on.
    clients: await col("split_part(ua, '/', 1)"),
  };
  FACET_CACHE.at = Date.now(); FACET_CACHE.val = val;
  return sendJson(res, 200, val);
}

async function getCall(req, res) {
  if (!dbUp()) return sendJson(res, 404, { error: "no db" });
  const q = url.parse(req.url, true).query;
  const id = parseInt(q.id, 10);
  if (!id) return sendJson(res, 400, { error: "id required" });
  const row = await dbRow("SELECT * FROM calls WHERE id = $1", [id]);
  return row ? sendJson(res, 200, row) : sendJson(res, 404, { error: "not found" });
}

// (Removed 2026-07-09: the per-conversation view. It grouped the log by Claude session_id, which
// only ever existed for Claude Code traffic, and answered a question nobody asked. The columns it
// read — msg_count, tool_count, tools_kb, cache_read — are still recorded and still surfaced per
// call in the Calls tab. Consumption now rolls up by consumer, not by chat: see `usage`.)

// Full-content export. Cursor by id, ascending: page id>after until fewer than `limit` return.
// Returns FULL req_content/resp_content (unlike `calls`, which previews). SELECT * on purpose —
// an explicit column list silently drops whatever was added to the table since it was written.
async function exportCalls(req, res) {
  if (!dbUp()) return sendJson(res, 404, { error: "no db" });
  const q = url.parse(req.url, true).query;
  const after = parseInt(q.after, 10) || 0;
  const limit = Math.min(parseInt(q.limit, 10) || 500, 2000);
  const rows = await dbRows("SELECT * FROM calls WHERE id > $1 ORDER BY id ASC LIMIT $2", [after, limit]);
  const maxId = rows.length ? rows[rows.length - 1].id : after;
  return sendJson(res, 200, { rows, count: rows.length, after, maxId, limit });
}

async function clearCallLog(req, res, ip) {
  if (!dbUp()) return sendJson(res, 200, { ok: true, dbReady: false });
  try {
    await DB.clearCalls();
    console.log(`[admin] call log cleared ip=${ip}`);
    return sendJson(res, 200, { ok: true });
  } catch (e) { return sendJson(res, 500, { error: e.message }); }
}


module.exports = { listCalls, callFacets, getCall, exportCalls, clearCallLog };
