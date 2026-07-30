// The waste watcher's thresholds, driven with the real shapes they were calibrated against.
//
// Every fixture below is a rounded copy of a real consumer's numbers from prod on 2026-07-29, so a
// threshold edit that looks harmless has to answer for what it does to actual traffic. The two that
// matter most are the NEGATIVES: `pmac` (8323 calls/day at 0% cache) and `wmac` (the steadiest
// consumer on the fleet) are the two that would make this thing cry wolf, and both are wired here
// as must-not-fire.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { evaluate, COOLDOWN, SPIKE_BASE_MIN } = require("../src/waste.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; } else { fail++; console.error(`  FAIL ${name}`); } };
const sigs = (f) => f.map((x) => `${x.signal}:${x.consumer}`).sort();
const fresh = () => new Map();
const NOW = 1_700_000_000_000;
const ev = (rows, base = {}, fired = fresh()) => evaluate(rows, base, NOW, fired);

// ── burn ────────────────────────────────────────────────────────────────────
// autonoma's real disaster hour: 393M billable, zero cache, 86k-token prompts re-sent per turn.
const autonoma = { consumer: "autonoma", calls: 4000, billable: 393_000_000, prompt: 393_000_000, cread: 0 };
check("burn fires on a big uncached prompt", sigs(ev([autonoma])).includes("burn:autonoma"));

// pmac's classifier: 0% cache too, but 1.7k-token prompts are UNDER Anthropic's cache floor. There
// is no waste to report — it physically cannot cache. This is the false positive that would have
// made the whole watcher noise.
const pmacBot = { consumer: "pmac", calls: 8323, billable: 17_000_000, prompt: 14_600_000, cread: 0 };
check("burn ignores short uncacheable prompts", ev([pmacBot]).length === 0);

// wmac: 254k-token prompts, but 96% cached — the cache is doing its job, nothing to say.
const wmac = { consumer: "wmac", calls: 264, billable: 2_814_306, prompt: 67_000_000, cread: 64_300_000, tools_kb: 0 };
check("burn ignores a well-cached big prompt", ev([wmac]).some((f) => f.signal === "burn") === false);

// A big uncached prompt that hasn't moved enough tokens yet is not news.
check("burn respects its absolute floor",
  ev([{ consumer: "small", calls: 10, billable: 900_000, prompt: 900_000, cread: 0 }]).length === 0);

// ── bloat ───────────────────────────────────────────────────────────────────
check("bloat fires on a 280 KB tool schema",
  sigs(ev([{ ...wmac, tools_kb: 280, tools: 294, mcp: 270 }])).includes("bloat:wmac"));
check("bloat ignores 99 KB (the next consumer down)",
  ev([{ consumer: "laptops", calls: 7, billable: 136_546, prompt: 187_000, cread: 51_000, tools_kb: 99 }]).length === 0);
// Indexed through `find`, not `[0]`: a threshold change that stops this firing has to REPORT as one
// red check, not abort the file on a TypeError and take every assertion below it with it.
check("bloat reports the tool counts, not just the size",
  ev([{ ...wmac, tools_kb: 280, tools: 294, mcp: 270 }]).find((f) => f.signal === "bloat")?.mcp_tools === 270);

// ── spike ───────────────────────────────────────────────────────────────────
// toolbox: 20.8x its own average. The comparison is per-consumer, so a consumer that is simply
// large all the time never trips.
check("spike fires at 20x own average",
  sigs(ev([{ consumer: "toolbox", calls: 40, billable: 7_225_246, prompt: 7_300_000, cread: 0 }],
    { toolbox: 346_546 })).includes("spike:toolbox"));
check("spike ignores wmac's steady 2.3x",
  ev([wmac], { wmac: 1_200_000 }).some((f) => f.signal === "spike") === false);
// A quiet consumer waking up is a 50x ratio on numbers nobody cares about.
check("spike respects its absolute floor",
  ev([{ consumer: "quiet", calls: 2, billable: 100_000, prompt: 100_000, cread: 0 }], { quiet: 2000 }).length === 0);
// No history = no baseline = no ratio. A brand-new consumer must not read as an infinite spike.
check("spike is silent without a baseline",
  ev([{ consumer: "brandnew", calls: 5, billable: 9_000_000, prompt: 9_000_000, cread: 0 }], {})
    .some((f) => f.signal === "spike") === false);


// A baseline of almost nothing makes the ratio meaningless, not alarming. autonoma's p90 active hour
// was 29 tokens, so one real hour divided out to "54,939,325x" — arithmetically true and useless.
check("spike is silent against a negligible baseline",
  ev([{ consumer: "autonoma", calls: 4000, billable: 1_593_000_000, prompt: 1_600_000_000, cread: 0 }],
    { autonoma: 29 }).some((f) => f.signal === "spike") === false);
check("...but still fires once the baseline is real",
  ev([{ consumer: "autonoma", calls: 4000, billable: 1_593_000_000, prompt: 1_600_000_000, cread: 0 }],
    { autonoma: SPIKE_BASE_MIN * 2 }).some((f) => f.signal === "spike"));

// ── cooldowns ───────────────────────────────────────────────────────────────
// A standing condition must not re-page every tick. Tool bloat is true until someone unloads an MCP
// server, so it re-arms daily while burn/spike re-arm hourly.
{
  const fired = fresh(), row = { ...wmac, tools_kb: 280, tools: 294, mcp: 270 };
  check("first scan reports", evaluate([row], {}, NOW, fired).length === 1);
  check("second scan is silent", evaluate([row], {}, NOW + 60_000, fired).length === 0);
  check("bloat still silent after an hour", evaluate([row], {}, NOW + COOLDOWN.bloat - 1, fired).length === 0);
  check("bloat re-arms after a day", evaluate([row], {}, NOW + COOLDOWN.bloat + 1, fired).length === 1);
}
{
  const fired = fresh();
  check("burn re-arms after its hour", evaluate([autonoma], {}, NOW, fired).length === 1
    && evaluate([autonoma], {}, NOW + COOLDOWN.burn + 1, fired).length === 1);
}

// ── shape ───────────────────────────────────────────────────────────────────
// One consumer can be guilty of more than one thing at once, and each gets its own line.
{
  const both = { consumer: "greedy", calls: 100, billable: 9_000_000, prompt: 9_000_000, cread: 0, tools_kb: 300 };
  check("a consumer can trip several signals at once", ev([both]).length >= 2);
}
check("a row with no consumer is skipped", ev([{ consumer: "", calls: 9, billable: 9e9, prompt: 9e9, cread: 0 }]).length === 0);
// pg hands bigints back as numbers here, but SUM() of an empty set is null and round(avg(NULL)) is
// null — every field has to survive that without throwing.
check("null aggregates do not throw",
  ev([{ consumer: "empty", calls: 0, billable: null, prompt: null, cread: null, tools_kb: null }]).length === 0);

// The cooldowns are calibrated NUMBERS, not a vibe, and the comment above them said "both back off
// to a working day" while burn was 6h and bloat 24h — a 4x difference described as the same thing.
// A reader tuning one of these off that sentence edits the wrong constant. Pinned here so the prose
// and the constants have to move together.
{
  const H = 3600e3;
  check("burn backs off 6 hours", COOLDOWN.burn === 6 * H);
  check("a spike stays per-hour", COOLDOWN.spike === H);
  check("bloat backs off a full day", COOLDOWN.bloat === 24 * H);
  const src = readFileSync(new URL("../src/waste.js", import.meta.url), "utf8");
  const prose = (src.match(/\/\/ A standing condition[\s\S]*?const COOLDOWN/) || [""])[0];
  check("the comment does not claim one backoff for two different numbers", !/back off to a working day/.test(prose));
}

console.log(`waste: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
