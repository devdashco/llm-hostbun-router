# archive/ — long-term conversation + call archive → object storage

The Postgres `calls` table is the **operational** log: it prunes non-claudecode rows to `retain`, it
lives on one un-backed-up container volume, and it's reachable only from inside the coolify network.
That is the wrong place for the **permanent** record of every conversation, tool run and token count.

This job copies the log, verbatim and organised, to the NAS MinIO object store, which outlives the
container. Zero dependencies — stdlib `http`/`crypto`/`zlib` plus a hand-rolled SigV4 S3 client
(`s3.js`), matching the router's "only `pg`" runtime-dep discipline.

## What it writes

Data-lake layout in the `archive` bucket, so it's queryable later with duckdb/athena and browseable
by the axis that matters (who, when):

```
llmrouter/
  _state.json                                        # {lastId, updatedAt, rows} — the resume cursor
  calls/
    dt=<YYYY-MM-DD>/                                  # UTC day of the call
      consumer=<name>/                               # first colon-segment of project (promopilot:generatetext → promopilot); no project → _none
        part-<minId>-<maxId>.jsonl.gz                # gzipped newline-delimited full call rows
```

Each line is one call, **every column** the export API returns — including full `req_content` /
`resp_content` (claudecode turns are stored uncapped, so the whole transcript, tool calls and tool
results are all there). Each Claude Code request re-sends the entire growing transcript, so rows are
highly redundant; gzip crushes that ~10–20×.

## Source & auth

Reads the router's own `GET /api/export?after=<id>&limit=<n>` (full rows, id-cursored), cookie auth
via `POST /api/login`. No direct DB access — so it runs from anywhere with HTTPS to the router.

## Running

```sh
S3_ACCESS_KEY=… S3_SECRET_KEY=… node archive/archiver.js            # incremental: resume from _state.json
S3_ACCESS_KEY=… S3_SECRET_KEY=… node archive/archiver.js --backfill # start at id 0 (idempotent — same keys overwrite)
… node archive/archiver.js --dry                                    # page + partition, write nothing
```

The **first** incremental run has no cursor, so it starts at 0 and backfills everything; the cursor
is committed to the bucket after every verified batch, so a kill/timeout just means the next run
resumes. No separate backfill step is required in normal operation.

### Scheduled (production)

`archive/run.sh` is the scheduled entrypoint. It sources config from keyvault (`llm-archive/config`,
env-file fallback), finds the host's nvm `node` (the runner container has none of its own),
fast-forward-updates the repo, holds a `flock` so an overlapping tick is a no-op, then runs the
archiver (which reports to the beacon control plane itself).

> **⚠ NOT CURRENTLY SCHEDULED — verified 2026-07-26.** The task described below does not exist on
> `scriptbox-pbox` (17 tasks listed, none of them this one), nor in `crontab -l`, nor as a systemd
> timer. The cursor at `llmrouter/_state.json` has read `updatedAt 2026-07-12T17:17:59Z, rows 123035`
> ever since the backfill, while the router's `calls` table is at 481,520 rows — roughly **358k rows
> unarchived**. Re-create the task as described to restore hourly archiving.

Meant to be scheduled as a **Coolify scheduled task** on the `scriptbox-pbox` app
(`s18pl11n8t4v8i4jshsy39rg`), `17 * * * *` — **not** a local crontab (control-plane policy: every job
is a Coolify task, visible in the scriptbox TUI + beacon). The runner has `network_mode: host`, so it
reaches the LAN MinIO (`192.168.0.7:9100`) directly. Registered in the beacon as
`llm-hostbun-archive` (alerts on fail/overdue) — which, with the task absent, has nothing to alert on:
a missing job cannot report itself overdue, which is why this went unnoticed for two weeks.

### Env

| var | default | notes |
|---|---|---|
| `ROUTER_URL` | `https://llm.hostbun.cc` | |
| `ROUTER_PW` | `ddash` | admin cookie password |
| `S3_ENDPOINT` | `https://nas-s3.blpk.cc` | use `http://192.168.0.7:9100` on the pbox LAN — faster, and avoids the Cloudflare-fronted endpoint's bulk-drop behaviour |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | — | MinIO keys (keyvault `bluebut/nas-minio/s3`) |
| `S3_BUCKET` | `archive` | |
| `S3_PREFIX` | `llmrouter` | |
| `PAGE_SIZE` | `100` | rows per export page; kept low because a full-content page is held in memory whole |
| `MAX_BATCHES` | `0` (unbounded) | cap batches per run (cursor still persists) — useful under a scheduler timeout |

## Verification & durability notes

- Every upload is **verified** by a ranged GET (`bytes=0-0` → total size from `Content-Range`).
  This MinIO-behind-Cloudflare answers `HEAD` with 403 and rejects some range requests with 400, so
  the verifier falls back to a full GET when the range path fails. A verify miss retries the PUT (3×).
- Writes are one authenticated object per PUT (not a bulk `mc mirror`), which is the shape that does
  **not** trip the CF-fronted drop issue — but prefer the LAN endpoint on pbox regardless.
- Idempotent: part keys are deterministic from the id span, so a re-run overwrites rather than
  duplicates. Safe to re-run after any failure.

## Reading it back

```sh
# one partition, back to JSON
aws --endpoint-url http://192.168.0.7:9100 s3 cp \
  s3://archive/llmrouter/calls/dt=2026-07-11/consumer=promopilot/part-...jsonl.gz - | gunzip | jq .
```
