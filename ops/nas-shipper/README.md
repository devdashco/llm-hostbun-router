# nas-shipper — full call+chat archive → NAS Postgres

Ships every router call (metadata + **full req/resp content**) from the router's
SQLite (`/data/calls.db`, pruned to ~50k rows ≈ 1 day) into the NAS Postgres
table `claudebox.calls` (unpruned, permanent). Idempotent, cursor-based.

## NAS schema
Applied as migration `0001_claudebox_calls_archive` on the NAS `app` db:
- `claudebox.calls` — mirror of the router schema + `account` + full `req_content`/`resp_content`
- `claudebox.ship_state` — high-water bookkeeping

## Run
```
CALLS_DB=/data/calls.db \
PGHOST=192.168.0.156 PGPORT=5432 PGUSER=postgres PGPASSWORD=ddash PGDATABASE=app \
LOOP=1 INTERVAL=60 BATCH=500 \
node ops/nas-shipper/ship.mjs
```
`node:sqlite` is built in (Node 22+); `npm i pg` for the Postgres client.

## Where to run — IMPORTANT
Needs to read the SQLite **and** reach the NAS Postgres.

- The **OVH box** (where the router runs) can read the file but the NAS is NOT
  reachable from it: `nas-db.blpk.cc` fronts a different Postgres that rejects
  the documented password, and direct `192.168.0.156` is off-LAN.
- So run this on the **LAN** (e.g. pbox, or the nas-db MCP host). Get the SQLite
  either by mounting the router's Coolify volume over a share, or add a
  `/admin/api/export?after=<id>&limit=<n>` full-row endpoint to the router and
  pull over HTTPS (cookie-gated) — then swap the `DatabaseSync` source for a
  fetch. (Endpoint stub not yet added.)

## Account attribution (TODO, separate change)
`account` ships as NULL until claudebox tags each response. Plan: claudebox sets
`X-CB-Account: <name>` (it already has `_LB_ATTRIBUTE`; 100% of traffic is
non-streaming so a header is enough), the router stores it in `calls.account`,
and the shipper carries it. Then per-account × per-model × per-project becomes a
single query on `claudebox.calls`.
