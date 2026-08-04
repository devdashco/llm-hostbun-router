// The openrouter provider, and specifically the two ways it fails SILENTLY.
//
// openrouter serves ~330 models behind one base URL and ~17 of them are free. Every failure mode
// here returns a perfectly good completion, so none of them shows up as an error anywhere:
//
//   • claiming an id it should not have claimed  → a paid model billed to a card, or `claude-opus-5`
//     quietly leaving our flat Max subscription for a metered relay. 200 either way.
//   • claiming NOTHING when it should have       → free-lane traffic falls through to crazyrouter,
//     which bills per token for the same answer. Also 200.
//
// So the assertions are about WHICH upstream a model id resolves to, never about status codes.
// The catalogue is injected directly (it is module state, not config) so nothing here touches the
// network — the refresh tests stub `fetch` and assert on what survives a bad read.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(import.meta.url);

let pass = 0, fail = 0;
const eqJ = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, actual, expected) {
  if (eqJ(actual, expected)) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}
const ok = (name, cond) => check(name, !!cond, true);

const { CFG } = req(join(ROOT, "src/config.js"));
const OR = req(join(ROOT, "src/openrouter.js"));
const { openrouterTarget, openrouterModelEntries, isFreeEntry, refreshOpenrouterModels, CATALOG } = OR;
const { baseRoute, resolveRoute } = req(join(ROOT, "src/routing.js"));

// A catalogue shaped exactly like openrouter's: free ids carry the `:free` suffix, a free model can
// also be marked purely by price, and the paid ones sit in the same list.
function seedCatalog() {
  CATALOG.clear();
  const rows = [
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", pricing: { prompt: "0", completion: "0" } },
    { id: "openai/gpt-oss-20b:free", pricing: { prompt: "0", completion: "0" } },
    // Free by PRICE only — no `:free` suffix. Checking the suffix alone would miss this one.
    { id: "some/zero-priced-model", pricing: { prompt: "0", completion: "0" } },
    // Paid, and deliberately a model we also reach another way.
    { id: "anthropic/claude-opus-5", pricing: { prompt: "0.000015", completion: "0.000075" } },
    { id: "google/gemini-2.5-pro", pricing: { prompt: "0.00000125", completion: "0.00001" } },
    // No pricing block at all → unknown, must NOT read as free.
    { id: "mystery/unpriced" },
  ];
  for (const m of rows) CATALOG.set(m.id.toLowerCase(), { id: m.id, free: isFreeEntry(m) });
}

console.log("openrouter — what counts as free:");
check("the `:free` suffix is free", isFreeEntry({ id: "x/y:free" }), true);
check("zero prompt AND completion is free without the suffix",
      isFreeEntry({ id: "x/y", pricing: { prompt: "0", completion: "0" } }), true);
// The prices arrive as STRINGS. `"0.000015" == 0` is false but a sloppy falsy check on a missing
// field would read as free, so both halves are asserted rather than just the happy one.
check("a priced model is not free", isFreeEntry({ id: "x/y", pricing: { prompt: "0.000015", completion: "0.000075" } }), false);
check("free prompt but PAID completion is not free",
      isFreeEntry({ id: "x/y", pricing: { prompt: "0", completion: "0.00001" } }), false);
check("no pricing block is not free — unknown must never read as free",
      isFreeEntry({ id: "x/y" }), false);

console.log("\nopenrouter — the provider is OFF until it is fully configured:");
seedCatalog();
CFG.bases.openrouter = "https://openrouter.ai/api";
CFG.openrouterFreeOnly = true;
CFG.openrouterModels = [];
CFG.openrouterKey = "";
// This is the property that makes adding the provider safe to deploy: with no key it claims
// nothing, so every id routes exactly where it did before the provider existed. A half-configured
// openrouter that swallowed ids and answered 401 would be an outage nobody could attribute.
check("no key → claims no id at all", openrouterTarget("openai/gpt-oss-20b:free"), null);
check("...and advertises nothing on /v1/models", openrouterModelEntries(), []);
CFG.openrouterKey = "sk-or-v1-test";
check("with a key, a free id resolves", openrouterTarget("openai/gpt-oss-20b:free"), "openai/gpt-oss-20b:free");
CFG.bases.openrouter = "";
check("no base → claims no id either", openrouterTarget("openai/gpt-oss-20b:free"), null);
CFG.bases.openrouter = "https://openrouter.ai/api";

console.log("\nopenrouter — the free-only guard (the one that costs money when wrong):");
check("a free id is claimed", openrouterTarget("nvidia/nemotron-3-ultra-550b-a55b:free"), "nvidia/nemotron-3-ultra-550b-a55b:free");
check("free-by-price is claimed too", openrouterTarget("some/zero-priced-model"), "some/zero-priced-model");
check("a PAID id is not claimed while free-only is on", openrouterTarget("google/gemini-2.5-pro"), null);
check("an unpriced id is not claimed either", openrouterTarget("mystery/unpriced"), null);
check("an id absent from the catalogue is not claimed", openrouterTarget("no/such-model"), null);
check("an empty model is not claimed", openrouterTarget(""), null);
// Case: openrouter's ids are lowercase, but a caller's config may not be. Resolve case-insensitively
// and forward THEIR casing — sending the caller's variant upstream is a 404 nobody would trace back.
check("lookup is case-insensitive and forwards the catalogue's own casing",
      openrouterTarget("OpenAI/GPT-OSS-20B:Free"), "openai/gpt-oss-20b:free");
// Turning the guard off is what an operator does to spend real money; it must actually work.
CFG.openrouterFreeOnly = false;
check("free-only off → a paid id resolves", openrouterTarget("google/gemini-2.5-pro"), "google/gemini-2.5-pro");
CFG.openrouterFreeOnly = true;
check("...and back on, it stops again", openrouterTarget("google/gemini-2.5-pro"), null);
// The narrow, written-down way to spend: name the id. An operator typing an id into config is a
// decision; the catalogue saying a model exists is not.
CFG.openrouterModels = ["google/gemini-2.5-pro"];
check("an explicitly listed paid id bypasses free-only", openrouterTarget("google/gemini-2.5-pro"), "google/gemini-2.5-pro");
check("...and listing one does not open the others", openrouterTarget("mystery/unpriced"), null);
CFG.openrouterModels = [];

console.log("\nopenrouter — /v1/models advertises exactly what would resolve:");
// A catalogue that advertises ids which then fall through to another provider is worse than one
// that advertises nothing: the caller picks a model, gets an answer from somewhere else, and pays.
{
  const ids = openrouterModelEntries().map((m) => m.id).sort();
  check("free-only advertises only the free ids",
        ids, ["nvidia/nemotron-3-ultra-550b-a55b:free", "openai/gpt-oss-20b:free", "some/zero-priced-model"]);
  ok("...and every advertised id actually resolves", ids.every((id) => openrouterTarget(id) === id));
  CFG.openrouterFreeOnly = false;
  ok("free-only off advertises the paid ones too", openrouterModelEntries().length > ids.length);
  CFG.openrouterFreeOnly = true;
}

console.log("\nopenrouter — where it sits in the routing chain:");
// Set up the surrounding chain so these are real routing decisions, not defaults.
CFG.forceModel = { enabled: false, provider: "claudecode", model: "" };
CFG.modelRoutes = {};
CFG.projectRoutes = {};
CFG.localMap = { local: "qwen3.5-9b" };
CFG.localBases = {};
CFG.cloudPolicy = "open";
CFG.bases.crazyrouter = "https://crazyrouter.com";
CFG.bases.claudecode = "https://api.anthropic.com";
CFG.claudePrefix = "claude";

const provOf = (m) => baseRoute(m, String(m).toLowerCase()).provider;
// ABOVE openrouter sits the claude* branch. On live data the two cannot collide — every openrouter
// id is `vendor/model`, so a catalogue hit never starts with `claude`. What reaches across is the
// hand-written `openrouterModels` list, and THAT is what this pins: a bare claude id typed into it
// must not sell the Max subscription off to a metered relay. Asserted with the list populated,
// because with it empty the check passes whichever order the branches are in — which is exactly how
// this test read green against a deliberately reordered baseRoute the first time it was probed.
check("`claude-*` means our own Max pool", provOf("claude-opus-5"), "claudecode");
CFG.openrouterModels = ["claude-opus-5"];
check("...and a bare claude id in openrouterModels cannot override that", provOf("claude-opus-5"), "claudecode");
CFG.openrouterModels = ["anthropic/claude-opus-5"];
check("...while their vendor-prefixed resale id is a DIFFERENT string, routed as asked",
      provOf("anthropic/claude-opus-5"), "openrouter");
CFG.openrouterModels = [];
// BELOW openrouter: cloudPolicy "open" forwards anything to crazyrouter, which bills per token. A
// free openrouter id has to be claimed before it gets there, or "free" costs money.
check("a free openrouter id beats the crazyrouter fallthrough", provOf("openai/gpt-oss-20b:free"), "openrouter");
check("an unknown id still falls through to crazyrouter, exactly as before", provOf("gemini-2.5-flash-lite"), "crazyrouter");
check("a paid openrouter id falls through too, rather than being claimed", provOf("google/gemini-2.5-pro"), "crazyrouter");
check("the local alias map still wins", provOf("local"), "local");
// The three slash-shaped ids that are really in this router's own call log. A "route anything with
// a slash to openrouter" rule would have taken all three; they mean provider-prefixed claude.
for (const id of ["wrappy/claude-sonnet-5", "crazyrouter/claude-sonnet-5"])
  check(`\`${id}\` is not openrouter's — it falls through`, provOf(id), "crazyrouter");

console.log("\nopenrouter — the route carries ITS OWN credential:");
{
  CFG.crazyrouterKey = "sk-crazy-secret";
  const r = baseRoute("openai/gpt-oss-20b:free", "openai/gpt-oss-20b:free");
  check("the provider is openrouter", r.provider, "openrouter");
  check("...pointed at the openrouter base", r.base, "https://openrouter.ai/api");
  // `injectKey` is hard-wired to CFG.crazyrouterKey inside buildHeaders. Setting it here would send
  // crazyrouter's bearer to openrouter.ai: a 401 that reads like a routing bug, AND our crazyrouter
  // credential handed to a third party. The key must ride `authToken` instead.
  check("...with authToken, NOT injectKey", [r.authToken, r.injectKey], ["sk-or-v1-test", undefined]);
  // Proven through the real header builder rather than by reading the route object, because the
  // route object is not what reaches the wire.
  const { buildHeaders } = req(join(ROOT, "src/http.js"));
  const h = buildHeaders({ headers: { authorization: "Bearer sk-llm-caller-key" } }, { injectKey: r.injectKey, authToken: r.authToken });
  check("the caller's own key never reaches openrouter", h.authorization, "Bearer sk-or-v1-test");
}

console.log("\nopenrouter — a project rule can still pin to it:");
CFG.projectRoutes = { someapp: { provider: "openrouter", model: "openai/gpt-oss-20b:free" } };
check("a pin routes there", resolveRoute("whatever", "someapp").provider, "openrouter");
check("...and rewrites the model", resolveRoute("whatever", "someapp").rewriteModel, "openai/gpt-oss-20b:free");
// The allowlist half: `openrouter` has to be a normProvider-able name or an allowlist naming it
// would sanitize to empty and silently mean "no restriction".
CFG.projectRoutes = { someapp: { allowProviders: ["openrouter"] } };
check("an allowlist naming openrouter survives sanitisation and refuses the rest",
      resolveRoute("gemini-2.5-flash-lite", "someapp").blocked, true);
check("...while permitting openrouter itself", resolveRoute("openai/gpt-oss-20b:free", "someapp").provider, "openrouter");
CFG.projectRoutes = {};

console.log("\nopenrouter — a failed refresh keeps the previous catalogue:");
// Same rule, and the same reason, as registry.js's refresh: an empty catalogue is indistinguishable
// from "nothing is free today", and acting on it moves every free-lane call onto a per-token
// provider. A bad read must cost free capacity, never a wrong bill.
{
  const savedFetch = globalThis.fetch;
  seedCatalog();
  const before = CATALOG.size;

  globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED"); };
  let meta = await refreshOpenrouterModels();
  check("a thrown fetch leaves the catalogue alone", CATALOG.size, before);
  ok("...and records why", /ECONNREFUSED/.test(meta.error));

  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await refreshOpenrouterModels();
  check("a 503 leaves the catalogue alone", CATALOG.size, before);

  // The nastiest one: a 200 carrying an empty list. It is not distinguishable from a real outage
  // at this layer, and treating it as truth un-routes every free model at once.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  meta = await refreshOpenrouterModels();
  check("a 200 with an empty list leaves the catalogue alone", CATALOG.size, before);
  ok("...and says so rather than reporting success", /empty/.test(meta.error));

  // A good read DOES replace it — a guard that latched on the first failure would be its own outage.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    data: [{ id: "brand/new:free", pricing: { prompt: "0", completion: "0" } },
           { id: "brand/paid", pricing: { prompt: "1", completion: "1" } }] }) });
  meta = await refreshOpenrouterModels();
  check("a good read replaces it", [CATALOG.size, meta.free, meta.error], [2, 1, ""]);
  check("...and the new free id routes immediately, with no config edit",
        openrouterTarget("brand/new:free"), "brand/new:free");
  check("...while the new paid one does not", openrouterTarget("brand/paid"), null);

  globalThis.fetch = savedFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
