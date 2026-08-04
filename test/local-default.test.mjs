// The COLD-BOOT default for the free lane: what `local` resolves to when there is no
// /data/config.json yet.
//
// This is a money path with nothing else watching it. Production reads `localMap` off the volume,
// so the env seed is invisible right up until the volume is empty — a fresh deploy, a lost disk, or
// `POST /api/reset`, which unlinks the config file and reverts CFG to envDefaults(). Measured on the
// pre-2026-08-02 seed, by reconstructing it: `local`/`gemma` resolved to **claudecode** (Max
// subscription) and `gemma-4-26b`/`qwen3.5-9b` fell through to **crazyrouter**, which bills PER
// TOKEN. Four of the five ids for the free on-prem GPU pointed at something that costs money, and
// nothing in the response would say so — the caller gets a perfectly good completion.
//
// That is invariant 2's cross-provider substitution arriving as a default rather than a decision,
// which is exactly the shape that survives review. So the seed gets a test.
//
// No server, no DB, no network: routing is pure over CFG. CONFIG_FILE points at a path that does
// not exist, which is the whole point — this must exercise envDefaults(), not the live volume.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

process.env.CONFIG_FILE = "/tmp/local-default-test-no-such-file.json";
process.env.LOCAL_BASE = "https://llama.invalid";
process.env.LOCAL_BASE_SMALL = "https://llama-small.invalid";

const { CFG } = require("../src/config.js");
const { resolveRoute } = require("../src/routing.js");

let fails = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) { fails++; if (detail) console.log(`        ${detail}`); }
};

console.log("local lane — the cold-boot default routes to the GPU, not to a bill:");

// Every id that means "the pbox GPU". Adding one to config.js and not here is the drift this
// catches; adding one HERE and not to config.js fails loudly, which is the right way round.
const LOCAL_IDS = ["local", "gemma", "gemma-4-26b", "qwen", "qwen3.5-9b"];
// The local lane is one provider over TWO llama.cpp processes. These ids are the SMALL one and must
// resolve to its own base rather than the 9B's — same provider, same free lane, different container
// (and, until 2026-08-04, a different box: they lived on ww's 3070 beside the image model).
const SMALL_IDS = ["qwen3.5-2b", "qwen-small"];

for (const id of LOCAL_IDS) {
  const r = resolveRoute(id);
  check(`${id} -> provider local`, r.provider === "local",
    `got provider=${r.provider} model=${r.rewriteModel || r.target || ""} reason=${r.reason}`);
  // The specific regression: never a PAID provider. Stated separately from the line above because
  // "not local" and "costs money" are different failures and the second is the expensive one.
  check(`${id} never resolves to a paid provider`,
    r.provider !== "crazyrouter" && r.provider !== "claudecode",
    `got ${r.provider} — this id bills real money on a fresh volume`);
}

// The seed must actually name a model, not resolve to the local provider with an empty id: an empty
// rewriteModel reaches llama.cpp as no model at all.
for (const id of LOCAL_IDS) {
  const r = resolveRoute(id);
  const m = r.rewriteModel || r.target || "";
  check(`${id} carries a concrete model id (${m || "EMPTY"})`, m.length > 0);
}

// localMap and LOCAL_IDS must agree, or an id silently stops being a local alias.
const ALL_LOCAL_IDS = [...LOCAL_IDS, ...SMALL_IDS];
check("every local id is seeded in localMap",
  ALL_LOCAL_IDS.every((id) => CFG.localMap[id]),
  `localMap seed = ${JSON.stringify(CFG.localMap)}`);
check("localMap seeds nothing BEYOND the known local ids",
  Object.keys(CFG.localMap).every((k) => ALL_LOCAL_IDS.includes(k)),
  `unexpected: ${Object.keys(CFG.localMap).filter((k) => !ALL_LOCAL_IDS.includes(k)).join(", ")}`);

// ── which BOX serves the id ────────────────────────────────────────────────
// A wrong base here does not fail loudly: it sends the small id to the 9B's llama.cpp, which answers
// a perfectly ordinary 404 for a model it does not hold. So assert the base, not just the provider.
for (const id of SMALL_IDS) {
  const r = resolveRoute(id);
  check(`${id} -> provider local`, r.provider === "local", `got ${r.provider} (${r.reason})`);
  check(`${id} -> the small-lane base`, r.base === "https://llama-small.invalid",
    `got base=${r.base} — this id is served by the small llama.cpp, not the 9B`);
  check(`${id} never resolves to a paid provider`,
    r.provider !== "crazyrouter" && r.provider !== "claudecode", `got ${r.provider}`);
}
// The converse, and the more expensive direction to get wrong: a per-model base must not leak onto
// the ids it was never meant to move. Every pbox id stays on bases.local.
for (const id of LOCAL_IDS) {
  const r = resolveRoute(id);
  check(`${id} stays on the 9B base`, r.base === "https://llama.invalid",
    `got base=${r.base} — localBases captured an id that belongs to the 9B`);
}

// The other half of the 2026-08-02 fix: the ABLITERATED ids genuinely have no local backend and
// must keep their claudecode redirect. Removing the local ids from modelRoutes must not have taken
// these with them — that would send an uncensored-model request to crazyrouter, per token, for a 404.
for (const id of ["obliterated", "obliteratus", "qwen3.6-27b-obliterated"]) {
  const r = resolveRoute(id);
  check(`${id} still redirects to claudecode`, r.provider === "claudecode",
    `got ${r.provider} (${r.reason})`);
}

// And modelRoutes must NOT reclaim a local id: it outranks localMap, so one entry here silently
// undoes every assertion above.
check("modelRoutes claims none of the local ids",
  LOCAL_IDS.every((id) => !CFG.modelRoutes[id]),
  `claimed: ${LOCAL_IDS.filter((id) => CFG.modelRoutes[id]).join(", ")}`);

// ── the local lane's own credential ────────────────────────────────────────
// llama.cpp's --api-key. Without this the router forwarded the CALLER's `sk-llm-...` bearer
// straight to llama.cpp, and pbox.llm.hostbun.cc answered anyone who skipped the router entirely.
// buildHeaders turns `authToken` into the Authorization header, so the route carrying it IS the fix.
{
  const before = CFG.localKey;
  CFG.localKey = "";
  check("no localKey -> no authToken (old behaviour, nothing breaks)",
    resolveRoute("qwen3.5-9b").authToken === undefined);
  CFG.localKey = "test-key-123";
  for (const id of [...LOCAL_IDS, ...SMALL_IDS]) {
    const r = resolveRoute(id);
    check(`${id} carries the local key`, r.authToken === "test-key-123",
      `got authToken=${r.authToken} — this call reaches llama.cpp unauthenticated`);
  }
  // It must NOT leak onto the paid providers: that would send our GPU key to a third party.
  check("claudecode route does not get the local key",
    resolveRoute("claude-sonnet-4-6").authToken !== "test-key-123");
  CFG.localKey = before;
}

console.log(fails ? `\nFAIL — ${fails} failed` : "\nPASS — 0 failed");
process.exit(fails ? 1 : 0);
