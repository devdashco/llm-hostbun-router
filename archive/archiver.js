// llmrouter → NAS long-term archive.
//
// The call log (Postgres `llmrouter.calls`) is the operational store: it prunes non-claudecode rows
// to `retain`, lives on one un-backed-up container volume, and is reachable only from inside the
// coolify network. None of that is where you want the *permanent* record of every conversation and
// every tool run to live. This job copies it, verbatim and organised, to object storage that outlives
// the container.
//
// Source: the router's own `GET /api/export?after=<id>&limit=<n>` — full rows, all columns, full
//   req_content/resp_content (claudecode turns are stored uncapped). Cookie auth via POST /api/login.
// Sink:   MinIO/S3 bucket, data-lake layout so it's queryable later (duckdb/athena) without a DB:
//
//   <prefix>/calls/dt=<YYYY-MM-DD>/consumer=<name>/part-<minId>-<maxId>.jsonl
//
//   One newline-delimited JSON object per call. Partitioned by UTC day and by CONSUMER (the first
//   colon-segment of `project`, e.g. promopilot:generatetext → promopilot), because that's the axis
//   you actually browse the knowledge by. A caller with no project lands in consumer=_none.
//
// Cursor: <prefix>/_state.json {lastId,updatedAt,rows} in the SAME bucket — no external state store,
//   and a resume after a crash re-reads exactly what the last successful batch committed.
//
// Modes: default = incremental (resume from cursor). --backfill = start at 0 (idempotent: re-running
//   overwrites the same deterministic part keys, it does not duplicate). --dry = page + partition but
//   never write (prints what it would do).
//
// Zero dependencies (stdlib http + the sibling sigv4 S3 client). Config is env-only; nothing secret
// is committed. Run by hand or as a scheduled task — see README.md.
const { S3 } = require("./s3.js");
const zlib = require("node:zlib");

const CFG = {
  routerUrl: (process.env.ROUTER_URL || "https://llm.hostbun.cc").replace(/\/$/, ""),
  routerPw: process.env.ROUTER_PW || "ddash",
  endpoint: process.env.S3_ENDPOINT || "https://nas-s3.blpk.cc",
  accessKey: process.env.S3_ACCESS_KEY || "",
  secretKey: process.env.S3_SECRET_KEY || "",
  bucket: process.env.S3_BUCKET || "archive",
  prefix: (process.env.S3_PREFIX || "llmrouter").replace(/\/$/, ""),
  // Full-content rows are large: each claudecode request re-sends the ENTIRE growing transcript
  // (system + every message), so consecutive rows are near-duplicates and 150 of them is ~300MB raw.
  // Two consequences drive the defaults: (1) a page is held in memory whole, so keep the row count
  // low; (2) the partition object is gzipped before upload — near-identical JSON compresses ~15-20×,
  // turning that 300MB into ~15-20MB and making the redundant re-sends cheap to keep verbatim.
  pageSize: Math.min(parseInt(process.env.PAGE_SIZE || "100", 10), 2000),
  maxBatches: parseInt(process.env.MAX_BATCHES || "0", 10) || Infinity,   // 0 = unbounded
};
const ARGS = new Set(process.argv.slice(2));
const BACKFILL = ARGS.has("--backfill");
const DRY = ARGS.has("--dry");

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retry a flaky async op with exponential backoff. The router export crosses the public internet and
// reads a network-hop-away Postgres; a transient `fetch failed` must pause the run, not kill it (the
// cursor is only committed per verified batch, so a crash is safe but wasteful). 5 tries → ~30s max.
async function retry(fn, label) {
  let err;
  for (let i = 0; i < 5; i++) {
    try { return await fn(); }
    catch (e) { err = e; const wait = Math.min(2000 * 2 ** i, 15000); log(`  ${label} failed (try ${i + 1}/5: ${e.message}); retry in ${wait}ms`); await sleep(wait); }
  }
  throw err;
}

// One cookie jar, one login. The whole auth model server-side is a single HttpOnly session cookie.
let COOKIE = "";
async function login() {
  const r = await fetch(CFG.routerUrl + "/api/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: CFG.routerPw }),
  });
  if (!r.ok) throw new Error(`login → ${r.status}`);
  const sc = r.headers.get("set-cookie");
  if (sc) COOKIE = sc.split(";")[0];
  if (!COOKIE) throw new Error("login returned no cookie");
}
async function exportPage(after) {
  return retry(async () => {
    const r = await fetch(`${CFG.routerUrl}/api/export?after=${after}&limit=${CFG.pageSize}`, { headers: { cookie: COOKIE } });
    if (r.status === 401) { await login(); throw new Error("re-auth"); }   // retry with the fresh cookie
    if (!r.ok) throw new Error(`export after=${after} → ${r.status}`);
    return r.json();   // {rows, count, after, maxId, limit}
  }, `export after=${after}`);
}

// A row's partition axes. `ts` is epoch-ms; consumer is the first colon-segment of project.
const dayOf = (ts) => new Date(Number(ts) || 0).toISOString().slice(0, 10);
const consumerOf = (project) => {
  const p = (project == null ? "" : String(project)).trim();
  if (!p) return "_none";
  const c = p.split(":")[0].trim();
  // Keep the key filesystem/URL-safe; consumers are already slugs, but a stray char shouldn't break a path.
  return c.replace(/[^a-zA-Z0-9._-]/g, "_") || "_none";
};

async function readState(s3) {
  if (BACKFILL) return { lastId: 0 };
  try { const b = await s3.getObject(CFG.bucket, `${CFG.prefix}/_state.json`); if (b) return JSON.parse(b.toString()); }
  catch (e) { log("state read failed, starting at 0:", e.message); }
  return { lastId: 0 };
}
async function writeState(s3, st) {
  if (DRY) return;
  await s3.putObject(CFG.bucket, `${CFG.prefix}/_state.json`, JSON.stringify(st, null, 2), "application/json");
}

// PUT a partition object, then HEAD-verify it landed (the CF-fronted endpoint has dropped objects in
// bulk transfers; a single verified PUT is the safe unit). One retry on a size mismatch / miss.
async function putVerified(s3, key, buf) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await s3.putObject(CFG.bucket, key, buf, "application/gzip");
      const v = await s3.verifyObject(CFG.bucket, key);
      if (v && v.bytes === buf.length) return;
      log(`  verify miss on ${key} (attempt ${attempt}, got ${v ? v.bytes : "404"} want ${buf.length})`);
    } catch (e) {
      log(`  put/verify error on ${key} (attempt ${attempt}: ${e.message})`);
    }
    await sleep(Math.min(1500 * attempt, 6000));
  }
  throw new Error(`failed to write+verify ${key} after 4 attempts`);
}

async function run(brun) {
  if (!CFG.accessKey || !CFG.secretKey) { console.error("S3_ACCESS_KEY / S3_SECRET_KEY required"); process.exit(2); }
  const s3 = new S3({ endpoint: CFG.endpoint, accessKey: CFG.accessKey, secretKey: CFG.secretKey });
  await login();
  const st = await readState(s3);
  let cursor = st.lastId || 0;
  const t0 = Date.now();
  log(`archive ${BACKFILL ? "BACKFILL" : "incremental"}${DRY ? " DRY" : ""} from id>${cursor} → ${CFG.endpoint}/${CFG.bucket}/${CFG.prefix}`);

  let totalRows = 0, totalObjs = 0, totalBytes = 0, batch = 0;
  for (;;) {
    const page = await exportPage(cursor);
    const rows = page.rows || [];
    if (!rows.length) break;
    batch++;
    // Partition this page: (dt, consumer) → [rows]. Deterministic part key from the id span so a
    // re-run of the same batch overwrites rather than duplicates.
    const groups = new Map();
    for (const r of rows) {
      const k = `dt=${dayOf(r.ts)}/consumer=${consumerOf(r.project)}`;
      (groups.get(k) || groups.set(k, []).get(k)).push(r);
    }
    for (const [part, grp] of groups) {
      const ids = grp.map((r) => Number(r.id));
      const minId = Math.min(...ids), maxId = Math.max(...ids);
      const key = `${CFG.prefix}/calls/${part}/part-${minId}-${maxId}.jsonl.gz`;
      const raw = Buffer.from(grp.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const buf = zlib.gzipSync(raw, { level: 6 });   // NDJSON of near-identical transcripts → ~15-20× smaller
      if (DRY) { log(`  would write ${key} (${grp.length} rows, ${(raw.length / 1048576).toFixed(1)}MB → ${(buf.length / 1048576).toFixed(2)}MB gz)`); }
      else { await putVerified(s3, key, buf); }
      totalObjs++; totalBytes += buf.length;
    }
    totalRows += rows.length;
    cursor = page.maxId;
    // Commit the cursor after every verified batch, so a crash resumes at the last durable point.
    await writeState(s3, { lastId: cursor, updatedAt: new Date().toISOString(), rows: (st.rows || 0) + totalRows });
    log(`  batch ${batch}: +${rows.length} rows → id ${cursor} (${totalObjs} objs, ${(totalBytes / 1048576).toFixed(1)}MB so far)`);
    if (brun) brun.heartbeat({ cursor, rows: totalRows, objects: totalObjs, mb: +(totalBytes / 1048576).toFixed(1) });
    if (rows.length < CFG.pageSize) break;   // last page
    if (batch >= CFG.maxBatches) { log(`  stopping at MAX_BATCHES=${CFG.maxBatches} (cursor persisted; re-run resumes)`); break; }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log(`done: ${totalRows} rows in ${totalObjs} objects (${(totalBytes / 1048576).toFixed(1)}MB) in ${secs}s. cursor=${cursor}`);
  const summary = { archived_rows: totalRows, objects: totalObjs, bytes: totalBytes, cursor, mode: BACKFILL ? "backfill" : "incremental" };
  // Emit a machine-readable summary line for the scheduler/beacon to parse.
  console.log(JSON.stringify(summary));
  if (brun) { brun.rows(totalRows); brun.log("info", `archived ${totalRows} rows → ${totalObjs} objs, cursor=${cursor}`); }
  return summary;
}

// Wrapped in the beacon client so the run shows up in the scriptbox control plane with live
// heartbeats + finish/fail alerts. beacon is a NO-OP when BEACON_URL is unset, so standalone /
// --dry / --backfill runs from a shell are unaffected. run() itself returns the summary.
const beacon = require("./beacon");
beacon.wrap({
  slug: "llm-hostbun-archive",
  name: "llm-hostbun-archive",
  path: __filename,
  description: "Archive the llm-hostbun-router call log (conversations, tool runs, tokens) to NAS object storage.",
  data_store_kind: "nas_s3",
  data_location: `${CFG.bucket}/${CFG.prefix}/calls`,
  data_host: "nas-s3.blpk.cc",
  recurring: true,
  schedule_cron: "17 * * * *",
  expected_every_s: 3600,
  heartbeat_timeout_s: 7200,
  notify_events: ["fail", "overdue"],
}, (brun) => run(brun)).catch((e) => { console.error("archive failed:", e.stack || e.message); process.exit(1); });
