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
const accountsSrc = readFileSync(join(ROOT, "panel", "components", "panel", "pages", "accounts.tsx"), "utf8");

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
// Both branches used to call ok(), so no reword could ever trip this — the one thing the comment
// above says it is for. The banner must name what it actually checked; a bare "All healthy" is the
// widened claim this suite exists to refuse.
else if (/slow providers|error/.test(banner[1])) ok(`the banner names what it checked: "${banner[1].trim().slice(0, 60)}…"`);
else fail(`the All healthy banner says "${banner[1].trim().slice(0, 60)}" without naming what it checked`,
  "it must name the checks it ran (providers, slow providers, errors) — an unqualified all-clear claims facts it did not gather");

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

// An account the router will NEVER serve must LOOK different from an idle one. /api/accounts
// returns `disabled` (persistent — set by an operator, or automatically on a 403 permission_error
// when a subscription is cancelled or refunded) and `dead` (the runtime ACCT_DEAD set); both were
// returned and rendered nowhere. The consequence is not cosmetic: accountFor() returns null for a
// project pinned to such an account, so those projects 403 `no_account_for_project` until they are
// re-pinned — while the screen showed a normal row with quota bars. Measured precedent: `william`
// went OAuth-disabled 2026-07-24 and the projects pinned to it started failing.
// Reading the flag is not showing it: the first version of this check only grepped for
// `a.disabled`, and passed against markup neutered to `{false ? (` because an unrelated line
// (the card's red-border count) mentions the same field. It now requires the flag to be followed
// closely by the ✕ marker the operator actually sees.
const shows = (txt) => {
  if (!/\ba\.dead\b/.test(txt)) return false;
  // ANY occurrence may be the rendering one — health.tsx reads the flag once for the card's red
  // border long before the row markup, so checking only the first would fail a correct file.
  for (const m of txt.matchAll(/\ba\.disabled\b/g)) if (txt.slice(m.index, m.index + 400).includes("✕")) return true;
  return false;
};
for (const [file, srcTxt] of [["health.tsx", src], ["accounts.tsx", accountsSrc]]) {
  if (!/\ba\.disabled\b/.test(srcTxt)) fail(`${file} reads an account's \`disabled\` flag`, "the field is returned by /api/accounts and never read here — a dead subscription looks idle");
  else if (!/\ba\.dead\b/.test(srcTxt)) fail(`${file} reads an account's runtime \`dead\` flag`, "ACCT_DEAD is returned as `dead` and never read here");
  else if (!shows(srcTxt)) fail(`${file} RENDERS the flag, not just reads it`, "no ✕ marker within the branch — the row still looks like a healthy idle account");
  else ok(`${file} shows an account the pool will not serve`);
}

// `wouldBlock: null` from /api/consumers/clients means THERE IS NO POLICY, which is a different
// answer from "this client is allowed" — the same null-is-not-zero rule as `limits` and `list_usd`.
// A panel that renders a falsy check as "allowed" would tell an operator a key is protected when
// nothing is guarding it, which is the worst direction for this particular field to be wrong in.
{
  const consumersSrc = readFileSync(join(ROOT, "panel", "components", "panel", "pages", "consumers.tsx"), "utf8");
  if (!/wouldBlock/.test(consumersSrc)) fail("the panel shows which clients a lock would block", "consumers.tsx never reads wouldBlock");
  else if (!/wouldBlock === null/.test(consumersSrc)) fail("the panel treats wouldBlock:null as NO POLICY", "null is rendered as if it were `false` — 'allowed' where the truth is 'unguarded'");
  else ok("the panel distinguishes no-policy from allowed-by-policy");
}

// A counter nobody renders is a private variable. `disabled`/`dead` on an account were returned by
// the API and shown nowhere for weeks; `telemetryShip` is the same shape and the worse case, because
// what it counts is the ALERTS not arriving — the one failure whose only symptom is silence.
{
  const callLog = readFileSync(join(ROOT, "panel", "components", "panel", "pages", "call-log.tsx"), "utf8");
  if (!/telemetryShip/.test(callLog)) fail("the panel shows failed alert deliveries", "adminState carries telemetryShip and nothing renders it");
  else if (!/HyperDX/.test(callLog)) fail("...saying where the alerts were not delivered", "the banner does not name the destination");
  else ok("the panel shows alerts that never reached HyperDX");
}

console.log(`\n${pass} passed${process.exitCode ? " · FAILURES ABOVE" : ""}`);
