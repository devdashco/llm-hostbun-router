// The openrouter.ai provider's CATALOGUE, and the one question routing asks it:
// is this model id one of theirs, and are we allowed to send it?
//
// Why this is a module and not three lines in routing.js: openrouter serves ~330 models behind ONE
// base URL, and about 17 of them are free. That ratio is the whole design constraint. A rule as
// loose as "an id with a slash in it goes to openrouter" would have routed `anthropic/claude-
// sonnet-5` and `crazyrouter/claude-sonnet-5` — both of which are real ids in this router's own
// call log, meaning something else entirely — onto a metered account. So the provider claims an id
// only when the LIVE catalogue says it exists AND says it is free.
//
// Free is read two ways because openrouter marks it two ways: the `:free` id suffix, and a pricing
// block whose prompt and completion are both "0". Checking only the suffix would miss a model
// they publish at zero cost without renaming it; checking only the price would miss one whose
// pricing block is absent. Neither is authoritative alone.
//
// WHERE THIS SITS IN baseRoute(), since both neighbours are load-bearing and only one of them is
// obvious:
//   • BELOW the `claude-*` branch. On live data the two cannot collide — every openrouter id is
//     `vendor/model`, so a catalogue hit never starts with `claude`. What reaches across is
//     `openrouterModels`, a hand-written list: put `claude-opus-5` in it, run the branches the
//     other way round, and the whole Max subscription quietly starts billing through a metered
//     relay at a 200. The order is what stops that list selling off the subscription by typo.
//     (Their resale id `anthropic/claude-opus-5` is a DIFFERENT string, and is routable on purpose.)
//   • ABOVE the crazyrouter fallthrough. This one bites on live data: `cloudPolicy: "open"`
//     forwards anything, so an id openrouter serves free must be claimed before crazyrouter bills
//     per token for the same answer.
//
// The catalogue is refreshed rather than pinned for the same reason `claudecodeModels` is: their
// free roster turns over (models arrive, and a free one becomes paid without telling anybody), and
// a hand-maintained list would go stale in exactly the direction that costs money. If the refresh
// fails we keep the previous catalogue — same rule as registry.js's refresh, and for the same
// reason: an empty catalogue is indistinguishable from "nothing is free today", and acting on it
// would silently move every free-lane call onto the fallthrough provider that bills per token.
const { CFG } = require("./config");

// id (lowercased) -> { id, free }. Module state, NOT config: it is a cache of someone else's
// catalogue, so it must never be written to /data/config.json and grow stale on disk.
const CATALOG = new Map();
let META = { at: 0, count: 0, free: 0, error: "", source: "" };

const REFRESH_MS = 6 * 3600 * 1000;

// Both markers, either one is enough. `pricing` values arrive as STRINGS ("0", "0.0000001").
function isFreeEntry(m) {
  const id = String((m && m.id) || "");
  if (id.toLowerCase().endsWith(":free")) return true;
  const p = m && m.pricing;
  if (!p) return false;
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : NaN; };
  const inp = n(p.prompt), out = n(p.completion);
  return inp === 0 && out === 0;
}

// Pull the catalogue. Best-effort and never throws: a dead openrouter must not fail a boot or a
// sweep. Returns the meta snapshot either way so /api/health can say WHEN we last managed it.
async function refreshOpenrouterModels() {
  const base = CFG.bases.openrouter;
  if (!base) { META = { ...META, error: "no bases.openrouter" }; return META; }
  try {
    // Unauthenticated on purpose: the model list is public, and this runs at boot on every box.
    // Sending the key here would put it on a request whose response we only count.
    const r = await fetch(base + "/v1/models", { signal: AbortSignal.timeout(12000) });
    if (!r.ok) { META = { ...META, error: `catalog HTTP ${r.status}` }; return META; }
    const j = await r.json();
    const rows = (j && j.data) || [];
    // Only replace a NON-EMPTY read. A 200 carrying `{"data":[]}` is the shape that would quietly
    // un-route every free model, and it is not distinguishable from a real outage at this layer.
    if (!rows.length) { META = { ...META, error: "catalog empty — kept previous" }; return META; }
    CATALOG.clear();
    let free = 0;
    for (const m of rows) {
      const id = String((m && m.id) || "").trim();
      if (!id) continue;
      const f = isFreeEntry(m);
      if (f) free++;
      CATALOG.set(id.toLowerCase(), { id, free: f });
    }
    META = { at: Date.now(), count: CATALOG.size, free, error: "", source: base + "/v1/models" };
    console.log(`[openrouter] catalog ${CATALOG.size} models, ${free} free`);
  } catch (e) {
    META = { ...META, error: e.message || String(e) };
  }
  return META;
}

// Does this model id belong to openrouter, and may we send it there? Returns the id to forward
// (openrouter's own casing, so a caller's `Nvidia/...` still resolves) or null to fall through.
//
// null is the safe answer everywhere: the caller's request then takes exactly the route it took
// before this provider existed. That is why an unconfigured key disables the whole provider rather
// than 401ing — a half-configured openrouter must not swallow ids that used to reach crazyrouter.
function openrouterTarget(model) {
  if (!CFG.bases.openrouter || !CFG.openrouterKey) return null;
  const key = String(model == null ? "" : model).trim().toLowerCase();
  if (!key) return null;
  // An explicitly listed id is an operator decision and outranks the free-only guard — that is the
  // supported way to spend real money here, and it has to be written down to happen.
  if ((CFG.openrouterModels || []).includes(key)) return (CATALOG.get(key) || {}).id || key;
  const hit = CATALOG.get(key);
  if (!hit) return null;
  if (CFG.openrouterFreeOnly && !hit.free) return null;
  return hit.id;
}

// Ids to advertise on GET /v1/models. Mirrors what openrouterTarget() would actually accept, so the
// catalogue we publish and the catalogue we route on cannot disagree — advertising a paid id while
// free-only is on would make every caller that picked one get an unexplained fallthrough.
function openrouterModelEntries() {
  if (!CFG.bases.openrouter || !CFG.openrouterKey) return [];
  const out = [];
  for (const [key, v] of CATALOG) {
    if (CFG.openrouterFreeOnly && !v.free && !(CFG.openrouterModels || []).includes(key)) continue;
    out.push({ id: v.id, object: "model", owned_by: "openrouter", free: v.free });
  }
  for (const id of CFG.openrouterModels || []) {
    if (!CATALOG.has(id)) out.push({ id, object: "model", owned_by: "openrouter" });
  }
  return out;
}

const openrouterCatalogMeta = () => ({ ...META, models: CATALOG.size });

// The control-plane surface, kept HERE rather than inline in admin.js: admin.js and server.js both
// carry size ceilings that may only shrink (test/module-size.test.mjs), and a provider's own state
// shape and patch validation are leaf concerns anyway. `openrouterKey` is handled by admin.js's
// generic secret loop — it must never appear in the state below, which is not redacted.
const openrouterState = () => ({
  openrouterFreeOnly: !!CFG.openrouterFreeOnly, openrouterModels: CFG.openrouterModels || [],
});
function applyOpenrouterPatch(next, patch) {
  if (typeof patch.openrouterFreeOnly === "boolean") next.openrouterFreeOnly = patch.openrouterFreeOnly;
  if (Array.isArray(patch.openrouterModels)) next.openrouterModels = patch.openrouterModels;
}

// Boot read + the 6h tick, owned here rather than in server.js's boot block: the interval and the
// thing it refreshes belong together, and server.js is already the file over its size ceiling.
// Fire-and-forget by design — until the catalogue loads openrouterTarget() claims no id, so a
// failed refresh costs free capacity and can never produce a wrong bill.
function startOpenrouterRefresh() {
  refreshOpenrouterModels().catch((e) => console.error(`[openrouter] boot refresh: ${e.message}`));
  setInterval(() => refreshOpenrouterModels().catch(() => {}), REFRESH_MS).unref();
}

module.exports = {
  refreshOpenrouterModels, startOpenrouterRefresh, openrouterTarget, openrouterModelEntries,
  openrouterCatalogMeta, openrouterState, applyOpenrouterPatch, isFreeEntry, REFRESH_MS, CATALOG,
};
