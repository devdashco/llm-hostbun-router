# llm-hostbun-router

Node router (zero deps) behind `https://llm.hostbun.cc`. **The only middleman between any of our
code and a model.** One OpenAI-compatible base URL — `/v1` — picks the provider from the model id.
Deployed on hostbun Coolify from `devdashco/llm-hostbun-router`, branch `master`.

Renamed from `llm-hostbun-proxy` (2026-07-09). The Coolify app already points at the new name; old
refs may still linger in sibling repos.

## Layout

- `server.js` — the HTTP layer and nothing else (~340 lines). Path table, boot, process guards.
- `src/` — the router proper. No cycles; each module is a leaf or near-leaf.
  | file | owns |
  |---|---|
  | `config.js` | live `CFG`, env defaults + `/data/config.json` merge, key index |
  | `config-schema.js` | the vocabularies and their validators — providers, image ids, limit windows/actions, auth modes, and `sanitizeAccount()` (which optional labels on a pool entry survive a reload). Depends on nothing but `path`; `config.js` **re-exports every name**, so callers and the import guard still resolve them there |
  | `identity.js` | consumer/job paths, API keys, `authenticate()` |
  | `routing.js` | pins, allowlists, usage limits, account pinning |
  | `http.js` | `readBody`/`readJson`, `buildHeaders`, `proxy()` — 400 lines. It was 536 and over the 500 budget until JSON enforcement moved to `jsonenforce.js`; that split is what dropped `HOP_RES`'s import and is why `imports.test.mjs` now checks module-scope consts too |
  | `gate.js` | admission control — the per-provider queue in front of the single-GPU upstreams. ~120 lines, no deps, no state outside the process |
  | `openrouter.js` | the `openrouter` catalogue (live refresh, boot + 6h), the **free-only guard** that decides which ids the provider will claim at all, and its `/api/state` + config-patch surface. A leaf — depends only on `config.js`. The control-plane bits live here rather than in `admin.js` because that file is at its size ceiling, and a provider's own state shape is a leaf concern |
  | `jsonenforce.js` | the `response_format` validate/retry loop, lifted out of `http.js`. **It strips `response_format` for `claudecode` ONLY** (no such field on the wire there) and steers with a prose instruction. It used to strip `json_object` on `local` too — llama.cpp honours both `json_object` and `json_schema` as a GBNF grammar, so that downgraded a hard constraint to a plea and gemma answered a bare JSON *string* where the caller wanted an object. Both parse, so nothing errored. Pinned by `wire.test.mjs`, asserted on the body the UPSTREAM received — the router's own 200 cannot tell the two apart |
  | `db.js` | Postgres call log + harvested account headroom |
  | `claudecode.js` | Anthropic model catalog, per-account live usage-limit refresh |
  | `admin.js` | the control-plane API behind the password cookie — **the dispatcher and the auth gate** |
  | `analytics.js` | the three read-only consumption rollups — `/api/stats`, `/api/usage`, `/api/series` |
  | `calllog.js` | the call log — `/api/calls`, `calls/facets`, `call`, `export`, `calls/clear` |
  | `accounts.js` | the Claude Max pool and its project pins — `/api/accounts*`, `/api/pins` |
  | `consumers.js` | the registry's HTTP face — `/api/consumers*`, key issue/revoke |
  | `diagnostics.js` | questions ABOUT the router — `/api/health`, `models`, `limits`, `crazyrouter[/test]`, `test`, `resolve`. Routes nothing, mutates nothing |
  | `imagetemplates.js` | the SECOND image path — a reference picture + a style instruction, rendered by an image-capable crazyrouter model. The store, its CRUD, and the one paid route under `/v1/images/*` |
  | `otel.js` | OTLP/JSON ingest — `POST /otel/v1/logs`, the token usage of boxes that bypass this router |
  | `registry.js` | the only writer of the consumer registry to Postgres |
  | `telemetry.js` | call-log row shaping, HyperDX error shipping |
  | `alert.js` | telling a HUMAN (Telegram), and the one thing worth it: an **app that just gained access to opus/fable**. Diffed from `persistConfig()`, which every registry write, panel save and `/api/routes` edit passes through — so no door creates a premium-capable app unseen. `shipEvent`'s `premium_usage` is the same subject *after* the spend; this is the moment the door opened. Requires `ALERT_TG_TOKEN` + `ALERT_TG_CHAT` (keyvault `notify/channels` → the `llm-router` bot); unset = console only, which is what tests and dev boxes run in. Channel health is on `/api/health` under `alerts` — a rotated token would otherwise drop every warning silently |
  | `pricing.js` | USD estimates (crazyrouter only) |

  `handleAdminApi` was one ~900-line function holding a flat if-chain of ~40 routes; the four route
  modules above were lifted out of it on 2026-07-26 (admin.js 1179 → 594, the handler → 302). Each
  extraction was verified **byte-for-byte** against the original before committing — that check, plus
  `imports.test.mjs`, is what makes moving control-plane code safe. **The auth gates stay in the
  dispatcher**: `login`, `logout`, `auth`, `consumers/enforce` and the session cookie are not route
  CRUD, and moving a route must never move the lock that guards it.
- **`CFG` is mutated in place, never reassigned** (`setCFG()`). Every module holds the same reference;
  `CFG = merged` left the router reading a detached copy — the panel saved and changed nothing.
- `translate.js` — OpenAI ↔ Anthropic translation. Pure, unit-tested.
- `panel/` — password-gated SPA, **Next.js 16 + Tailwind + shadcn/ui**, built as a **static export**
  (`output: 'export'`, `panel/out/`) and served by the router from `PANEL_DIR` (`/srv/panel`). pw
  `ddash`. Served at the site **root** `/`. Replaced the old Preact+htm `admin/` on 2026-07-12
  (commit `f60abb8`; `admin/` deleted at cutover). Same contract: same-origin `/api/*`, the
  `hb_admin` cookie, no CDN / zero external requests at runtime (system font, no `next/font`), and the
  runtime image stays **pg-only** — the Next build is a Docker build stage, not a runtime. server.js
  serves `/_next/*` + assets by extension (traversal-guarded) and the enumerated `UI_ROUTES` slugs →
  `out/<slug>/index.html`. **There is no `/admin` anything** — `/admin*` is a tombstone 404. Two
  ONE carve-out is load-bearing: `/api/v1/*` is real inference (`base_url=…/api`) — routing it into
  the cookie-gated handler 401s callers that never had a cookie. This used to name a second,
  `/api/pricing` "is public", and **there was no such route** (verified 400 in prod 2026-07-30): the
  exemption only let the path fall through to the model router, which answered `model_not_routable`
  and logged it as blocked traffic. Removed 2026-07-30, and deliberately not implemented —
  `prices.json` is crazyrouter's list with OUR group discount applied (`gen-prices.sh`), which is not
  something to serve unauthenticated. Build
  locally: `npm run build:panel`; preview against prod's API: `node panel/scripts/preview.mjs`.
  **Five pages, ordered as the path a request takes** — `overview` (Health · Usage), `calls`, then
  **`consumers`** (Callers · Secrets — who may call in, and the locks), **`routing`** (Rules ·
  Models) and **`providers`** (Accounts · Crazyrouter · Image templates — every upstream we spend
  against). They replace `identity`/`settings`, which filed the outbound Max account pool under
  "Identity" and a provider's API key under "Settings". **Nav label == landing tab == page
  heading**, verbatim; three different words for one page is what made the old nav unreadable.
  Old slugs stay as client-side redirects and stay in `UI_ROUTES` — drop one and a bookmark 404s
  instead of landing where it used to.

  **The nav carries three signals, not one (2026-07-27).** The 2026-07-26 pass named each page for
  the direction of the wire, which is the right story and one an abstract noun cannot tell: in a
  list, "Consumers" and "Providers" are nine-letter latinate twins ending in -ers, and neither says
  which way it points. So the sidebar now also renders a one-line **`hint`** of what the page holds
  (this panel is visited occasionally — every visit starts from a cold memory), splits into
  **Watch** (nothing you click changes behaviour) and **Change** (it does), and orders the second
  group as Callers → Routing → Upstreams so the nav teaches the router. The labels **`Callers`** and
  **`Upstreams`** are exactly that: labels. The page bodies still say `consumer` and `provider`,
  because those are the registry entity and the call-log column — a prettier synonym there would be
  a translation step on every table, filter and error string. Same reason the `Secrets` tab kept
  the id `access`: an id is a URL, and the legacy redirects point at it.

- `docs/` — **docsify** site: `index.html` shell + markdown pages + `_sidebar.md`, docsify vendored in
  `docs/vendor/` (no CDN, `noEmoji: true` because emoji shortcodes fetch images from githubassets).
  Served at `docs.llm.hostbun.cc/*` **and** `llm.hostbun.cc/docs/*` from the same files, so asset
  paths are relative and **`/docs` 301s to `/docs/`** — without that, `vendor/docsify.js` resolves to
  `/vendor/docsify.js` and the page renders `loading…` forever. It is **public and unauthenticated**:
  `test/docs.test.mjs` fails the build if a password, `sk-ant-oat…`, `sk-llm-…` or a `DATABASE_URL`
  ever lands in it.

## Tests — `npm test` (31 suites, ~840 checks, ~80s)

No network beyond loopback, no database, zero runtime deps. Run before every push. The count and
the suite list are checked against `package.json` by `docs-claims.test.mjs`, because this section
said "nine suites, 302 checks" for weeks while the gate had grown to twenty — and a manual that is
wrong about the gate is how a suite gets added and then quietly dropped.

- `test/imports.test.mjs` — static check that every cross-module call is actually bound in the file
  making it. The `src/` split left twelve module-level identifiers unimported; `require` doesn't
  complain until the line runs.
- `translate.test.js` — the seven translation traps, plus the tool-argument degradations: malformed
  `arguments` become `{}` rather than throwing, and the tool's NAME and ID still reach the model so
  the result can be paired back. That is the substitute-a-plausible-default shape this codebase keeps
  producing, and here it is the right trade-off — translate.js is pure and cannot report, the
  alternative is failing an inference over a caller's formatting, and Anthropic rejects a genuinely
  invalid block itself. Pinned so changing it is a decision rather than a drift.
- `test/wire.test.mjs` — boots the real server against a fake upstream and drives every route, for
  the same class of bug as `imports` but on the paths only a request reaches.
- `test/router.test.mjs` — boots a real server on an OS-assigned port: pins, allowlists, job
  inheritance, the image-model refusal, merge-vs-replace endpoints, the auth gate. Written as an
  old-vs-new parity harness during the `src/` split and kept.
- `test/panel-tokens.test.mjs` — the panel's design tokens, read from **source** (so it needs no
  `panel/` build). Fails on a bracket font size, a raw Tailwind palette class, a `foo-[var(--x)]`
  escape, a `.dark` colour token never registered in `@theme inline` (which compiles to *nothing* —
  the class is silently dropped), or a drifted type scale. All five had already happened; see
  `panel/AGENTS.md` for the rules it enforces.
- `test/panel-nav.test.mjs` — the nav, read from **source** (no `panel/` build needed). Five files
  have to agree on what the pages are called — `shell.tsx`'s `NAV`, the `ALIAS` map, `UI_ROUTES` in
  `src/config.js`, one `page.tsx` per slug, and each component's `PageHead` title — and every
  mismatch is silent. Fails on a nav slug missing from `UI_ROUTES` (hard-refresh 404), a legacy
  redirect pointing at a dead page/tab or missing its `ALIAS` entry (the bookmark it exists for
  lands nowhere), a redirect chain, and a nav label that doesn't match its landing tab and heading.
  Also pins **every vocabulary the panel offers and the server validates**, because the panel is a
  separate static build with no way to import `src/config.js` and each mismatch fails silently by
  rewriting the operator's choice: `LIM_WINDOWS` vs `LIMIT_WINDOWS` (an unknown window becomes
  `24h`), `LIM_HARD` vs `LIMIT_HARD` (an unknown action becomes `block`, so "warn only" turns into a
  429), and `PROVS` vs `PROVIDERS` (compared as a SET — the panel orders them for display). Add a
  value on one side only and the gate goes red.

- `test/imagetemplates.test.mjs` — the image-template path, against TWO fake upstreams so "which
  upstream answered" is an assertion rather than an inference. Pins the three things that fail
  silently: a generation that reaches the model WITHOUT the reference image (it still returns a fine,
  off-brand picture — nothing errors), an SD-Turbo template name that stops falling through, and the
  paid route answering without a key. Probed by mutation: dropping the reference part turns one check
  red, hardcoding the auth mode to `off` turns three red.

- `test/proxy-log.test.mjs` — `proxy()`'s EARLY-RETURN branches still write a call-log row. Stubs
  `recordCall` on the db module *before* requiring `http.js` (it destructures at require time, so a
  later patch is captured too late) and drives a real 504 off a loopback upstream. A row is how a
  call becomes attributable; every path that answers the caller and `return`s is a chance to drop one
  silently. The image-error branch did: a successful image call was logged and a failed one was not,
  so during the 2026-07-26 ingress outage the log read "no image traffic" instead of "image traffic
  failing" — while a *refused* connection, handled higher up, recorded normally and hid the gap.

- `test/gate.test.mjs` — admission control, driven through the real server against slow fake
  upstreams that COUNT how many requests they had in flight at once. That number is the only
  evidence a gate works; the router's own 200s look identical either way. Pins the three ways it
  un-gates itself silently: releasing the slot when `proxy()` RESOLVES instead of when the response
  ends (it returns the moment it wires `r.pipe(res)`, so a release there hands the GPU to the next
  caller mid-render — probed: turns 3 checks red), gating the cloud lanes as well (serialising
  api.anthropic.com would be a self-inflicted outage no 500 ever reveals — probed: 2 red), and
  leaking a slot when a queued caller hangs up, which is invisible until the gate is permanently
  full and every caller 503s against an idle GPU.

- `test/gate-perbox.test.mjs` — the gate serialises the RIGHT SET. `local` is not one piece of
  hardware: pbox's 4090 and ww's 3070 each serve their own models from their own card, so one
  shared `local` queue made a batch against one box wait for the other. Measured 2026-08-04 —
  agentic-marketplace held `local` at 4/4 with 8 queued against pbox while ww's `qwen3.5-2b`, which
  answers in 0.06 s asked directly, took 9-11 s through the router, queueing for a GPU it never
  touches. Every one of those was a 200, which is why the concurrency-counting suite above cannot
  see this class of bug at all. Pins `keyFor` (one key per base, only for `local`, stable, and
  falling back when the base is absent or unparseable) and the trap inside `limitFor`: it looks up
  `DEFAULTS[key]`, so keying by base without splitting the provider half back off yields `undefined`
  -> limit 0 -> **ungated**, i.e. admission control deleting itself silently. Also pins that the key
  set is bounded by the CONFIGURED bases rather than by traffic, so `gates` cannot grow into an
  unbounded cache.

- `test/local-default.test.mjs` — what the FREE lane resolves to on a cold boot, i.e. with no
  `/data/config.json`. Production reads `localMap` off the volume, so the env seed is invisible until
  the volume is empty — a fresh deploy, a lost disk, or `POST /api/reset`, which unlinks the file and
  reverts to `envDefaults()`. Reconstructed and measured on the pre-2026-08-02 seed: `local`/`gemma`
  resolved to **claudecode** and `gemma-4-26b`/`qwen3.5-9b` fell through to **crazyrouter**, which
  bills per token — four of the five ids for a free on-prem GPU pointed at something that costs
  money, and the caller still gets a perfectly good completion, so nothing says so. Invariant 2's
  substitution arriving as a default rather than a decision. Also pins that the *abliterated* ids
  keep their claudecode redirect (they genuinely have no local backend) and that `modelRoutes` never
  reclaims a local id, since it outranks `localMap`. Probed: 15 of its 21 checks go red on the old
  seed.

- `test/otel.test.mjs` — the OTLP ingest, in two halves. The parse (OTLP/JSON puts every int64 in a
  **string**, the event name arrives either in `event.name` or in the log body, and every other
  Claude Code event rides the same stream and must produce **no** row) and the gate (this is a write
  into the call log from outside; it sits above the inference auth gate in server.js, so nothing else
  is watching it — unauthenticated, anyone could forge spend against any consumer). Probed: faking
  the auth check green turns 3 checks red. The `Number()` in `anyVal` is NOT what the token-type
  assertions catch — `num()` on each numeric read is the real guard; the assertions pin the output
  type, not the line that produces it.

- `test/keypolicy.test.mjs` — `allowUa`, the lock that stops a developer's key being used by an app.
  Pins the three things that turn a mistake into an outage: an EMPTY policy is unrestricted (not a
  lockout), the refusal is a 403 that names the consumer AND how to mint your own, and a bad secret
  is still a 401 — ordering the policy check before authentication would answer "wrong client" to
  someone whose real problem is a dead credential. It already earned its keep: the config sanitizer
  dropped `allowUa` on load, so the lock existed in Postgres and vanished from the mirror.

- `test/openrouter.test.mjs` — the `openrouter` provider, whose every failure mode returns a
  perfectly good completion. Claiming an id it should not have (a paid model on a card, or
  `claude-opus-5` leaving the flat Max subscription for a metered relay) and claiming NOTHING when it
  should have (free traffic falling through to crazyrouter, billed per token) are both 200s, so
  every assertion is about WHICH upstream an id resolves to, never about a status code. Pins: the
  provider is entirely OFF without a key (so deploying it changes no existing route); the free-only
  guard, read BOTH ways openrouter marks free (`:free`, and zero prompt AND completion — prices
  arrive as strings, and an absent pricing block must not read as free); that `/v1/models`
  advertises exactly what would resolve; that the route carries `authToken`, never `injectKey` —
  which is hard-wired to `crazyrouterKey` and would hand that credential to a third party; and that
  a failed refresh KEEPS the previous catalogue, including the 200-with-an-empty-list that is
  indistinguishable from an outage and would silently un-route every free model at once. Probed:
  dropping the free-only guard turns 6 checks red, accepting an empty catalogue 2, removing the
  no-key guard 2. The routing-ORDER check needed a second pass — the first version read green
  against a deliberately reordered `baseRoute` because no catalogue id starts with `claude`, so it
  now asserts with `openrouterModels` populated, which is the only way that ordering can bite.

- `test/freeaiapikey.test.mjs` — the `freeaiapikey` provider, same class of bug as the suite above
  and therefore the same rule: **not one assertion is about a status code**, because every way this
  provider fails returns a good completion. Pins that it is OFF without a key or a base (so the
  deploy that added it changed no route until the key landed); that the WRITTEN model list is the
  only guard, since there is no free/paid line here to police; that an empty list means "claim
  nothing" rather than "unset, keep the seed" (it is the off switch that does not require deleting
  the key — the opposite of `imageTemplateModels`, deliberately); that the route carries `authToken`
  and never `injectKey`; and that the bare `claude-*` ids stay on the Max pool **even when someone
  hand-writes one into `freeaiapikeyModels`**, which is the one mistake here that costs real money.
  Probed: removing the list guard turns 4 checks red, never taking the branch 8, swapping
  `authToken` for `injectKey` 2.

- `test/groq.test.mjs` — the `groq` provider, and the same assert-the-route-never-the-response rule
  as the two suites above, because every failure here is either a good completion from the wrong
  (paid) upstream or a 404 that reads like a routing bug. Pins the shared shape — off without a key
  or base, the written list as the only guard, an empty list meaning "claim nothing", `authToken`
  never `injectKey` — plus three things specific to this lane: that the `/openai` base suffix
  survives the merge (the bare host is a different API, so losing it answers wrong rather than
  404ing); that the **non-chat ids are absent by id**, so a later "add every advertised id" commit
  goes red rather than silently routing transcription to a chat endpoint; and the ORDERING, that
  groq wins an id `freeaiapikey` also lists while an id only *it* lists still reaches it — the check
  that catches the free-lane-below-paid regression. The Max-pool guard here is branch order, not the
  id shape, so `claude-*` is asserted both bare and hand-written into `groqModels`. The ordering
  check read green for the wrong reason when first written (the fixture replaced the freeaiapikey
  seed, so the second half asserted a provider declining an id it was never given) — the fixture now
  lists both ids, which is the assertion-that-cannot-fail trap this repo keeps producing.

- `test/quota.test.mjs` — the free-tier headroom harvest (`src/quota.js`), which reads the
  OpenAI-convention `x-ratelimit-*` off every reply and keeps it in memory. Pins the distinction this
  repo keeps having to relearn: **no reading is not 0% used** — an absent provider and a provider with
  headroom must not render alike (same rule as claudecode's `limits: null`). Also that a provider
  which sends no such headers records NOTHING rather than an empty reading (otherwise claudecode and
  crazyrouter would report "0 of 0 used"); that a later reply OVERWRITES the earlier one, since
  tracking toward the ceiling is the entire point and a write-once store would pass every other
  assertion; that `tightest()` leads with the model nearest its cap, because groq's ceilings are per
  model and uneven (14,400 req/day on one id, 1,000 on the rest) so an average would report healthy
  while one lane was dry; and that the key cap bounds GROWTH but never freezes an EXISTING key — the
  busiest model is the one that hits the ceiling and the one a naive cap would silence first. `durMs`
  is pinned separately: groq returns a DURATION (`2m59.56s`), not a timestamp, and misparsing it
  renders a reset time silently hours off.

- `test/apps.test.mjs` — `POST /api/apps` (one-call app creation) and the premium-app watcher behind
  it. Two silent failure classes: a TIER that quietly includes opus (still `ok:true`, still a working
  key, 5–10x on the shared pool until someone reads the rule back — hence the *negative* assertions),
  and a DIFF that never fires. The watcher breaks in both directions invisibly: no baseline pages
  about every app on the next restart, a baseline that swallows the first look never alerts at all,
  and from outside both read as "no alerts". Also pins that a pin to haiku is NOT premium-capable
  (the pin rewrites every call, so reading the allowlist first would flag half the fleet and get the
  warning muted), that a failed create leaves no orphan routing rule, and that the alert channel's
  own health is on `/api/health`. Probed: dropping the premium filter from the `standard` tier turns
  2 checks red, removing the baseline turns 1 red.

**Coverage is skewed toward the safe routes. Audited 2026-07-26:** fourteen admin routes had no
test at all, and they cluster at the dangerous end — `auth` (the switch that decides whether anyone
needs a key), `reset` (restores config defaults), `calls/clear` and `consumers/purge` (destructive),
`registry/keys` + both `keys/revoke` (mint and revoke credentials), plus `reveal`. `reveal`, `auth`,
`calls/clear`, `consumers/purge`, `registry/keys` and both `keys/revoke` were covered that day;
`reset`, `claudecode/models`, `models`, `limits`, `crazyrouter/test` and both alias routes too —
and `logout` last, so the admin surface has no untested route today — its block in
`router.test.mjs` pins the parts that are a lock rather than a courtesy: an anonymous `POST` is a
401 (an ungated one is a free lever on everyone else's session), a `GET` is refused (an
`<img src=".../api/logout">` would otherwise log the operator out from any page), and the OLD cookie
stops authenticating afterwards — sessions are stateless signed tokens with no store to revoke, so
without the `sessionEpoch` bump "logout" would clear the browser's copy and nothing else. Covering
the "read-mostly tail" was not cosmetic: it found
`GET /api/claudecode/models` throwing `ReferenceError: claudecodeCatalog is not defined` on every
call, live. `imports.test.mjs` could not catch that class at the time — it flagged a bare `name(` CALL, and this
was an unbound identifier read as an OBJECT (`claudecodeCatalog.source`). **A second pass now covers
it** (2026-07-26): a name from another `src/` module — its exports **and its module-scope
SCREAMING_CASE consts** — used as `X.…` and never bound in the file. 170 references checked, up from
135. The consts half is load-bearing: `HOP_RES` was un-exported when the `jsonenforce` split dropped
its import, and an exports-only pass is green on that exact state (reproduced to confirm). It is deliberately narrow — a general "any dotted name not
bound here" version was tried and flagged eleven things on a clean tree, and a check that cries wolf
gets switched off. **`reset`'s test runs LAST in
`router.test.mjs` by necessity** — it unlinks the config file and reverts `CFG` to `envDefaults()`,
so it destroys the fixture every assertion above depends on. Add new cases before it, not after —
**enforced since 2026-07-26**, not merely asked: the reset block sets a flag and `check()` fails any
assertion made after it, naming the fix. The file is 646 lines and deliberately NOT split — it boots
one server and its ordering is load-bearing (reset last, the auth-mode block restores what it
changed, the POST-config block wipes `projectRoutes` on purpose). Splitting it across files would
hide the very constraints that make the length matter. When adding a control-plane route,
assume nothing is watching it unless you wrote the test — the read-only routes are the well-covered
ones because they were the easy ones.

**Do not "tidy up" the exports that look unused.** Seventeen names in `src/` are exported and
referenced only inside their own file — `providerRoute`, `enforceAllow`, `projectRuleFor`,
`hasImageContent`, `dbWrite` and friends. They look like dead surface and are not: `imports.test.mjs`
pass 2 keys on the export list, so an exported lowercase helper misused as an object in another file
is CAUGHT, and the same helper un-exported is invisible to it (measured both ways, 2026-07-26 — only
SCREAMING_CASE names are covered without being exported). Trimming them shrinks the guard. A name
that is genuinely dead — no caller anywhere, internal or external — is a different thing and should
go: `extractReqMeta` and `extractReqParams` were removed on that basis the same day.

**Every suite was probed individually, not just the invariants (2026-07-26).** One targeted
mutation per suite, all eight caught it: `imports` (drop telemetry's `clip` import), `translate`
(drop the max_tokens default), `router` (serve a disabled account), `wire` (typo a dispatch binding),
`panel-tokens` (drop `usd`'s null guard), `panel-nav` (drop a slug from `UI_ROUTES`), `proxy-log`
(stop recording image requests), `telemetry-throttle` (disable the repeat gate).

**The failure mode to watch for when adding cases is an assertion that cannot fail.** Four turned up
this session, all in tests written the same day as the code. The recurring one:  `proxy()` RETURNS
BEFORE its response stream finishes — on the streaming path the call-log row is written from the
`end` handler — so anything asserted straight after `await proxy(...)` checks a row that has not been
written yet and passes whatever the code does. Wait for `end`/`finish` first. The other was a
response fake that was a plain object rather than a `Writable`, which held up only while the tests
happened to drive early-return branches. Mutating is what found all four; reading them did not.

**The suite has teeth — probed, not assumed (2026-07-26).** Deliberately breaking each of the five
load-bearing invariants turns the gate red: an allowlist that substitutes instead of refusing
(invariant 2), a disabled account served anyway, an image id allowed on a text endpoint, the
`max_tokens` default dropped (trap #1), and `markCacheBreakpoints` neutered (trap #8 — the change
that took live cache hits 0% → 96%). Two caveats worth keeping: a probe is only as good as its
anchor — one of these first read as UNCAUGHT because the patch landed on a comment mentioning
`max_tokens` rather than the assignment — and this was a one-off measurement, not a harness. A
brittle mutation harness that silently stops matching is the `imports.test.mjs` failure mode again,
so this is recorded as a fact with a date rather than automated.

- `test/telemetry-throttle.test.mjs` — `shipError`/`shipEvent` collapse REPEATS and nothing else. A
  distinct signal must never be delayed by a noisy one: the signature is severity + message, so a
  first occurrence always ships immediately and further identical ones are summarised once a minute
  carrying `repeats_suppressed`. Measured cause (2026-07-26): the dead image ingress had put **601**
  copies of `upstream 504 POST /v1/images/generations` into HyperDX against ~529 rows of every other
  signal combined. `SHIP_WINDOW_MS` is env-tunable **only so the count path is testable** without a
  60s sleep — production never sets it.

- `test/waste.test.mjs` — the waste watcher's thresholds, driven with the real shapes they were
  calibrated against. The NEGATIVES matter most: `pmac` (8,323 calls/day at 0% cache) and `wmac` are
  wired in as must-not-fire, because a watcher that cries wolf gets switched off.

- `test/db-writehealth.test.mjs` — a failed call-log write must be COUNTED, not just logged. `dbUp()`
  is `!!pool` and pg does not connect until the first query, so `loggingDbReady: true` only ever meant
  "a config string was present". With the DB unreachable the panel showed `dbReady:true` and an empty
  log — indistinguishable from a quiet hour while every row was dropped into a stdout warning.

- `test/health-verdict.test.mjs` — `/api/health` must not call a provider up when it knows it is not.
  `claudecode` is deliberately not probed (an unauthenticated request to api.anthropic.com reads as
  down), so its verdict is "do we hold a usable login" — which was `pool.length > 0`, and the pool
  retains accounts the router itself auto-disabled after a 403.

- `test/panel-health-claims.test.mjs` — the Health tab may not report all-clear on a check it did not
  run. `api("stats").catch(() => null)` makes a failed fetch look like a quiet hour, and the banner
  must name what it actually checked.

- `test/model-fold.test.mjs` — `foldServedByModel`: when one requested id was served by several
  models, the tier, the premium flag and the list cost must come from a token-weighted fold, not from
  an arbitrary member of an unordered `string_agg`.

- `test/server-rows.test.mjs` — boots server.js **in-process** with `recordCall` stubbed, so what the
  real handler writes to the call log is observable at all. The other suites boot it in a child
  process, where a row cannot be seen. Also covers the OTel ingest end to end.

- `test/gateway-route.test.mjs` — sources `cccc/shell/gateway-route.sh` in bash with a throwaway HOME
  and asserts the environment a shell actually ends up with, per branch: the direct branch must ship
  OTel it can authenticate, and a box with no key must ship nothing.

- `test/module-size.test.mjs` — the 500-line module budget, as a ratchet. `server.js` and `admin.js`
  are already over and carry ceilings they may only shrink; a file that shrinks without lowering its
  ceiling fails too, with the number to write.

- `test/static-guards.test.mjs` — the guards on the only code that turns a URL into a file read.
  Traversal in the forms that actually differ (literal, encoded, double-encoded, backslash, absolute,
  panel-root escape), the NUL-byte guard, and the `/docs` 301. All over RAW SOCKETS: `fetch()`
  normalises `..` out of a path and rejects a NUL outright, so either test written with fetch proves
  the client is well behaved and nothing about the server. Split out of `docs.test.mjs` so it runs in
  the gate — a regression guard on a connection-exhaustion bug has no business behind jsdom.

- `test/registry-refresh.test.mjs` — a refresh that cannot READ must not WRITE. `refresh()` projects
  the Postgres registry into `CFG` and the `/data/config.json` mirror, and it read through `dbRows`,
  which swallows a query error and returns `[]` — indistinguishable from "no rows". One transient
  failure on the api_keys SELECT therefore emptied every consumer's key list, wiped `KEY_INDEX`, and
  PERSISTED that: every caller 401s `unknown or revoked key`, and a restart does not recover it
  because the mirror is now the blank version. Pins that a failed read leaves the previous projection
  alone, that this holds for the consumers query too, and that a later successful refresh still
  applies — a guard that latched on the first error would be its own outage.

- `test/test-helpers.test.mjs` — a suite may not call an assertion helper it does not define. No two
  suites here agree on the names — `check(name, actual, expected)` in some, `check(name, bool)` in
  others, `ok`/`bad` in nine files, `ok`/`fail` in four, `eq` in one, and in `waste.test.mjs` `fail`
  is a COUNTER. That is fine; each suite is standalone. What is not fine is that a missing helper
  throws only on the line that calls it, and that line is usually the FAILING branch — so the check
  reads green until the day it should go red, and then crashes instead of reporting. It happened
  three times in one session, and the first probe of a real bug read "0 failures" because of it.
  Narrow on purpose: only that vocabulary, and not `is`/`same`/`must`, which are English as often as
  code. It strips comments but NOT strings — every string-aware strip tried swallowed whole files
  through the backticks inside their own regex literals, and a blanked file is a guaranteed false
  negative in a check whose entire value is that a green result means something.

- `test/docs-claims.test.mjs` — what the PUBLIC docs claim, checked against the code, plus the scan
  that stops a live password/token/key/DSN being published. Split out of `docs.test.mjs` so it runs
  in the gate: that suite needs jsdom, a dev dependency, so it ran only when someone remembered.

Two more are **not** in `npm test` because they need `panel/out` or the docs build:

- `npm run test:panel` (`test/panel-secrets.test.mjs`) — no secret in the static export.
- `npm run test:docs` (`test/docs.test.mjs`) — the docs actually render (docsify fetches its markdown
  at runtime, so a bad `basePath` is a permanent `loading…`), every sidebar link resolves, and no
  secret is published. Traversal is tested over a raw socket: `fetch()` strips `..` before the
  request leaves the process, so a traversal test written with `fetch` asserts nothing.
- `docs/` — static docs, served at `docs.llm.hostbun.cc`.
- `cccc/` — the fleet control surface (TUI, statusline, claudectl plugin/MCP) — see the
  "`cccc/`" section at the bottom. Not watched by Coolify; ships via `cccc/deploy.sh`.
- `headroom-svc/` — optional Python compression sidecar. Separate Coolify app, **same repo**
  (base dir `headroom-svc`). OFF unless `HEADROOM_URL` is set. **Never** applied to `claudecode` —
  it rewrites the prompt and would miss the prompt cache, costing more than it saves.

## Providers

Six **routing** providers — the whole of `PROVIDERS`, i.e. everything a model id can resolve to.
(`lane` is the old word for the same thing; a few internals still spell it that way.)

| provider | upstream | speaks | cost |
|---|---|---|---|
| `local` | llama.cpp on the pbox GPU (`bases.local`, currently `pbox.llm.hostbun.cc`). **Serves `Qwen3.5-9B-UD-Q4_K_XL.gguf`, build b10223, `n_ctx` 65536 / **4 slots** (`-np 4`, read off the container's own argv 2026-08-04 — this said 6, and `gate.js` DEFAULTS has always said 4; the CODE was right), vision — swapped 2026-08-02, was gemma-4-26B-QAT.** All five ids `local`/`gemma`/`gemma-4-26b`/`qwen`/`qwen3.5-9b` resolve here; the **`gemma` pair are now the legacy aliases** — the direction reversed on the swap, which is exactly why you ask `/props` and never infer from the id | OpenAI | free |
| `claudecode` | the **claudecode-account-pool** (our Claude Max logins) → `api.anthropic.com` | Anthropic | flat (subscription) |
| `crazyrouter` | `crazyrouter.com` cloud relay (gemini etc), key injected | OpenAI | **per token** |
| `openrouter` | `openrouter.ai` (`bases.openrouter` = `https://openrouter.ai/api` — the `/api` is load-bearing, every caller appends `/v1/…`). Added 2026-08-04. **FREE-ONLY by default** and OFF entirely without `openrouterKey` | OpenAI | free (see below) |
| `freeaiapikey` | `api.freeaiapikey.com` (`bases.freeaiapikey`, **no `/api` suffix** — their OpenAI surface is `/v1/*` directly). Added 2026-08-04. Opt-in per id via `freeaiapikeyModels`, OFF entirely without `freeaiapikeyKey` | OpenAI **and** native Anthropic | **per token, ~half crazyrouter** |
| `groq` | `api.groq.com/openai` (`bases.groq` — the `/openai` suffix is load-bearing; the bare host is a DIFFERENT, non-OpenAI API, so dropping it does not 404, it answers wrong). Added 2026-08-04. Opt-in per id via `groqModels`, OFF entirely without `groqKey`. **Resolved FIRST of the opt-in providers** — see below | OpenAI | free |

**`groq` is the second free lane, and its ceiling is tokens-per-MINUTE, not tokens.** Read off
`x-ratelimit-*` on live replies 2026-08-04, never from docs: `llama-3.1-8b-instant` 14,400 req/day
and **6,000 tok/min**; `llama-3.3-70b-versatile`, `qwen/qwen3.6-27b`, `openai/gpt-oss-120b|20b`
1,000 req/day and **8,000 tok/min**. So it is a lane for short high-volume work — classify, extract,
rerank — and one agent transcript would spend a day's budget. Inference itself is absurdly fast
(0.01–0.04 s server-side), which is exactly what makes the minute limit the thing that bites.

Two decisions here are load-bearing:

1. **It resolves BEFORE `openrouter` and `freeaiapikey`.** `openai/gpt-oss-120b` and `-20b` are real
   ids in all three catalogues; groq serves them free and the other two bill. openrouter declines
   them today only because `openrouterFreeOnly` is on — flip that one flag with groq resolved below
   it and this lane silently stops serving the ids it was added for, at a 200 the whole way. Free
   before paid, decided by POSITION rather than by a flag nobody re-reads.
2. **`groqModels` excludes the non-chat ids on purpose.** Groq advertises 15 ids on one base and
   only some are chat models: `whisper-large-v3*` transcribe, `canopylabs/orpheus-*` speak,
   `meta-llama/llama-prompt-guard-2-*` are 512-token classifiers. Routing one of those to
   `/v1/chat/completions` fails — for an id that would otherwise have reached a provider that
   answers. The seed is the four verified on the real path plus `gpt-oss-20b`. Verify before adding.

**Structured output on groq — measured 2026-08-04, and the two modes behave differently.**

| id | `json_object` | `json_schema` |
|---|---|---|
| `llama-3.1-8b-instant` | ✅ | ❌ 400 `does not support` |
| `llama-3.3-70b-versatile` | ✅ | ❌ 400 |
| `openai/gpt-oss-120b` / `-20b` | ✅ | ✅ |
| `qwen/qwen3.6-27b` | ❌ **never** | ❌ 400 |

Two things fall out of that and both are load-bearing:

1. **`json_object` requires the literal token "json" in the messages** — OpenAI's rule, inherited by
   groq. Without it the upstream answers `400 'messages' must contain the word 'json' in some form`,
   so **every** json_object call to a free lane failed until `jsonenforce.js` started appending the
   instruction (case-insensitive; a prompt that already says json is left byte-identical). The
   `response_format` field still goes with it — the sentence only gets past the gate, it is not a
   replacement for the constraint. `local` is exempt: llama.cpp has no keyword gate and selects its
   slot by prompt-prefix similarity (`selected slot by LCP similarity` in its log), so appending
   there would cost cache reuse and buy nothing. Pinned in `wire.test.mjs`, both halves, probed.
2. **`qwen/qwen3.6-27b` cannot do structured output at all.** It leaks a raw `<think>` block into
   `content`, which fails groq's OWN validator before the router sees a body — `Failed to validate
   JSON. Please adjust your prompt.`, which blames the prompt for a model defect. Nothing the router
   can strip. Don't route JSON work there; it is fine for prose.

**`openai/gpt-oss-*` are REASONING models and will return `content: ''` on a small `max_tokens`.**
Measured through the router 2026-08-04: `max_tokens: 24` → `''`; `max_tokens: 400` → the right
answer, `finish_reason: stop`, and `reasoning_tokens: 40` spent before the first content token. Same
shape as the local qwen trap, and **deliberately NOT given an `applyLocalThinkingDefault()`-style
shim** — the model is not broken, the budget was too small, and a shim here would be speculative
code on a path that works. If a caller does hit it, the fix is their `max_tokens`, not this router.

Unlike `freeaiapikey`, groq's ids are **bare** (`llama-3.1-8b-instant`), so the `vendor/model` shape
that keeps the Max pool off that provider does not apply here. What keeps it safe is branch order —
`isClaudeModel()` resolves before every opt-in provider — and `test/groq.test.mjs` pins that even a
hand-written `claude-opus-5` in `groqModels` still loses to `claudecode`.

**`freeaiapikey` is a cheaper reseller of the same frontier ids, and the reason it is worth a
provider is arithmetic.** Measured against crazyrouter's live pricing API on 2026-08-04 (USD/1M,
in/out): `openai/gpt-5.6-sol` 1.70/7.50 vs 3.25/19.50; `anthropic/claude-opus-5` 1.60/6.75 vs
3.25/16.25; `anthropic/claude-sonnet-4.6` 0.80/3.00 vs 1.95/9.75. Roughly half the input and a third
of the output, for ids `cloudPolicy: "open"` was already forwarding to crazyrouter.

Six things about it, and none of them errors:

1. **The written list IS the guard.** Every id they serve is metered — there is no free tier here to
   police, which is why this provider needs no catalogue refresh and no module of its own.
   `freeaiapikeyModels` is seeded with their ten live ids and is config, never code; an id not in it
   never routes here. An **explicitly empty list disables the provider without deleting the key** —
   the opposite reading from `imageTemplateModels`, on purpose.
2. **Their ids are `vendor/model` and ours are bare, and that difference is load-bearing.**
   `anthropic/claude-opus-5` is a different string from `claude-opus-5`, so `isClaudeModel()` never
   sees theirs and the flat Max subscription cannot leak onto a metered relay. Do not "tidy" the
   prefixes off. The branch also sits BELOW `claude-*`, so even a bare id hand-written into the list
   loses to the subscription (pinned by the suite).
3. **It sits after `openrouter` and before the crazyrouter fallthrough.** The two catalogues OVERLAP
   on every id — `anthropic/claude-opus-5` and `openai/gpt-5.6-sol` are real on both. openrouter is
   free-only by default and these are paid there, so it declines them today; turn `openrouterFreeOnly`
   off and openrouter starts winning them at full list price. Free before paid, cheap paid before
   dear paid.
4. **⚠ IT DOES NOT CACHE PROMPTS, whatever their docs say — and that alone rules out the one use
   they are cheapest for.** Their documentation states "We fully support native Anthropic SDKs and
   prompt caching". Measured on the wire 2026-08-04: a native `/v1/messages` call carrying a ~13k-token
   system block marked `cache_control: {type: "ephemeral"}` came back with **no
   `cache_creation_input_tokens` and no `cache_read_input_tokens` field at all** — real Anthropic
   always returns both, as 0 if unused — and the identical second call reported `input_tokens: 0`.
   So there is no cache, and no way to observe one if there were. Our claudecode traffic runs
   **89-96% cache reads** (trap #8), so moving it here would multiply the real input volume by
   roughly 10x against a per-token bill, to save a subscription that is flat. **Never point
   claudecode work at this provider.** Cheap bulk single-shot work is what it is for.
5. **⚠ Their usage accounting is fabricated, and `temperature` is ignored.** Same session: a native
   call reported `input_tokens: 0`; the prompt `"hi"` reported 1,762; the same 20-token prompt
   reported 620 / 0 / 2,247 / 1,855 across four ids; and the ~13k-token body above reported 2,160.
   Two identical `temperature: 0` calls returned different completions, so sampling params are not
   passed through faithfully either — which also means a "same answer twice" fingerprint proves
   nothing here. **Do not trust `usage` from this provider for cost attribution**, and do not expect
   determinism.
6. **⚠ At least one id is provably NOT the model it names.** `openai/gpt-4o` returns a `reasoning`
   field in every response (real GPT-4o has no reasoning mode) and scores like a frontier reasoning
   model on a battery real GPT-4o would not pass — `4831*27-8964`, the weekday of 2000-01-01, and a
   letter count, all correct. Every id shares that same envelope (`content` + `reasoning` + `role`)
   and all of them score alike, which is what a single backend behind ten labels looks like. What is
   NOT established is which model that is: black-box probing separates a frontier model from a weak
   one, and cannot separate two frontier ones, so "is `anthropic/claude-opus-5` really Opus 5" is
   still open and was not answered by scoring it 5/5. The responses are re-synthesized rather than
   proxied — message ids are `msg_<24 hex>`, not Anthropic's `msg_01…`, and the Anthropic surface
   returns `thinking` blocks that were never requested. Treat the model identity as unverified, and
   pin nothing here that has to be a specific model.

   It is a brand-new vendor (signed up 2026-08-04) with a WhatsApp-founder support channel.

**`openrouter` is the one provider that decides for itself which ids it will take, and the guard is
the whole design.** Their catalogue is ~330 models on ONE base URL and ~17 are free, so
`src/openrouter.js` refreshes the live catalogue (boot + 6h, same pattern as `claudecodeModels`) and
`openrouterTarget()` claims an id only if the catalogue lists it AND `openrouterFreeOnly` passes.
Free is read two ways because they mark it two ways — the `:free` suffix, and `pricing.prompt` AND
`pricing.completion` both `"0"` — and an ABSENT pricing block is *unknown*, never free.

Five things here bite, and none of them errors:

1. **No key = the provider claims nothing.** Not a 401 — null, so the id takes the route it took
   before openrouter existed. A half-configured provider that swallowed ids and 401'd would be an
   outage nobody could attribute. Same for a missing base.
2. **It sits BELOW `claude-*` and ABOVE the crazyrouter fallthrough.** Below, because
   `openrouterModels` is hand-written: put `claude-opus-5` in it with the branches reversed and the
   whole Max subscription quietly bills through a metered relay at a 200. (Their resale id
   `anthropic/claude-opus-5` is a different string and IS routable — that is fine and deliberate.)
   Above, because `cloudPolicy: "open"` forwards anything, so a free id must be claimed before
   crazyrouter bills per token for the same answer.
3. **Do NOT route on "the id has a slash in it".** `wrappy/claude-sonnet-5`,
   `crazyrouter/claude-sonnet-5` and `anthropic/claude-sonnet-5` are all real ids in this router's
   own call log meaning something else entirely.
4. **A failed catalogue refresh keeps the previous catalogue** — including a 200 carrying
   `{"data":[]}`, which is indistinguishable from an outage here and would un-route every free model
   at once. Same rule, same reason, as `registry.js`'s refresh.
5. **The key rides `authToken`, never `injectKey`.** `injectKey` is hard-wired to
   `CFG.crazyrouterKey` in `buildHeaders` — reusing it hands our crazyrouter credential to
   openrouter.ai and 401s in a way that reads like a routing bug.

**Their rate limits are per ACCOUNT, not per key** — "Making additional accounts or API keys will
not affect your rate limits, as we govern capacity globally" (their docs). 20 req/min, and 1000
req/day once ≥$10 lifetime credit has been bought, which our account already has. **Minting more
keys buys nothing**; don't go looking for headroom there. `local` is the free capacity we own.

**There is a fifth upstream, and it is deliberately not in `PROVIDERS`: `images`.**
`CFG.bases.images` (`IMAGE_BASE`, code default `https://sdturbo.bofrid.dev`) with its own
`CFG.imageToken`, serving `POST /v1/images/generations` plus `GET /v1/templates` and `GET /v1/loras`.
**Prod points at `https://sdturbo-ww.blpk.cc` (verified 2026-07-27) — the service moved off pbox and
the code default is dead, answering 503.** Read `bases.images` from `/api/state`; do not trust the
default in `config.js`. Repo: `devdashco/sd-turbo-service` (github only, no GitLab project), and it
is **not in the fleet Coolify** — `coolify_find` returns nothing for it, and pbox has no such
container, so its logs are only reachable from the box that serves it.

**The name is a lie.** It has never run SD-Turbo. Since 2026-07-28 it serves **NVIDIA SANA-Sprint
0.6B** (`Efficient-Large-Model/Sana_Sprint_0.6B_1024px_diffusers`), distilled to 2 steps with no
speed LoRA in the path at all; `MODEL_KIND=sdxl` still selects the old SDXL 1.0 + SDXL-Lightning
8-step path for a card with the VRAM. Ask `/health` — it names the checkpoint, the kind and the host. `imagegen` is the canonical public id (generic on purpose — the
checkpoint behind it is ours to swap), `sdxl-lightning` is the honest id for what is loaded, and
`sd-turbo` is a legacy alias. All three live in `IMAGE_MODEL_IDS`; the service's `/health` names the
base checkpoint AND the speed LoRA, so ask it rather than inferring weights from an id.

It is left out of `PROVIDERS` on purpose — it is **not a routing target**: it is picked by PATH,
never by model id, it speaks its own request shape, and it bills GPU seconds rather than tokens.
That is also why an image id on a *text* endpoint is a refusal (invariant: never let an image id fall
through to crazyrouter and come back as their 404, on our bill) while the same ids are legitimate on
the image path. **`IMAGE_MODEL_IDS` must gain an entry the same day the service serves a new id** —
the one that is missing is the one that reaches crazyrouter, per token, for a 404.

**One request at a time, upstream.** One GPU, one `diffusers` pipeline, and sync `def` handlers in
FastAPI's threadpool: concurrent calls were swapping each other's LoRA adapters mid-render and
raising from inside CUDA. Measured 2026-07-27 on `/v1/images/generations`: 94×200, 47×500, 145×502
in one hour, the 500s arriving ~18s in (after real GPU work) and the 502s in ~66ms (origin simply
gone). A `GPU_LOCK` around select+render is committed in that repo but **not deployed** — no ssh to
the box from pbox, so someone with access has to ship it. **The router now holds the other half of
that lock** (`src/gate.js`, 2026-08-01): image renders are serialised at THIS end, one at a time, so
the adapter swap cannot happen even while the upstream fix sits unshipped. Deploying `GPU_LOCK` is
still worth doing — it also covers callers that reach the service without going through this router.
It still writes `provider='images'` rows to the call log, so it IS subject to the
retention prune (`NOT IN ('anthropic','claudecode')`) — that is intended; only Claude Code chats are
exempt. Don't "fix" the taxonomy by folding it into `PROVIDERS`; the exclusion is the design.

**And a fifth thing sharing that path: image TEMPLATES (2026-07-27).** A template here is a
reference *picture* plus a standing style instruction, rendered by an image-capable model on
crazyrouter (`imageTemplateModels`, seeded `nano-banana*`) — SDXL cannot do it because it never sees
a picture. `POST /v1/images/generations` with a `template` this router knows is rewritten into a
multimodal `/v1/chat/completions` against crazyrouter (`targetPath` on `proxy()`, so the call-log row
still carries the path the CALLER used) and the reply is forwarded verbatim: an image model already
answers in the OpenAI images envelope. **Three things here are load-bearing, not preferences:**

1. **`template` picks the upstream, and an unknown name falls THROUGH to SD-Turbo untouched.**
   SD-Turbo has its own `template` vocabulary on the same field and the same path. Route on "is this
   one of ours", never on "is this field present", or every SD prompt template 404s the day this ships.
2. **This is the ONLY route under `/v1/images/*` that authenticates**, because it is the only one
   that spends money — the rest are our own GPU and are anonymous on purpose. Invariant 3 in image
   form. A caller's model id is checked against `imageTemplateModels` for the same reason: without it
   `{"template":"bobbo","model":"claude-opus-5"}` bills per token and answers an images endpoint with
   a chat completion.
3. **It is paid by its OWN upstream token, `imageTemplateKey`** (`IMAGE_TEMPLATE_KEY`, empty = fall
   back to `crazyrouterKey`). Image-model access on crazyrouter is granted per TOKEN, not per
   account: the router's main key is valid, bills fine for text, and still answers `This token does
   not have access to model gemini-2.5-flash-image`. Swapping the main key would have moved every
   text call onto another account's bill to fix an image path. The live value is in keyvault at
   `crazyrouter/API_KEY`.
4. **The picture lives on OUR volume** (`/data/image-templates/<slug>.<ext>`), fetched once at create
   time. The seven templates came out of the ecosystem CMS's `sanity.image_templates` — the point of
   moving them was to stop every image call depending on that Supabase bucket, so storing the URL
   would have moved nothing. `assets/image-templates/` is the committed copy and re-seeds an EMPTY
   store only (a fresh volume), so a deliberate delete stays deleted. Re-sync from the CMS with
   `node scripts/import-cms-image-templates.mjs`; it also shrinks references to 1280px/JPEG, because
   the reference is base64'd into every request and the CMS held a 4.7 MB PNG.

### Admission control — the queue in front of the GPUs (`src/gate.js`, 2026-08-01)

A burst is serialised **per provider**, and only where the upstream is one piece of hardware.
Defaults: `images` **1** (one `diffusers` pipeline), `local` **4** — which matches the server:
`-np 4 -c 65536`, read off the container's own `Config.Cmd` on 2026-08-04. **This paragraph
previously claimed 6 "verified live off `/slots`" and that was wrong in a way worth recording**:
`/slots` requires the server's `--api-key` and answers `401 {"error":{...}}` without it, and an
error object counted as one element is also how the same check can report "1 slot". Neither number
was ever real. Read `docker inspect --format '{{join .Config.Cmd " "}}'`, or pass the key — an
unauthenticated `/slots` cannot tell you anything about parallelism.
**The number must track the server, and getting it wrong is silent both ways** — a gate below
`-np` idles part of the GPU while callers queue, and a gate above it rebuilds the header-timeout bug
the gate exists to prevent. Neither errors. `claudecode` and `crazyrouter` are **0 — ungated on purpose**: they run their own
concurrency and their 429 is a signal to surface, not absorb (invariant 2). Queueing them would add
latency to calls that are legitimately parallel and turn "you are out of quota" into a silent wait.

Four things are load-bearing:

1. **The slot is released on the RESPONSE ending, not on `proxy()` returning.** `proxy()` resolves
   the moment it wires `r.pipe(res)` with the whole streamed body still to come, so a release there
   hands the GPU to the next caller mid-render — i.e. rebuilds the exact bug. `res` `"close"` is the
   one event that fires on every ending: finished, errored, hung up.
2. **Gating `local` is about the CLOCK, not about crashing.** llama.cpp queues past its 2 slots
   itself and never falls over. But its queue wait runs inside `UPSTREAM_HEADER_TIMEOUT_MS`, which
   starts at `fetch()` — so in a burst of 100 the ones at the back burn their whole 120s budget
   waiting for a slot and 504, for work the model would have done. Waiting in the router instead
   means the header budget starts when the request actually reaches the model.
3. **A queued caller that hangs up is dropped from the queue.** Cloudflare abandons at 100s;
   rendering for a dead socket spends the GPU on nobody, and spends it *ahead* of callers still
   waiting.
4. **The queue is bounded and the refusal is a 503**, never a substitution and never an unbounded
   wait: `GATE_QUEUE_MAX` (100) per provider, `GATE_WAIT_MS` (300s), then
   `503 {code: "<provider>_busy"}` + `Retry-After`.

Limits are **env, not `CFG`** — they describe hardware on the other end, which does not change from
the panel. `GATE_<PROVIDER>` overrides any of them; `0` means ungated. Live state (`active`,
`queued`, `peakQueued`, `refused`) is on `GET /api/health` under `gates`, reported for every gated
provider even at zero traffic — "absent" and "unlimited" must not look alike there.

The image *catalog* GETs (`/v1/templates`, `/v1/loras`) are deliberately ungated: they touch no GPU,
and queueing a template list behind a 20s render would cost real usability for nothing.

Legacy ids still migrate on read: `cloud`→`crazyrouter`; `claude`/`anthropic`/`wrappy`→`claudecode`.
The old subprocess wrapper is **deleted** — the router now calls the real Anthropic API with a pinned
account's `sk-ant-oat…` token. Don't reintroduce the old name; the only place it survives is the
`LEGACY_PROVIDER` key map, which must keep it so pre-rename `config.json` files still load.

The field is `provider` everywhere. `lane` was the old word and is **still read** on input
(`providerOf()` accepts `{lane}` or `{provider}`), because `/data/config.json` on the volume predates
the rename. Pre-rename call-log rows carried `provider='anthropic'`; new ones carry `'claudecode'`.
**Counted in prod 2026-07-26: zero `anthropic` rows remain** against 450k `claudecode` — the value
was fully migrated, so a query filtering on `'claudecode'` alone is not missing history today. Keep
the retention prune matching **both** anyway (`NOT IN ('anthropic','claudecode')`): it is what makes
Claude Code chats exempt from pruning, and a row carrying the old value would be deleted the moment
that list stopped naming it. Don't go "fixing" analytics queries to add `'anthropic'` back — there is
nothing there to find; this note used to imply otherwise and cost a detour to disprove.

Routing lives in a mutable `CFG` seeded from env, overlaid with `/data/config.json` on a persistent
volume, editable live from the panel at `/`. Changes apply without a redeploy.

### Per-project rules — pin vs allowlist

`projectRoutes[<consumer>]` carries **two independent axes**, and they are not the same thing:

| field | what it does | on mismatch |
|---|---|---|
| `provider` + `model` | the **pin** — rewrites the request | n/a |
| `allowProviders` / `allowModels` | the **allowlist** — restricts where it may resolve | `400 blocked`, never a substitution |

A rule may carry either, both, or neither (neither = the entry is dropped). An empty or absent list
means *no restriction*, never "nothing allowed" — the opposite makes a mistyped save an outage.
The allowlist **refuses, never rewrites**: silently serving an allowed model instead is exactly the
cross-provider substitution invariant 2 forbids.

**A pin's `model` is a LITERAL string, and it outranks `CFG.localMap`.** So swapping the local
checkpoint is a FOUR-place change, not one: the Coolify service, `GATE_LOCAL` + `gate.js`,
`localMap`, and **every `projectRoutes` pin naming the old model id**. Measured 2026-08-02 on the
gemma→Qwen swap: `localMap` was updated and `dev`/`autonoma` still carried
`{provider:"local", model:"gemma-4-26b"}`, so those two — the highest-volume local consumers — kept
logging `sent_model=gemma-4-26b` while Qwen answered every one of their calls. Nothing errored,
because llama.cpp ignores the model name in the body and serves whatever is loaded. The tell is a
call-log row whose `req_model` and `sent_model` disagree with `/props`; the fix is merge-safe
`POST /api/routes`. A consumer carrying only an `allowModels` list is unaffected — most already
list both ids, which is why the swap did not 400 anybody.

**A rule is resolved like `accountFor()`: exact path → consumer.** So a rule on `promopilot`
covers `promopilot:generatetext`. Before 2026-07-09 `projectRoutes` matched the literal string only,
so every job path silently ignored its own project's pin and fell through to crazyrouter, per token.
There is **no cross-consumer group layer** — bundling many consumers under one rule was `projectGroups`,
removed 2026-07-12; grouping is the consumer's job (name them alike, pin each), not the router's.
Pinned model ids are **not** validated against the catalog — Anthropic ships
ids without asking; that is `claudecodeModels`' job, not this one.

Edit **one** rule with `POST /admin/api/routes {project, …}` — it merges. `POST config` assigns
`projectRoutes` wholesale and a save built from a stale render deletes every other project's rule
(same hazard as `pins`, same door).

**None of this lives in Postgres.** Postgres holds the *call log* and nothing else. Every rule, pin,
consumer, key hash and account token is a key in `/data/config.json` on the app's volume.

## Direct-connect telemetry — the calls this router never sees

`cccc/shell/gateway-route.sh` is FAIL-OPEN: router unreachable, or `.cccc-force-direct` set, and
`claude` talks to `api.anthropic.com` straight. Same Max subscription, same tokens, **no call-log
row** — the panel then reads "no traffic" for a window where the truth is "traffic we cannot see".

Closed on 2026-07-29 by ingesting Claude Code's own OTel stream: the direct branches export
`CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=<router>/otel/v1/logs`, and
`src/otel.js` turns each `claude_code.api_request` event into a row. Four things are load-bearing:

1. **Only the direct branches export it.** The `up` branch calls `_cctl_otel_off`. A routed box that
   also shipped OTel would have every call logged twice — once by `proxy()`, once by the ingest —
   and every usage number would be a lie in the safe-looking direction.
2. **Logs, not metrics.** `claude_code.token.usage` is a counter aggregated over an export window; it
   can total tokens but cannot say which CALL they belong to. `/otel/v1/metrics` answers 200 and
   drops the payload, only so a box pointed at a bare `OTEL_EXPORTER_OTLP_ENDPOINT` stops retrying.
3. **`http/json`, because the router is zero-dep** and cannot decode protobuf. The wrong protocol
   gets a 400 naming the env var to change, never a 500.
4. **The row is tagged `<consumer>:direct`** and identity comes from the **key**
   (`OTEL_EXPORTER_OTLP_HEADERS`), never from a resource attribute. `user.email` is mapped through
   the pool's `email` field to our account name for `key_label` — no match keeps the raw email
   rather than inventing an account. These tokens passed no pin, no allowlist and no cache
   breakpoint; folding them in under the bare consumer name would make half of `pbox` silently stop
   meaning "went through the router".

## Invariants — do not "improve" these away

These are load-bearing decisions, not oversights. Each one was a bug once.

1. **One project → one account. No rotation, ever.** `accountFor(project)` reads
   `projectAccounts[project] || defaultAccount`. No header can override it. Rotating accounts blows
   the per-org prompt cache (~12× cost) and makes "who spent this?" unanswerable after the fact.
   **One narrow, opt-in exception (2026-07-12):** `accountStrategy: "soonest-weekly-reset"` serves
   **app**-kind consumers from the usable account whose 7d window resets soonest (`autoAccount()` in
   `routing.js`; flipped via `POST /api/claudecode/strategy`, shown in `state.autoAccount`). It hops
   roughly weekly (reset7 timestamps only move when a window rolls), never per request; devs keep
   their pins; attribution still lands in `key_label`; with no weekly reading anywhere it falls back
   to the pin — it never hops blind. When the strategy is on, `server.js` sweeps
   `refreshAccountLimits()` over the pool every 30 min so every account's reset7 stays honest (gated
   on `accountStrategy !== "pinned"`, not on the one name, so the mode below gets fresh readings too).

   **A second, wider exception (2026-08-04): `accountStrategy: "any-available"`** — the same
   selection applied to **every** caller and to callers with **no pin at all**. This is the "stop
   making me pick an account" mode, and it knowingly waives two things that are otherwise invariants:
   invariant 3's 403 (a typo'd or unregistered consumer is now *served*, not refused) and a dev's
   stable account (a hop is a full per-org prompt-cache miss, and `pmac`/`pbox` run ~95% cache hits).
   Both are the price of the behaviour, not oversights — hence still opt-in and still not the
   default. The pick remains STABLE (deterministic by name), so it moves when an account's state
   changes, never per request; a disabled or dead login is still never served; and when nothing in
   the pool is usable it returns null so the caller gets the honest 429/403 rather than a request
   fired at a dead subscription. "Any available" is not "any".
2. **No fallback. Anywhere.** A 429 means the pinned account is out of quota → the caller is told.
   A 5xx means upstream failed → the caller is told. Answering anyway with a different model on a
   different provider (the old wrapper→crazyrouter path) hid both the cost and the truth.
3. **An unpinned project gets `403 no_account_for_project`**, and the error body lists the projects
   that *are* pinned. Never bill a guess. (Waived, deliberately and only, by
   `accountStrategy: "any-available"` — see the note under invariant 1.)
4. **`claudecode` request headers are synthesized, never inherited.** A Max setup-token is rejected
   without `anthropic-beta: oauth-2025-04-20` + `anthropic-version` + a `claude-cli` UA. Trusting the
   caller to send them is why only real Claude Code ever worked on that path.
5. **Native `/v1/messages` is forwarded byte-for-byte.** Only OpenAI `/v1/chat/completions` on the
   `claudecode` provider is translated. Touching a native body loses tool/thinking fidelity and
   breaks Claude Code's prompt cache.
6. **Model ids are config, never code** (`claudecodeModels`). Anthropic ships new ids without asking.

## Identity — developers, machines, projects

**Three entities, and the rules are enforced by Postgres, not by application code.**

| entity | what it is | has an owner? |
|---|---|---|
| `developer` | a person — `philip`, `william` | — |
| `machine` | a person's box, or a daemon on it — `pmac`, `wmac`, `pbox`, `lprod` | **yes**, a developer |
| `project` | code we deployed — `promopilot`, `redbut` | **no** — an app is not a person |

Machines and projects share ONE table, `consumers`, with one UNIQUE name: both are *callers*, both
appear on the wire as `<name>[:<job>]`, both can hold a key. Two tables would be two namespaces and
`pmac` could exist as both. `kind` distinguishes them; a CHECK constraint enforces "a project has no
owner"; `developer_id` is `ON DELETE RESTRICT`. Verified by inserting directly, bypassing the API.

**`src/registry.js` is the ONLY writer.** The DB is the source of truth; `refresh()` projects it into
`CFG` (what requests read) and mirrors it to `/data/config.json` (so a cold boot with the DB down
still authenticates). `authenticate()` never touches Postgres.

**A registry write with no DB refuses with 503.** It used to write `CFG` — the legacy
`POST /api/consumers/keys` issued a key that authenticated until the next registry write and then
silently vanished (reproduced 2026-07-10, fixed in `c385a5e`). Pure validation still answers without a
DB, so a caller's error is about their request, not our infrastructure.

**Keys live in keyvault** at `llm/<consumer>/API_KEY`, one per consumer, issued 2026-07-10.

## Identity — the wire format

**A consumer is WHO calls.** Exactly two kinds, and they are not the same thing:

| kind | what it is | has an owner? |
|---|---|---|
| `dev` | a person's machine, or a daemon on it (`pmac-claude`, `lprod-autofix`) | **yes** — a human |
| `app` | code we deployed (`promopilot`, `redbut`) | **no** — an app is not a person |

Giving an app an owner is how "what do my developers cost" quietly starts including cron jobs.
`POST` an owner for an app and you get a 400, not a silent drop.

**Identity is a path: `<consumer>[:<job>]`.** `promopilot:generatetext` is consumer `promopilot`,
job `generatetext`. This convention already existed in the data; nothing parsed it, so `promopilot`
read as *4 calls* while its three workloads had ~30k between them. Split on the **first** colon only.

**Only the consumer is registered. Jobs are free.** A new workload needs no config change — that is
the property that keeps this sustainable. `accountFor()` resolves an exact-path pin first, then the
consumer's pin, so pinning `promopilot` covers every job while one greedy job can still be split out.

**Issuing a key IS registering.** One call, `POST /admin/api/consumers/keys {name,kind,owner?}`,
creates the consumer if absent and returns the only copy of the secret. Two steps — register a name,
then separately authenticate — is precisely what let a self-asserted header masquerade as identity.

**A whole APP is one call: `POST /api/apps {name, tier?, note?, models?, pin?, account?, allowUa?}`.**
It issues the key AND writes the routing rule, because the rule is the half that got forgotten: a
consumer with no `projectRoutes` entry is *unrestricted*, so every app registered in a hurry could
reach opus on the shared Max pool. The allowlist is a **tier resolved against the live catalogs**,
never a literal a caller types — `standard` (default: everything except the premium claudecode ids),
`frontier` (plus opus/fable — and it warns, which is why it has a name), `local` (the free GPU only),
`any` (no allowlist — also warns). `models:[…]` overrides the tier. That is what stops the
twelve-model list prod carries twelve times, hand-copied and naming ids no upstream serves any more.
Three properties are load-bearing: the **rule is written BEFORE the key** (issuing it refreshes the
registry, which persists, which is where the premium watcher looks — so key-first would page about
every new app for the instant before its rule landed); a failed create **rolls the rule back** rather
than leaving an orphan; and an unreachable crazyrouter catalog is **reported** (`catalogWarning`),
never silently a shorter allowlist. See `createApp()` in `src/consumers.js`, `test/apps.test.mjs`.

Wire format `sk-llm-<id>-<secret>`. `id` is public (an 8-char handle, so lookup is a map hit, not a
scan over every hash); `secret` is never stored, only its sha256. The consumer name is deliberately
**not** in the key: it would leak who we are, and a name containing `-` (`pmac-claude`) makes the key
unparseable. Accepted as `Authorization: Bearer` (OpenAI clients) **or** `x-api-key` (Anthropic SDK on
native `/v1/messages`). The caller's inbound `authorization` was always discarded by `buildHeaders()`,
so the field was free.

**A valid key outranks anything the caller says about itself.** The consumer comes from the key; only
the *job* half of `X-Project` (or an `X-Job` header) is still taken on trust — a job is a label inside
an already-authenticated consumer, so it cannot bill someone else. Verified: a request bearing acme's
key and `X-Project: victim` logs as `acme`.

### A key is a bearer credential — `allowUa` is what stops it being shared

Nothing on the wire distinguishes "philip's laptop" from "an app holding philip's key". Measured in
prod 2026-07-29: **`pmac`'s key ran 11,485 calls / 22.9M tokens in 7 days from `85.194.137.213`
(hexabyte-bluebut-prod) with a `node` user-agent**, while `bluebut` sat in the registry with a key of
its own; `pbox`'s key showed the same shape from a `Python-urllib/3.12` client (1,399 calls, 20.7M
tokens). Nothing was broken — every call authenticated and logged — the spend just landed under a
person. That is how "what do my developers cost" starts including production traffic.

`consumers[<name>].allowUa` is a list of user-agent PREFIXES that consumer's key may be presented
with (`uaAllowed()` in `identity.js`, enforced beside the auth gate in `server.js`, stored in the
`consumers.allow_ua` column and projected into `CFG` by `refresh()`). Load-bearing:

- **Empty or absent = unrestricted**, never "nothing allowed" — same rule as the routing allowlist.
- **It REFUSES (403 `client_not_allowed_for_key`), never re-attributes.** Billing the call to
  whichever consumer it "should" have been is the cross-provider substitution of invariant 2 in
  identity form.
- **Opt-in per consumer.** A blanket "dev keys are claude-cli only" would 403 the daemons that are
  legitimately dev-kind (`lprod-autofix`, `pmac-claude`) on the day it shipped.
- **The sanitizer in `config.js` must keep the field.** The mirror is what a cold boot with the DB
  down authenticates from; a dropped field takes the lock off every key exactly when nobody is
  watching. It was dropped in the first cut and `test/keypolicy.test.mjs` caught it.
- A user-agent is self-asserted: this stops SHARING, not an attacker. The deterministic upgrade is an
  IP allowlist, which a fixed-address consumer can have and a laptop cannot.

**Read before locking: `GET /api/consumers/clients?days=7`** — every distinct UA + IP per consumer
with call/token counts and `wouldBlock` (null = *no policy*, which is not the same answer as
*allowed*). Setting a policy blind 403s a live caller; this endpoint exists so that is a decision.
Set with `POST /api/consumers/policy {name, allowUa:[…]}` — merge-safe, one consumer per call, logged.

### Two gates, and what each one is for

- **`auth.mode`** (`off` | `optional` | `required`) — the lock.
  `optional` is migration mode: a valid key wins, no key falls back to the header, and a key that is
  *presented and bad* is always a 401 (otherwise a revoked key silently keeps working under its old
  name). `required` is the only mode that closes the hole. **Ships `optional`; prod is `required`
  (verified 2026-07-26) — the migration is done.**
- **`requireRegisteredConsumer`** — a spelling check, not a lock. Only applies to calls with no key;
  refuses an unknown consumer with `403 unknown_consumer` so a typo can't become a new consumer with
  its own bill. Redundant once auth is `required`. Ships off; **it is ON in prod as of 2026-07-30** —
  this said "off, verified 2026-07-26", so someone turned it on since. Harmless either way while auth
  is `required`: it only ever reached keyless calls, and there are none.

Both are flipped through their own logged endpoints (`POST /admin/api/auth`,
`POST /admin/api/consumers/enforce`), never through `POST config`, because turning either one on with
an unseeded registry is an instant outage. The panel refuses to do it blind: it names the consumers
that would start failing (`keyless` in the `consumers` payload).

### Gotchas

- **`POST /admin/api/config` does not touch `consumers`** — deliberately. It assigns its fields
  wholesale, and a panel save built from a payload with no hashes would wipe every key.
- **`adminState` redacts.** The registry entry carries key hashes; `/admin/api/state` and
  `/admin/api/consumers` return `activeKeys` and the public `id`, never `hash`.
- **`reindexKeys()` is called from `persistConfig()`**, so no writer has to remember to, and a stale
  index can never authenticate a revoked key. `KEY_INDEX` is declared near the top of the file, far
  from its own functions, because `loadConfig()` reindexes at module scope — a `let` beside
  `authenticate()` is still in its temporal dead zone when that call runs, and the process dies on boot.
- **`lastUsed` is approximate.** Persisting it inline would mean a disk write per inference, so it is
  flushed on a 5-minute timer. Never treat it as an audit trail.

## Translation

`translate.js` — pure functions, no I/O, so it is unit-testable in isolation. It handles eight traps
that each silently corrupt output or cost if skipped: Anthropic *requires* `max_tokens`; there is no
system turn (hoist it); OpenAI emits one `tool` message per result but Anthropic wants them batched
into a single user turn; `input_json_delta` streams partial JSON (forward verbatim, never parse
mid-stream); `thinking_delta` must not leak into OpenAI `content`; a tool-only turn still needs
`finish_reason: "tool_calls"`; cache tokens have no OpenAI home but cost accounting needs them.

**Trap #8 — nothing on this path was cached until 2026-07-25.** Anthropic only caches a prefix you
mark with `cache_control`. Native `/v1/messages` callers (real Claude Code) mark their own, which is
why `pmac`/`pbox` run ~95% cache hits; anything translated from OpenAI marked **nothing**, so it paid
full price for its whole prompt every time. It stayed invisible until an agent loop arrived:
`autonoma` re-sent a 227-message / 86k-token transcript for a 42-token reply, ~113 times per verdict,
at `cache_read=0` — **1.53B uncached input tokens in 7 days**, ~150× every dev box combined, which
drained the Max pool to 4-of-7 accounts rejecting. `markCacheBreakpoints()` marks the **tail** of each
prefix section (Anthropic hashes tools → system → messages, and a breakpoint caches everything up to
itself, so tail-marking chains them), plus two rolling breakpoints on the conversation tail — this
request's tail is the next one's stable prefix. Live traffic went 0% → **96–99%** cache hits.
**0% cache on the translated path is not automatically trap #8 coming back — measure the SHAPE
before believing it.** Measured 2026-07-30: `/v1/chat/completions` showed 0.0% cache reads and zero
cache WRITES over 3,603 calls in 24h, against 89.6% on native `/v1/messages`. That reads exactly
like the regression, and it is not one. 3,501 of those calls average ~1k prompt tokens — below the
floor, correctly skipped. The remaining 90 are `skyvern`, and one of its real bodies is a **1,854-byte
system prompt plus a single 3.78 MB user message** (page text and screenshots). `markCacheBreakpoints`
marks the system tail and stops: with 2 messages it is under the 3-message floor, so it never marks a
conversation tail. The one breakpoint it does place sits on a prefix far under Anthropic's minimum
cacheable size, which Anthropic ignores silently — hence zero writes as well as zero reads.
And that is the RIGHT outcome: skyvern's huge part is a new screenshot every call, so marking it
would bill the 1.25× write for something never read. The router's own size check passes on the whole
body (3.7 MB), not on the prefix being marked, which is why the numbers look alarming. Check the
message shape and the per-call prompt average before concluding anything.

Guards, each of which was a way to make it worse: a caller's own `cache_control` means hands off
entirely (their breakpoint is a deliberate choice, and a 5th is a 400); under ~8 KB skip it
(below Anthropic's floor it won't cache anyway and the write bills 1.25×); under 3 messages mark
tools/system but not a tail that will never be re-sent; and the 4-breakpoint budget is enforced by a
counter, not by hoping. **Do not add a breakpoint to the native path** — it never reaches this
function, and invariant 5 says that body is forwarded byte-for-byte.

Run `node translate.test.js` before touching it. 20 tests, no deps.

## Deploy

**Coolify builds from GitLab, and this repo has TWO remotes.** `origin` =
`gitlab.hostbun.cc/devdashco/llm-hostbun-router` (what Coolify clones — the deploy log says
`Importing ssh://…gitlab.hostbun.cc:2224/…`); `github` = github.com, a mirror **nothing deploys from**.
`git push github master` therefore looks completely successful, Coolify happily builds, and you get a
container running the *previous* commit — verified the hard way on 2026-07-25, where a full 13-minute
build shipped an image whose `src/routing.js` still had the old code. **Push to `origin`.** Confirm
what actually shipped rather than trusting "deploy finished": the deployment's `commit` field, or
`docker exec <container> grep <a string from your diff> /app/src/<file>.js`. The baked-in push token
in `remote.origin.pushurl` (`claude-mcp-scoped`) was **revoked 2026-07-25** and now 401s — the live
per-machine credential is keyvault `gitlab/pbox` (user `philip-pbox`, scopes api+write_repository).
A push to `origin` also fires Coolify's auto-deploy webhook, so a manual `?uuid=…&force=true` right
after just queues a second, redundant build of the same commit behind the first.

Pushing auto-builds when it touches a watched path — read the CURRENT `watch_paths` off the app
object (`coolify_find` / `GET /api/v1/applications/<uuid>`), never from this file. **Set 2026-07-30
to cover every file the Dockerfile actually COPIES**: `server.js`, `translate.js`, `package.json`,
`package-lock.json`, `Dockerfile`, `entrypoint.sh`, `gen-prices.sh`, `README.md`, `src/**`,
`assets/**`, `panel/**`, `docs/**`. Before that, `translate.js` and the lockfile were missing, so a
change to the TRANSLATOR — the file that decides what the prompt cache does, i.e. the 12x — shipped
nothing while the push reported success. Two such commits sat unshipped the day this was found.
The rule to keep: **if the Dockerfile copies it, it belongs here.** Still unwatched on purpose:
`archive/**`, `test/**`, `cccc/**`, `scripts/**` — none of them are in the image. Trigger the Coolify deploy for app uuid
`d11s05nc130l2kjzr6anpebr` (token in keyvault `coolify/hostbun/api-token`;
`curl "https://coolify.hostbun.cc/api/v1/deploy?uuid=d11s05nc130l2kjzr6anpebr&force=true" -H "Authorization: Bearer <tok>"`),
then **verify — never stop at `git push`**: wait for
`running:healthy`, read the boot line in the logs (`llm-gateway on :80 | providers: …`), then curl a
real request. **`running:unhealthy` during the swap is expected, not a failure** — the healthcheck
polls `/` inside the container every 5s and the old container stops answering before the new one
binds; measured 2026-07-30, it read unhealthy for ~1 minute while the public URL served 200
throughout, and settled healthy on its own. Judge it by two consecutive reads, not one.
**A curl probe with a dev key will be REFUSED, and that is the lock working**: `allowUa` on `pbox`
accepts `claude-cli…` only, so `curl` gets `403 client_not_allowed_for_key` (verified in prod, and
both refusals landed in the call log with their reason). Do not spoof the UA to get a probe
through — that is precisely the key-sharing the lock exists to stop. Probe with an unauthenticated
endpoint (`/v1/models`, `/`) or mint a key for whatever is doing the probing. The headroom sidecar is app `i7pfies89s3maf390ye3rllk`. Both live in Coolify project
`llm-hostbun-router`, alongside the `llm-proxy-archive` service (uuid `ysjpmznhdq1auwk9f3lqv8hk`).
**That archive service is now orphaned** — `ops/nas-shipper/`, the only thing that fed it, was deleted
(2026-07-09). Stop or delete the service. **`GET /api/export` is NOT dead** — despite what this line
used to say. `archive/archiver.js:78` is its caller and always has been; a dead-code sweep that
believed "no caller" would have deleted the only way the NAS archive reads the log.

`Dockerfile` copies **`src/` as a directory** but every top-level file individually. A new module
under `src/` therefore ships for free; **a new `require`d file at the repo root still needs its own
`COPY` line** or the container crash-loops on boot.

## Storage

Two very different things, and only one of them is a database.

**The call log AND the identity registry live in Postgres** — database `llmrouter`, a Coolify
standalone-postgres (`postgres:17-alpine`, uuid `b8ubtmws8mnt8viw9mg0syz2`) **inside the
`llm-hostbun-router` project on hostbun**, reached over the internal `coolify` docker network.
Moved off pbox on 2026-07-10 (it was `80.217.106.60:5435`, `sslmode=disable`, cleartext over the
public internet). DSN in keyvault at `db/llmrouter/DATABASE_URL`. Tables `calls` and `acct_limits`, created by
migration `0001_calls_and_acct_limits`. (An `acct_probes` table existed until 2026-07-11 for the
removed per-model probe; `initDb` no longer creates it, and any leftover table in prod just sits
unused.) It used to be a SQLite file on the app's volume; that file is gone. `pg` is the router's only runtime dependency, so the Dockerfile now runs `npm ci` — if you add a
dependency, the lockfile must be committed or the build fails.

**The config still lives on the volume** — `/data/config.json`. That is where the account tokens are.

**The permanent archive is on the NAS, not in Postgres** — `archive/` copies the whole `calls` log
(every conversation, tool run and token count, full `req_content`/`resp_content` verbatim) to the
MinIO `archive` bucket, gzipped and partitioned `llmrouter/calls/dt=<day>/consumer=<name>/part-<min>-<max>.jsonl.gz`,
with a resume cursor at `llmrouter/_state.json`. Postgres is the *operational* log — it prunes
non-claudecode rows to `retain` and sits on one un-backed-up volume; the NAS is where the knowledge
actually persists. Zero-dep (stdlib SigV4 in `archive/s3.js`), reads the router's own `/api/export`,
so no DB access. It is *meant* to run hourly as a **Coolify scheduled task** on `scriptbox-pbox` (not
a crontab — control-plane policy), against the LAN MinIO endpoint, beacon-monitored as
`llm-hostbun-archive`.

**It IS running again — verified live 2026-07-30.** It was dead from the 2026-07-12 backfill until
**2026-07-28**, when the Coolify scheduled task **`llm-archive`** was created on `scriptbox-pbox`
(app `s18pl11n8t4v8i4jshsy39rg`, task `om1irhhlxfglyxa6dx7v7ru9`, `17 * * * *`, enabled, running
`/home/philip/.llm-hostbun-router/archive/run.sh` — a checkout on **pbox**, not this repo). Today's
evidence, from `~/.llm-archive/archive.log` on pbox: 24 runs `rc=0` against 2 `rc=1`, the 13:17 run
finishing `{"archived_rows":22,"cursor":2331107}` against `MAX(id)=2331112` in `calls` — i.e. current
to the last few rows, not lagging. Check those two things (the task exists AND the log's last line
is `rc=0` with a cursor near `MAX(id)`) rather than trusting this paragraph; it has been wrong in
both directions.

Its failure mode is worth knowing: the two `rc=1` runs are `NoSuchBucket` on bucket `archive` —
the archiver retried 4×, failed the whole run, and the NEXT hour resumed from the same cursor and
caught up. So a single red run is not data loss, but a *streak* of them is the signal, and nothing
pages on it — the beacon (`llm-hostbun-archive`, via `BEACON_URL`/`BEACON_KEY` in `archive/run.sh`)
is the only monitor. Config in keyvault at `llm-archive/config`.

The earlier warning here — "NOT RUNNING, ~358k rows exist only on one un-backed-up volume" — was
true when written on 2026-07-26 and stale two days later. A stale alarm costs a re-investigation
every time someone reads it.

## Gotchas that will cost you a day

- **The account tokens exist in exactly one place**: `anthropicPool` / `claudecodeAccountPool` inside
  `/data/config.json` on the app's volume. Not in env, not in git, no backup. Lose the volume, lose
  the subscriptions. Back it up before touching the app, the server, or the volume.
- **⚠ The Postgres link crosses the internet again — REGRESSED, verified in prod 2026-07-26.** The
  intent below still stands; the deployed config does not match it. The router's live `DATABASE_URL`
  is `postgres://app:…@80.217.106.60:5435/llmrouter` — pbox's **public** IP, no TLS parameter — so
  every prompt, every reply and the DB password are once more going out in cleartext, over a port the
  fleet notes already list as WAN-open. Fixing this means rotating a credential and repointing a
  live DB, so it is an operator decision, not a code change; re-point at the in-project Coolify
  Postgres (`b8ubtmws8mnt8viw9mg0syz2`) on the internal `coolify` network and rotate the password.
  The intent: since 2026-07-10 the DB was moved to a Coolify resource in the same project, on the
  same box, reachable only on the internal `coolify` network — exactly to end the cleartext hop.
  **Do not point `DATABASE_URL` back at a remote host without TLS.**
- **`pg` returns BIGINT as a string.** Every `ts`, `id` and `SUM()` in this schema is a bigint. Left
  unparsed they break timestamp arithmetic and the shapes the admin UI expects. `server.js` installs
  type parsers for oid 20 (int8) and 1700 (numeric) at boot; don't remove them.
- **Postgres is stricter than SQLite was.** `GROUP_CONCAT` → `string_agg`; a bare column may not ride
  along outside `GROUP BY` (hence `MAX(provider)` in `byModel`); `json_extract` does not exist, and
  casting `user_id::jsonb` throws on the rows where it isn't JSON — the conversations view extracts
  `session_id` with a regex for exactly that reason.
- **Writes are fire-and-forget.** `recordCall` never awaits, and a failed INSERT logs a warning and is
  dropped. That is deliberate: the DB is a network hop away, and losing a log line must never fail an
  inference request. It does mean the log can silently under-count if the DB is down — watch for
  `[log] write failed`.
- **Importing rows with explicit `id` does NOT advance a `BIGSERIAL` sequence.** After the SQLite
  import the sequence still read `13`, so the first new rows got ids `1..13` — invisible in the admin
  list (it orders by `id DESC`) and on a collision course with the imported range. Any future bulk
  import must end with `SELECT setval('calls_id_seq', (SELECT MAX(id) FROM calls))`.
- **The old SQLite file still exists**, frozen, at
  `/var/lib/docker/volumes/d11s05nc130l2kjzr6anpebr-config-data/_data/calls.db` on hostbun (64,208
  rows). It is the only backup of the pre-cutover log. Read it with
  `docker exec <container> node -e '…require("node:sqlite")…'` — the host has no `sqlite3`.
- **Auth is closed on the TEXT paths and OPEN on the image ones. Both measured 2026-07-26.**
  `authMode = "required"`, and `/v1/chat/completions`, `/v1/messages` and a bad `sk-llm-` key all
  answer 401. **`POST /v1/images/generations`, `GET /v1/templates` and `GET /v1/loras` do not.** They
  are dispatched in server.js at ~line 210, fifty-odd lines *before* the auth gate at ~268, and
  `isInference` (line 240) matches only the text paths — so anyone who can reach the host can spend
  GPU seconds on the image service, unattributed. Live traffic proves it is reachable: 32 of the
  newest 40 image rows come from a `Bun/1.1.45` caller with `project=(none)` and no key.
  **Callers identified 2026-07-26** (24h: 678 calls, 2 IPs — surfaced on the Health tab):
  `135.125.243.62` = **ovh-promopilot** (Bun/1.1.45, the bulk of it) and `80.217.106.60` = **pbox**
  (a `node` process; the `curl/8.x` rows there were verification probes). **promopilot already holds
  a key** — keyvault `llm/promopilot/API_KEY`, which it uses for text — so its image path simply is
  not sending it. **Closing the gate is still a deliberate act, not a tidy-up** — but it costs less
  than it did. **Re-counted 2026-07-30: promopilot has stopped calling entirely.** Its last
  anonymous image call was 2026-07-27 (2 that day, 2,908 over the week before it); nothing since.
  The only unauthenticated image traffic left is pbox's `node` client — 13 calls today, all
  `POST /v1/images/generations`, all 200 — plus `curl` verification probes. So gating the route now
  401s ONE caller, not two, and not the high-volume one. Re-count before acting rather than trusting
  this paragraph: the shape changed twice in four days.
  **The pbox `node` caller is almost certainly `seoul/lib/imagegen-client.ts`** (traced 2026-07-26):
  it POSTs `https://llm.hostbun.cc/v1/images/generations` with `headers: { 'Content-Type':
  'application/json' }` and nothing else — no key, no `X-Project`, exactly the observed signature.
  Not proven to be the process that emitted those specific rows (it was not running when I looked),
  but the missing header is certain. `seoul` has **no valid key to send**: keyvault
  `llm/seoul/API_KEY` is a `REVOKED-…` tombstone from the 2026-07-10 registry wipe, so it needs
  minting before that client can authenticate. `funnel-sites/scripts/article-images.ts` is the
  counter-example — same endpoint, but it sends `Authorization: Bearer` + `X-Project:
  funnel-articles` and would survive the gate closing untouched.
  An earlier version of this entry said flatly "Auth is CLOSED", generalising from three text-path
  probes. It was wrong about the image paths; do not trust a posture claim that does not name the
  paths it tested. and that anyone naming a registered consumer could spend the Max
  subscriptions; that was true during the migration and is not true now. A stale security warning is
  not free — it invites re-fixing something already fixed and drowns out the warnings that still
  bite. The reasoning behind it stands: `X-Project` is **attribution, not authentication** — a
  self-asserted string, and `extractProject()` also accepts the OpenAI `user` field. An API key is
  what makes the name mean something. See "Identity" below.
- **`local` is a reasoning model.** `qwen3.5-9b` returns its thinking in `reasoning_content` and
  leaves `content` empty until it finishes. With a normal token budget it never finishes → callers get
  `''` and `finish_reason: length`, having paid for every token. The router now defaults it off
  (`applyLocalThinkingDefault()`). The knob is **`chat_template_kwargs: {enable_thinking: false}`** —
  a **top-level `enable_thinking` is accepted by llama.cpp and silently ignored**, which is why the
  obvious fix appears to do nothing. The router hoists the top-level form into `chat_template_kwargs`
  so a caller that asks for thinking still gets it.
- **`defaultAccount` quietly voids the "never bill a guess" invariant.** `accountFor()` is
  `pins[project] || defaultAccount`, so an unpinned *or misspelled* project bills the default instead
  of 403'ing. The 403 works today only because `defaultAccount` is empty in prod. Leave it empty.
- **Anthropic serves ids it does not list.** `/v1/models` shows dated ids for the 4.5 family and
  undated ids for 4.6+. The undated 4.5 forms (`claude-haiku-4-5`, `claude-sonnet-4-5`,
  `claude-opus-4-5`) are served but unlisted — and `claude-haiku-4-5` is what every caller sends.
  They live in `CLAUDECODE_MODEL_ALIASES`. **Do not derive them by stripping the date**:
  `claude-opus-4-1` 404s while `claude-opus-4-1-20250805` serves, and `claude-opus-4-8-20260528`
  404s while undated `claude-opus-4-8` serves. Verify a new id with a single native `/v1/messages`
  call before adding it — a **404 means the id does not exist**; a **429 means it exists and the
  subscription's usage window is spent** (not that the id is wrong).
- **Everything before 4.5 is 404 on a Max OAuth token** (`claude-3-*`, `claude-3-5-*`, `opus-4`,
  `sonnet-4`). Not missing from our catalog — not ours to call. Don't go looking for them.
- **`claudecodeModels` is no longer hand-typed.** `CLAUDECODE_MODEL_SEED` in `server.js` is a floor;
  `refreshClaudecodeModels()` reconciles it against `api.anthropic.com/v1/models` at boot and every 6h,
  and the config load *unions* rather than overwrites. **The catalog is per-account** — `philip` lists
  `claude-opus-4-1`, `cmejl3` 404s it — so an advertised id can still be absent on the pinned account.
- **The per-model probe was removed (2026-07-11).** It pinged every advertised id per account and
  read a 429 as "this account can't serve this model", surfacing a "Serves X/13" column and a
  `dry`/`hot`/`thin` health verdict. But these are **Claude Max subscriptions**: a 429 is a **usage
  window** (rolling 5h + weekly), not a capability. Every account serves every model when its window
  has headroom — proven by a single sequential opus request 429'ing exactly like the 13-wide probe
  burst, and a 63-call account 429'ing like a hammered one. Gone with it: `probeAccount`, the
  `acct_probes` table, `POST /api/claudecode/probe`, and the `health`/`servingModels`/
  `strandedProjects` fields. **Do not reintroduce a "which models does this account serve" check** —
  it measures cooldown and calls it capability.
- **The honest signal is the usage window + reset time, refreshed on demand.** `/admin/api/limits`
  (and the `limits` field on `/admin/api/accounts`) is the 5h/7d utilisation harvested for free off
  `anthropic-ratelimit-unified-*` headers on real traffic. **A 429 carries no such headers**, and the
  harvest only learns from calls an account actually serves, so an **idle** account — or one Anthropic
  **refunded/reset** — keeps its last reading. `limits: null` is "no reading", never `0%`.
  `POST /admin/api/claudecode/limits {account}` (or `{all:true}`) is the **live** read:
  `refreshAccountLimits()` pings each subscription **once** (`claude-haiku-4-5`, `max_tokens:1`) purely
  to pull fresh headers, feeds them through the same `recordLimits()` the passive harvest uses, and
  returns `{reading:{u5,u7,reset5,reset7,...}}` — or `null` with a reason. The Accounts tab (under **Providers**) has a
  **"↻ Refresh limits (live)"** button + per-row ↻, and renders `reset5`/`reset7` as clock/date.
- **A 403 `permission_error` is a dead login, not a spent window.** `"OAuth authentication is
  currently not allowed for this organization"` means the subscription itself is disabled (cancelled
  or refunded) — no reset fixes it. The refresh surfaces it distinctly (panel: **✕ OAuth disabled**,
  red), vs a 429 which just waits for `reset`. Seen live 2026-07-11: **`claude2mejlto`** (pinned to
  `pmac`/`pmac-claude`) went OAuth-disabled; those projects 403 until re-pinned. **Since 2026-07-24 a
  403 `permission_error` AUTO-DISABLES the account** (persistent `disabled:true`, not just the runtime
  `ACCT_DEAD` set): tripped from BOTH the live-limits probe (`refreshAccountLimits`) and real
  inference traffic (`http.js`, on the upstream ≥400 path), via `autoDisableAccount()` in `routing.js`.
  It never auto-RE-enables — reviving a dead subscription is an operator decision. A disabled account
  is never served: `accountFor()` returns null for a project pinned to it, so that project gets the
  honest `403 no_account_for_project` (re-pin) — watch the log for `[account] AUTO-DISABLED … stranded=…`.
  Flip it back with `POST /api/accounts/disable {account, disabled:false}` after rotating a fresh token.
- **The pool has a create path + `email` label + `disabled` flag.** `POST /api/accounts/token` is
  create-if-absent (a NEW name is added — the only add path, since `POST config` replaces the pool
  wholesale and the panel never holds the other tokens); it strips whitespace from a line-wrapped
  token paste, and takes an optional `email` (human label for which login it is). `disabled` is the
  operator/auto flag above; `POST /api/accounts/disable {account, disabled?}` flips it without
  touching the token. `GET /api/accounts` surfaces `email`, `disabled`, and runtime `dead` (ACCT_DEAD).
  Seen live 2026-07-24: william went OAuth-disabled → auto-disabled; `pbox`/`pbox-claude` re-pinned to
  the fresh **`claude2mejlto`** (`claude2@mejl.to`).
- **`endsAt` (2026-08-05) is the day a subscription's ACCESS stops, and it is hand-maintained.** A
  cancelled or refunded Max plan, or a trial: unlike the 5h/7d windows beside it, no reset brings it
  back. Nothing on `api.anthropic.com` carries a billing date — the setup-token says nothing about
  the plan — so it is set by an operator: `POST /api/accounts/meta {account, email?, endsAt?}`
  (cccc: `account_meta`), which writes the labels ALONE so recording a cancellation never needs the
  `sk-ant-oat` re-pasted from a copy nobody has. Plain `YYYY-MM-DD`; `""` clears it. **Blank means
  auto-renewing, and must render as nothing** — `endsAt` and `endsInDays` come back `null` together,
  and a placeholder there puts every healthy account in the column that exists to make a dying one
  findable (same rule as `limits: null`). The validator needs BOTH a regex and a round-trip:
  `2026-02-31` matches the shape and `Date.parse` rolls it forward to 3 March, so a regex-only guard
  stores a date three days wrong and nothing downstream can tell. Surfaced on `/api/accounts`, on
  `/api/state` (the cccc TUI reads THAT one, not `/api/accounts`), in the TUI's `SUB ENDS` column and
  on the panel's Accounts tab. The sanitizer that keeps it is `sanitizeAccount()` in
  **`config-schema.js`**, not `config.js` — dropping a field there is the `allowUa` trap: it looks
  right in the panel and is gone on the next restart.
- **`list_usd` is NULLABLE as of 2026-07-26, and null means "unknown", not zero.** It appears on
  `GET /api/stats` — on every `byX` row and on each `premiumUsage` entry — and is the notional
  Anthropic list cost of claudecode traffic. `listCostUsd()` returns **null** for a model with no
  `MODEL_COST` entry, because 0 is the specific claim "this traffic was free" and the ids missing
  from that table are the newest, i.e. the dearest (`claude-opus-5` today). **Never `|| 0` it** — the
  panel renders "cost unknown — model has no price defined", and any other consumer must do the same
  or it will report a premium burn as nothing. A non-claudecode row keeps a real 0: the sub is flat
  and local is free, so there "no list cost" is the true answer. `cccc` forwards `premiumUsage`
  verbatim and does no arithmetic on it, so it is unaffected (checked 2026-07-26) — but that is the
  check to repeat for any new consumer.
- **`acct_limits` is keyed by Anthropic org-id, which says nothing about which login it is.** The
  `account` column (added 2026-07-09 by an idempotent `ALTER` in `initDb`) fixes that, but it is only
  stamped by live traffic. A cold-started router learns org→account from the
  `anthropic-organization-id` header on the `fetchAccountModels()` catalog sweep — the one request it
  makes for an account with no traffic. Break that and every account reports `limits: null` until it
  happens to serve a call. **`limits: null` is "no reading", not `0%`** — never render them alike.
- **Per-account spend must join on the name after the colon in `key_label`.** Pre-rename rows say
  `anthropic:philip` / `wrappy:philip`, current ones say `claudecode:philip`. `GET /admin/api/accounts`
  uses `split_part(key_label,':',2)` for exactly this reason.
- **`POST /admin/api/config` REPLACES `projectAccounts`.** Sending one pin deletes the rest. Use
  `POST /admin/api/pins {project,account}` — it merges, and rejects an unknown account name. Same for
  `projectRoutes` → `POST /admin/api/routes {project,…}`.
- **Renaming a field renames it in SQL too.** The `lane`→`provider` rename needed an
  `ALTER TABLE calls ADD COLUMN provider` + backfill from `lane`; without it `CREATE TABLE IF NOT
  EXISTS` no-ops on the existing prod table, the provider index throws, `initDb()` catches, and
  **call logging silently turns itself off while boot still looks clean**.

## Open work

~~2. Accounts + project-pin admin API and UI panel.~~ **Done 2026-07-09** — `POST /admin/api/pins`
   plus a pin editor in the panel. `promopilot` is pinned and serving.

~~1. Per-project API keys.~~ **Built 2026-07-09** — `sk-llm-<id>-<secret>`, sha256 at rest, issued by
   `POST /admin/api/consumers/keys`. **Not yet closed**: `auth.mode` is `optional` until every caller
   holds a key. Migration = issue a key per consumer → store in keyvault → update the caller → flip
   `auth.mode` to `required`. The panel lists who still has no key.

2. **Accounts + project-pin admin API and UI panel.** Unblocks pinning `promopilot`, and unblocks
   `claudectl`'s account tools (below).
3. ~~**`local` thinking default.**~~ **Done 2026-07-09** — `applyLocalThinkingDefault()`.
4. **Consumption views** — per project / group / account / model, from the existing `calls` table.

## `cccc/` — the control surface (lives in this repo since 2026-07-12)

`cccc` moved in from `devdashco/claudectl` (that repo now holds only the cmux Dock /
`cmuxdock` plugin). It ships the `cccc` curses TUI, the shared statusline, a Claude Code plugin
with a local stdio `claudectl` MCP (~48 tools), and shell glue — all driving this router's
`/api/*` control plane (cookie login at `POST /api/login`). See `cccc/README.md`.

| Surface | What it reads/writes here |
|------|---------------------------|
| `proxy_state`, `proxy_config`, `proxy_reset_config` | the live `CFG` (providers, overrides, forceModel) |
| `proxy_pin`, `proxy_route`, TUI "switch" | merge-safe `POST /api/pins` / `POST /api/routes` |
| `proxy_health`, `proxy_models`, `proxy_resolve`, `proxy_test` | provider health, merged catalog, route a model id |
| `proxy_stats`, `proxy_calls`, `proxy_clear_calls` | the Postgres call log + per-project usage |
| `proxy_limits`, `live_limits`, TUI "⚡ LIVE limit check" | harvested `/api/limits` + live `POST /api/claudecode/limits` |
| `accounts_list`, `account_add/delete/switch` | the pool via `/api/accounts*` + `/api/pins` |

Consequences worth remembering:

- **Config changes via `proxy_config` are the same writes as the panel.** They land in
  `/data/config.json` and survive restarts. Don't hand-edit the volume. Pins/routes go through
  the merge-safe endpoints, never `POST /api/config` (it replaces the maps wholesale).
- **`cccc/server/claudectl_server.py` is canonical**; `cccc/plugins/claudectl/mcp/claudectl_server.py`
  is a byte-identical bundle (the plugin cache imports it; a full checkout imports `server/`).
  `cccc/deploy.sh` resyncs — fix in `server/`, then copy.
- If you change an admin API route, a provider id, or the `CFG` shape, **grep `cccc/`** — the TUI,
  statusline and MCP server hardcode these paths and will break silently.
- The old remote MCP app (`mcp-claudectl`, `claudectl.hostbun.cc`) still runs an old build and now
  matters only as the `/presence` fleet registry the statusline POSTs to. It deploys from the OLD
  repo, which no longer contains the server — port presence to the router or retire the app.
- `cccc/deploy.sh` pushes master then ssh's the fleet (`pbox`, `wmac` → `~/.llm-hostbun-router`)
  to hard-reset + re-run `cccc/install.sh`. Coolify does NOT watch `cccc/**`; router deploys are
  unaffected by cccc-only pushes (and vice versa — a cccc change needs `deploy.sh`, not Coolify).
