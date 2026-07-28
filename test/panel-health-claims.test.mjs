// The Health tab may not report all-clear on a check it did not run.
//
//   node test/panel-health-claims.test.mjs
//
// health.tsx renders one banner — "All healthy — providers up, no slow providers or elevated errors
// in the last hour" — whenever its findings list comes back empty. Most of those findings are
// derived from `st`, the /api/stats payload, which is fetched as:
//
//     api("stats?window=1h").catch(() => null)
//
// A null `st` therefore means EITHER "loaded, nothing wrong" OR "never arrived", and every
// st-gated detector short-circuits to silence on the second one. So a failing /api/stats produced
// zero findings and the page announced all-clear — naming slow providers and error rates it had
// just failed to look at. The observability screen's failure mode was to say everything is fine.
//
// Read from SOURCE, like panel-tokens and panel-nav: this suite must stay zero-dep and runnable
// before a panel build, and the property it protects is structural — that the "could not check"
// finding is raised BEFORE the empty-findings early return, so it can suppress the banner.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "panel", "components", "panel", "pages", "health.tsx");
const src = readFileSync(SRC, "utf8");

let pass = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const fail = (m, why) => { console.log(`  FAIL  ${m}${why ? `\n        ${why}` : ""}`); process.exitCode = 1; };

console.log("health tab — no all-clear on an unrun check:");

// EVERY fetch that feeds a finding must record its own failure. A `catch {}` that only stops the
// throw leaves the source null, which is indistinguishable from a clean read — and the check it
// feeds silently stops running. `recent` is exempt: it drives a table, not a finding.
const FEEDS_A_FINDING = ["stats", "accounts"];
for (const srcName of FEEDS_A_FINDING) {
  const re = new RegExp(`missing\\.push\\("${srcName}"\\)`);
  if (re.test(src)) ok(`a failed /api/${srcName} is recorded, not swallowed`);
  else fail(`/api/${srcName} fails silently`, `nothing pushes "${srcName}" onto the missing list, so its check just stops running`);
}

// Assigned wholesale each poll, or a recovered source keeps warning until reload.
if (/setUnavailable\(missing\)/.test(src)) ok("...and the list is reassigned each poll, so a recovered source clears itself");
else fail("the unavailable list is never reset", "a transient failure would leave the warning permanently on");

// Issues must actually receive it.
const sig = src.match(/function Issues\(\{([^}]*)\}/);
if (sig && /unavailable/.test(sig[1])) ok("Issues() receives the unavailable list");
else fail("Issues() does not take `unavailable`", `signature was: ${sig ? sig[1].trim() : "not found"}`);
if (/<Issues[^>]*unavailable=\{/.test(src)) ok("...and the call site passes it");
else fail("the <Issues /> call site does not pass `unavailable`");

// The ordering invariant — the whole point. The finding must be pushed while it can still stop the
// banner. Pushed after the `if (!probs.length)` early return, it is dead code on exactly the path
// that needs it.
const iFlag = src.indexOf("(unavailable || [])");
const iEmpty = src.indexOf("if (!probs.length)");
if (iFlag < 0) fail("no finding is raised for an unavailable source at all");
else if (iEmpty < 0) fail("could not find the empty-findings early return — this suite has drifted from the source");
else if (iFlag < iEmpty) ok("the 'stats unavailable' finding is raised BEFORE the all-clear early return");
else fail("the 'stats unavailable' finding is raised too late",
  `the unavailable-source loop at ${iFlag} comes after if (!probs.length) at ${iEmpty} — the banner already returned`);

// Every st-derived read stays guarded. `st.foo` outside a `st &&` / `st?.` guard throws on the very
// failure this file is about, turning a degraded page into a blank one.
// Compared by POSITION, not by text. Matching on the string alone excuses an unguarded `st.foo`
// whenever some guarded line happens to read the same field — which is the common case here, since
// the guarded block is where these fields legitimately appear. Caught by mutation-testing this
// suite: an injected `if (st.windowCalls > 5)` outside the guard passed clean.
const guardedBlock = /if \(st && st\.byProvider\) \{[\s\S]*?\n  \}/.exec(src);
const gStart = guardedBlock ? guardedBlock.index : -1;
const gEnd = guardedBlock ? gStart + guardedBlock[0].length : -1;
const bare = [...src.matchAll(/(?<![?\w.])st\.(\w+)/g)];
const outside = bare.filter((m) => !(guardedBlock && m.index >= gStart && m.index < gEnd));
if (!guardedBlock) fail("could not locate the `if (st && st.byProvider)` guard — this suite has drifted");
else if (!outside.length) ok(`all ${bare.length} bare st.* reads sit inside the \`st && st.byProvider\` guard`);
else fail("an unguarded st.* read would throw when stats fails",
  `found outside the guard: ${[...new Set(outside.map((m) => m[0]))].join(", ")}`);

// The banner's own words. If it keeps claiming stats-derived facts, it must remain unreachable
// whenever those facts were not gathered — which is what the ordering check above enforces. This
// just pins the text so a reword cannot quietly widen the claim without tripping this suite.
const banner = src.match(/<b className="text-ok">All healthy<\/b>\s*<span[^>]*>([^<]*)<\/span>/);
if (!banner) fail("could not find the All healthy banner", "reword it and update this suite together");
else if (/slow providers|error/.test(banner[1])) ok(`the banner names what it checked: "${banner[1].trim().slice(0, 60)}…"`);
else ok("the banner no longer claims stats-derived facts");

// An error RATE without a reason is not actionable: one caller sending a field the upstream just
// dropped reads exactly like a dead upstream, and the two need opposite responses. /api/stats now
// carries `topErrors` (grouped, top 3) and the finding must actually name the first one — measured
// case: the image path at 24% errors whose cause ("LoRAs are an SDXL feature; this host serves
// SANA-Sprint") was only visible by opening one call row at a time.
{
  const errFinding = src.match(/Non-refusal error rate[^`]*`/);
  if (!errFinding) fail("the error-rate finding still exists");
  else if (!/topErrors/.test(src)) fail("the error-rate finding names the dominant reason", "health.tsx never reads st.topErrors");
  else if (!/\$\{why\}/.test(errFinding[0])) fail("the error-rate finding names the dominant reason", "topErrors is read but not interpolated into the message");
  else ok("the error-rate finding names the dominant reason from st.topErrors");
}

console.log(`\n${pass} passed${process.exitCode ? " · FAILURES ABOVE" : ""}`);
