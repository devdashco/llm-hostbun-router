// nas-shipper — archive the router's full call log (each call + full chat) into
// the NAS Postgres, durably and unpruned.
//
// WHY: the router keeps every call WITH full req/resp content in /data/calls.db,
// but prunes to logging.retain rows (~50k ≈ 1 day). This ships each row to
// claudebox.calls on the NAS before it's pruned, so nothing is ever lost.
//
// SOURCE = the router's HTTPS export endpoint (GET /admin/api/export?after=&limit=),
//          cookie-gated by the admin password. Full req_content/resp_content.
// TARGET = NAS Postgres, schema claudebox (migration 0001_claudebox_calls_archive).
// CURSOR = max(src_id) already in NAS. Pages id > cursor ascending, idempotent
//          via ON CONFLICT (src_id) DO NOTHING.
//
// WHERE TO RUN: any host that can reach BOTH the router (HTTPS, public) and the
// NAS Postgres. The NAS is only reachable from the LAN, so run this on the LAN
// (deploy as a Coolify app on pbox). It pulls the log over HTTPS, so it does NOT
// need the router's SQLite file mounted.
//
// ENV:
//   ROUTER_URL     e.g. https://llm.hostbun.cc          (required)
//   ADMIN_PASSWORD router admin password                (required)
//   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE           NAS Postgres conn (LAN)
//   BATCH          rows per export page (<=2000)         (default 500)
//   LOOP           "1" = run forever every INTERVAL      (default one-shot)
//   INTERVAL       seconds between rounds when LOOP       (default 60)
//
// deps: pg  (npm i pg).

import pg from "pg";

const ROUTER_URL = (process.env.ROUTER_URL || "https://llm.hostbun.cc").replace(/\/$/, "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ddash";
const BATCH = Math.min(parseInt(process.env.BATCH || "500", 10), 2000);
const LOOP = process.env.LOOP === "1";
const INTERVAL = parseInt(process.env.INTERVAL || "60", 10) * 1000;

let cookie = "";
async function login() {
  const r = await fetch(`${ROUTER_URL}/admin/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  if (!r.ok) throw new Error(`admin login failed: ${r.status}`);
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error("no session cookie");
}

async function fetchExport(after) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!cookie) await login();
    const r = await fetch(`${ROUTER_URL}/admin/api/export?after=${after}&limit=${BATCH}`,
      { headers: { cookie } });
    if (r.status === 401) { cookie = ""; continue; }        // re-login once
    if (!r.ok) throw new Error(`export ${r.status}`);
    return r.json();
  }
  throw new Error("export: auth failed twice");
}

const NCOL = 21;
async function insert(pool, rows) {
  const params = [];
  const tuples = rows.map((r, i) => {
    const b = i * NCOL;
    params.push(
      Number(r.id), new Date(Number(r.ts)),
      r.ip, r.ua, r.method, r.path, r.req_model, r.lane, r.sent_model, r.key_label,
      null,                                       // account: NULL until claudebox emits X-CB-Account
      r.status == null ? null : Number(r.status),
      r.duration_ms == null ? null : Number(r.duration_ms),
      r.stream == null ? null : Number(r.stream),
      r.prompt_tokens == null ? null : Number(r.prompt_tokens),
      r.completion_tokens == null ? null : Number(r.completion_tokens),
      r.total_tokens == null ? null : Number(r.total_tokens),
      r.error, r.project, r.req_content, r.resp_content,
    );
    return `(${Array.from({ length: NCOL }, (_, k) => `$${b + k + 1}`).join(",")})`;
  });
  const sql =
    `INSERT INTO claudebox.calls
     (src_id,ts,ip,ua,method,path,req_model,lane,sent_model,key_label,account,
      status,duration_ms,stream,prompt_tokens,completion_tokens,total_tokens,
      error,project,req_content,resp_content)
     VALUES ${tuples.join(",")}
     ON CONFLICT (src_id) DO NOTHING`;
  return (await pool.query(sql, params)).rowCount;
}

async function round(pool) {
  const { rows: [{ cur }] } = await pool.query(
    "SELECT COALESCE(MAX(src_id),0)::bigint AS cur FROM claudebox.calls");
  let after = Number(cur), total = 0, ins = 0;
  for (;;) {
    const { rows } = await fetchExport(after);
    if (!rows.length) break;
    const pageIns = await insert(pool, rows);   // rows actually inserted this page
    ins += pageIns;
    after = Number(rows[rows.length - 1].id);
    total += rows.length;
    await pool.query(
      "UPDATE claudebox.ship_state SET last_src_id=$1, last_run_at=now(), rows_shipped=rows_shipped+$2 WHERE id=1",
      [after, pageIns]);
    if (rows.length < BATCH) break;
  }
  return { total, ins };
}

async function main() {
  const pool = new pg.Pool({ max: 2 });
  do {
    try {
      const { total, ins } = await round(pool);
      console.log(`[shipper] ${new Date().toISOString()} scanned ${total} new, inserted ${ins}`);
    } catch (e) { console.error(`[shipper] round error: ${e.message}`); }
    if (LOOP) await new Promise((r) => setTimeout(r, INTERVAL));
  } while (LOOP);
  await pool.end();
}

main().catch((e) => { console.error("[shipper] fatal", e); process.exit(1); });
