// nas-shipper — archive the router's full call log (each call + full chat) into
// the NAS Postgres, durably and unpruned.
//
// WHY: the router keeps every call WITH full req/resp content in /data/calls.db,
// but prunes to logging.retain rows (~50k ≈ 1 day). This ships each row to
// claudebox.calls on the NAS before it's pruned, so nothing is ever lost.
//
// SOURCE  = the router's SQLite (node:sqlite). Read-only.
// TARGET  = NAS Postgres, schema claudebox (see migration 0001_claudebox_calls_archive).
// CURSOR  = max(src_id) already in NAS. Ships id > cursor, ascending, in batches.
//           Idempotent via ON CONFLICT (src_id) DO NOTHING.
//
// WHERE TO RUN: any host that can (a) read the SQLite file and (b) reach the NAS
// Postgres. The OVH box can read the file but canNOT reach the NAS (the
// nas-db.blpk.cc tunnel fronts a different PG and rejects the documented
// password), so run this on the LAN (pbox / the nas-db host) and pull the
// SQLite either via a bind of the volume or via the router's export endpoint.
//
// ENV:
//   CALLS_DB   path to the router SQLite         (default /data/calls.db)
//   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE   NAS Postgres conn
//   BATCH      rows per round                    (default 500)
//   LOOP       "1" = run forever every INTERVAL  (default one-shot)
//   INTERVAL   seconds between rounds when LOOP   (default 60)
//
// deps: pg  (npm i pg). node:sqlite is built in (Node 22+).

import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const CALLS_DB = process.env.CALLS_DB || "/data/calls.db";
const BATCH = parseInt(process.env.BATCH || "500", 10);
const LOOP = process.env.LOOP === "1";
const INTERVAL = parseInt(process.env.INTERVAL || "60", 10) * 1000;

const COLS = [
  "id", "ts", "ip", "ua", "method", "path", "req_model", "lane", "sent_model",
  "key_label", "status", "duration_ms", "stream", "prompt_tokens",
  "completion_tokens", "total_tokens", "error", "project", "req_content", "resp_content",
];

async function round(sqlite, pool) {
  const { rows: [{ cur }] } = await pool.query(
    "SELECT COALESCE(MAX(src_id), 0)::bigint AS cur FROM claudebox.calls");
  const cursor = Number(cur);
  const src = sqlite.prepare(
    `SELECT ${COLS.join(",")} FROM calls WHERE id > ? ORDER BY id ASC LIMIT ?`
  ).all(cursor, BATCH);
  if (!src.length) return 0;

  // Build one multi-row INSERT with $-params. 21 columns per row.
  const NCOL = 21;
  const params = [];
  const tuples = src.map((r, i) => {
    const b = i * NCOL;
    params.push(
      Number(r.id),
      new Date(Number(r.ts)),                      // ts -> timestamptz
      r.ip, r.ua, r.method, r.path, r.req_model, r.lane, r.sent_model, r.key_label,
      null,                                        // account (NULL until claudebox emits X-CB-Account)
      r.status == null ? null : Number(r.status),
      r.duration_ms == null ? null : Number(r.duration_ms),
      r.stream == null ? null : Number(r.stream),
      r.prompt_tokens == null ? null : Number(r.prompt_tokens),
      r.completion_tokens == null ? null : Number(r.completion_tokens),
      r.total_tokens == null ? null : Number(r.total_tokens),
      r.error, r.project, r.req_content, r.resp_content,
    );
    const ph = Array.from({ length: NCOL }, (_, k) => `$${b + k + 1}`);
    return `(${ph.join(",")})`;
  });
  const sql =
    `INSERT INTO claudebox.calls
     (src_id,ts,ip,ua,method,path,req_model,lane,sent_model,key_label,account,
      status,duration_ms,stream,prompt_tokens,completion_tokens,total_tokens,
      error,project,req_content,resp_content)
     VALUES ${tuples.join(",")}
     ON CONFLICT (src_id) DO NOTHING`;
  const res = await pool.query(sql, params);
  await pool.query(
    "UPDATE claudebox.ship_state SET last_src_id=$1, last_run_at=now(), rows_shipped=rows_shipped+$2 WHERE id=1",
    [Number(src[src.length - 1].id), res.rowCount]);
  return src.length;
}

async function main() {
  const sqlite = new DatabaseSync(CALLS_DB, { readOnly: true });
  const pool = new pg.Pool({ max: 2 });
  do {
    let n, total = 0;
    do { n = await round(sqlite, pool); total += n; } while (n === BATCH); // drain
    console.log(`[shipper] ${new Date().toISOString()} shipped ${total} rows`);
    if (LOOP) await new Promise((r) => setTimeout(r, INTERVAL));
  } while (LOOP);
  await pool.end();
}

main().catch((e) => { console.error("[shipper] fatal", e); process.exit(1); });
