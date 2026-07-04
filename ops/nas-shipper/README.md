# nas-shipper — full call+chat archive → NAS Postgres

Ships every router call (metadata + **full req/resp content**) into the NAS
Postgres table `claudebox.calls` (unpruned, permanent). The router keeps full
content in `/data/calls.db` but prunes to `logging.retain` rows (~50k ≈ 1 day),
so without this, older calls are lost.

- **Source:** `GET https://llm.hostbun.cc/admin/api/export?after=<id>&limit=<n>`
  (cookie-gated by the admin password) — full `req_content`/`resp_content`.
- **Target:** NAS Postgres `claudebox.calls` (migration `0001_claudebox_calls_archive`).
- **Cursor:** `max(src_id)` in NAS. Pages ascending, idempotent (`ON CONFLICT`).

Because it pulls over HTTPS, it needs **no** SQLite mount — it only needs to
reach the NAS Postgres, which is LAN-only. So deploy it on the LAN.

## Deploy (Coolify on pbox — the LAN box that reaches the NAS)
Build from `ops/nas-shipper/Dockerfile`. Env:
```
ROUTER_URL=https://llm.hostbun.cc
ADMIN_PASSWORD=<router admin pw>
PGHOST=192.168.0.156  PGPORT=5432  PGUSER=postgres  PGPASSWORD=ddash  PGDATABASE=app
LOOP=1  INTERVAL=60  BATCH=500
```
No exposed port — it's a background loop.

## Run locally (backfill / test, from any LAN machine)
```
ROUTER_URL=https://llm.hostbun.cc ADMIN_PASSWORD=ddash \
PGHOST=192.168.0.156 PGPORT=5432 PGUSER=postgres PGPASSWORD=ddash PGDATABASE=app \
node ship.mjs            # one-shot; add LOOP=1 to keep running
```

## Account attribution (follow-up, separate change)
`account` ships as NULL until claudebox tags each response with
`X-CB-Account: <name>` (it already knows the account via `_LB_ATTRIBUTE`; 100%
of traffic is non-streaming so a response header suffices). Then the router
stores it in `calls.account`, the export carries it, and per-account × per-model
× per-project is a single query on `claudebox.calls`.

## Why not run on the OVH box?
The router's box can read the SQLite but cannot reach the NAS: `nas-db.blpk.cc`
fronts a different Postgres that rejects the documented password, and
`192.168.0.156` is off-LAN. Hence the HTTPS pull + LAN runner.
