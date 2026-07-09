> **SUPERSEDED — 2026-07-09.** This plan proposed *demoting* claudebox to an internal
> translator sidecar. We went further: claudebox is **deleted**, its OpenAI↔Anthropic
> translation was rewritten from scratch in `translate.js` (the original flattened the
> conversation into a `"Human:/Assistant:"` string and emitted no tool_call deltas), and the
> account brain now lives only here — pinned per project, never rotated.
>
> Read `CLAUDE.md` for the current architecture. Kept below for history.

# Consolidation: one gateway, one FQDN, one account brain

Goal: collapse the LLM stack from **3 repos / ~6 FQDNs / 4 account brains** down to
**2 repos / 1 data-plane FQDN / 1 account brain**, while *tracking everything*.

`llm.hostbun.cc` becomes THE gateway. `claude.hostbun.cc` retires (folds in as an
internal translator). `claudectl` stays as the control plane, pointed at the gateway.

## Target topology

```
  all consumers ── base_url = llm.hostbun.cc ──►  ONE GATEWAY  ──► api.anthropic.com
  pmac/wmac/pbox/lprod (native)  X-Account lock   │  · route (3 lanes)
  apps: promopilot/mantal/…      X-Project        │  · translate (claudebox sidecar, OpenAI→Anthropic)
                                                   │  · one account vault + per-consumer lock
                                                   │  · headroom compress (non-cached lanes)
                                                   │  · track EVERY call → HyperDX
                                                   ├── /admin     router admin UI  (exists)
                                                   └── /accounts  accounts UI       (moved from claude.hostbun.cc)
```

## Lanes: 4 → 3

`wrappy` and `anthropic` are the same backend (Max subscription → Anthropic) split
only by request *format*. Collapse them:

| lane | backend | account brain? |
|---|---|---|
| `local` | pbox llama.cpp | no |
| `cloud` (crazyrouter) | gemini etc | no |
| **`claude`** (was wrappy+anthropic) | Max sub → Anthropic | **yes — the one vault + X-Account lock** |

`claude` lane internals: native `/v1/messages` → passthrough; OpenAI
`/chat/completions` → translate via the claudebox sidecar. Format is an internal
detail, not a lane.

## Account brain: 4 → 1

Kill every duplicate selector:
- claudebox drain-LB → **deleted** (claudebox becomes a dumb translator; the gateway
  injects the chosen account's token).
- proxy `anthropicPool` sticky → becomes the **single vault**; selection = `X-Account`
  per-consumer lock (shipped, `adb6139`) + per-project for apps. **No auto-rotation.**
- cccc keychain → demoted to a boot placeholder (the header decides).
- lprod `accounts.json` → **deleted**; the bot pulls its token from the gateway.

## Tracking everything

`recordCall` already ships every call to HyperDX (`otel.hyperdx.hostbun.cc`, key set).
Gap: boxes that **bypass** the gateway are invisible. Fix = route **wmac, pbox, lprod**
through `llm.hostbun.cc` (they go direct to Anthropic today) — with a **fail-open**
launcher so a gateway outage drops to direct instead of breaking claude.

## Headroom (compression)

`github.com/chopratejas/headroom`, vendored as `headroom-svc/`, called by the gateway
before forwarding. Keep it ON for `local,crazyrouter` (OpenAI apps). **Do NOT enable it
for the `claude` lane's native Claude Code traffic** — Claude Code relies on prompt
caching (huge `cache_read`); compressing busts the cache and *raises* cost.

## UIs — both under llm.hostbun.cc

- `llm.hostbun.cc/admin` — router admin UI (exists).
- `llm.hostbun.cc/accounts` — the claudebox accounts UI (Vite app at `claudebox/wrapper/ui/`),
  moved here. Interim: reverse-proxy `/accounts` → claude.hostbun.cc UI; final: serve the
  built assets from the gateway once claudebox is vendored.

## FQDNs: ~6 → 1 (data plane)

retire: `claude.hostbun.cc` (+docs), `docs.llm.hostbun.cc`, `i7pf…hostbun.cc`
(headroom-compress → fold into the gateway compose). keep: `llm.hostbun.cc` (gateway),
`claudectl.hostbun.cc` (control), HyperDX. `pbox.llm.hostbun.cc` → internal.

## Phased execution (each safe + verifiable; no big-bang)

0. **✅ One account brain (anthropic lane)** — `X-Account` lock shipped + deployed.
1. **Extend the lock to the wrappy lane** — gateway picks the account and passes
   `X-CCC-Account` to claudebox (it already honours it). Now BOTH Max lanes share one
   selector. *(server.js, additive, reversible.)*
2. **Route wmac/pbox/lprod through the gateway** + fail-open launcher. Now everything is
   tracked. Repoint lprod's `pick_account.py` limits read → `llm.hostbun.cc/admin/api/limits`.
3. **`/accounts` UI on llm.hostbun.cc** (reverse-proxy first).
4. **Vendor claudebox** into the gateway repo as `translator/` (internal :8000); one
   docker-compose (gateway + translator + headroom). Point the `claude` lane's OpenAI
   path at `translator:8000`.
5. **Collapse wrappy+anthropic → `claude`** in the router; delete claudebox's account/LB
   code; serve `/accounts` from the vendored UI.
6. **Retire** `claude.hostbun.cc` (DNS + Coolify app) and `headroom-compress` (folded).

## Security (do first, independent)

- `claudectl/integrations/lprod-telegram/accounts.json` held live `sk-ant-oat01` tokens
  and was tracked → **untracked + gitignored** (`a9eef78`). **Tokens are in history →
  rotate them** and move the pool to keyvault.
- `llm-hostbun-router` was **public** → set **private**. No hardcoded secrets in `server.js`.
