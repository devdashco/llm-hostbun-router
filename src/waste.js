// ─────────────────────────────────────────────────────────────────────────────
// Waste watcher — the three ways a caller burns the shared Max pool without anyone noticing.
//
// The quota machinery in routing.js answers "is this app over its cap". That is a VOLUME question,
// and it is deliberately blind to developers (`usageVerdict` short-circuits on kind==="dev", because
// you do not 429 a person mid-task). Volume was never the thing that hurt us: `autonoma` peaked at
// 393M billable tokens in ONE HOUR at 0% cache hits — 10.6x its own average — and nothing said a
// word, because it had no cap configured and a cap is not what would have caught it. What was
// visible in the log the whole time was the SHAPE: a huge prompt, re-sent, uncached.
//
// So this watches shape, not size, and it watches devs too — it only ever tells you, it never
// throttles or blocks anyone.
//
//   burn   a consumer moving real tokens on big prompts that are NOT being cached
//   bloat  a consumer shipping a tool schema so large the schema outweighs the conversation
//   spike  a consumer's hour that dwarfs its own trailing week
//
// Every threshold below is calibrated against 7 days of this router's own traffic (2026-07-29) so
// that the worst real offender trips and the next-worst does not. A detector that fires on
// everything is a detector that gets muted, which is the same as not having one.
const { dbUp, dbRows } = require("./db");
const { shipEvent } = require("./telemetry");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// burn: below Anthropic's cache floor a short prompt CANNOT be cached, so a 0%-cache consumer
// sending 1.7k-token prompts (the pmac classifier, 8323 calls/day) is not doing anything wrong and
// must not fire. PROMPT_MIN is what separates "uncacheable by nature" from "cacheable, not cached".
const BURN_TOKENS = 5_000_000;   // billable in the hour, before it is worth saying anything
const BURN_CACHE_PCT = 50;       // cache reads as % of prompt tokens
const BURN_PROMPT_AVG = 20_000;  // avg prompt tokens; under this, caching is not on the table

// bloat: measured avg KB of tool JSON per request. wmac ships 280 KB (270 MCP tools from 10 servers)
// and pbox 325 KB; `laptops` at 99 KB is the next one down and is fine. 150 splits them.
const BLOAT_KB = 150;

// spike: an hour measured against the consumer's own normal BUSY hour — the 90th percentile of the
// hours it was actually active over the trailing week, not the mean of all 168.
//
// The mean is the trap, and it cost a full retune to see it: almost everything here works in bursts,
// idle for twenty hours and then hammering for two. Averaging the idle hours in drags the baseline
// to near zero, so every ordinary working hour reads as a 4x "spike". Backtested over 7 days of real
// traffic that produced 731 spike alerts — 104 a day, which is the same as no alerts at all, except
// it also buries the two that mattered. Against p90-of-active-hours the same week produces a
// handful, because the question is now "is this hour big for THIS consumer when it is working",
// which is what a human means by a spike.
const SPIKE_X = 3;
const SPIKE_MIN = 2_000_000;
// A ratio against a baseline of ~nothing is not a measurement. autonoma's active hours were mostly
// a handful of tokens, so its p90 came out at 29 and one real hour read as a "54,939,325x spike" —
// arithmetically true, and useless. Below this the consumer has no established busy hour to be
// surprising against, and the absolute-size question is `burn`'s job, not this one's.
// Kept LOW on purpose: `toolbox` has a real 346k busy hour and a real 20x spike above it, so a floor
// set to reject that would have thrown away a true positive to suppress a division artefact.
const SPIKE_BASE_MIN = 100_000;

// A standing condition is not an event, and both of the interesting signals turn out to be standing
// conditions: autonoma did not burn uncached for one hour, it burned for four days, and wmac's tool
// schema is 291 KB until somebody unloads an MCP server. Hourly re-arming on those is a pager that
// repeats the same sentence 11 times a day, so both back off to a working day; a spike is genuinely
// per-hour and stays there.
const COOLDOWN = { burn: 6 * HOUR, spike: HOUR, bloat: DAY };
const _fired = new Map();  // `${signal}|${consumer}` -> ts of last ship

// Pure: rows (last hour, per consumer) + baseline (p90 of the consumer's active hours) -> findings.
// Split out from the query so the thresholds are testable without a database.
function evaluate(rows, baseline, now = Date.now(), fired = _fired) {
  const out = [];
  const arm = (signal, consumer) => {
    const k = `${signal}|${consumer}`, last = fired.get(k) || 0;
    if (now - last < COOLDOWN[signal]) return false;
    fired.set(k, now);
    return true;
  };
  for (const r of rows) {
    const consumer = r.consumer;
    if (!consumer) continue;
    const billable = Number(r.billable) || 0, prompt = Number(r.prompt) || 0;
    const cread = Number(r.cread) || 0, calls = Number(r.calls) || 0;
    const cachePct = prompt > 0 ? (100 * cread) / prompt : 0;
    const avgPrompt = calls > 0 ? prompt / calls : 0;

    if (billable >= BURN_TOKENS && cachePct < BURN_CACHE_PCT && avgPrompt >= BURN_PROMPT_AVG
        && arm("burn", consumer)) {
      out.push({ signal: "burn", consumer, billable, calls,
        cache_pct: Math.round(cachePct), avg_prompt: Math.round(avgPrompt),
        message: `"${consumer}" burned ${Math.round(billable / 1e6)}M billable tokens in an hour at `
          + `${Math.round(cachePct)}% cache hits on ${Math.round(avgPrompt / 1000)}k-token prompts `
          + `— a cacheable prefix is being re-sent uncached` });
    }

    const toolsKb = Number(r.tools_kb) || 0;
    if (toolsKb >= BLOAT_KB && arm("bloat", consumer)) {
      out.push({ signal: "bloat", consumer, tools_kb: toolsKb,
        tools: Number(r.tools) || 0, mcp_tools: Number(r.mcp) || 0, calls,
        message: `"${consumer}" ships ${toolsKb} KB of tool schema per request `
          + `(${r.tools || 0} tools, ${r.mcp || 0} from MCP servers) — that prefix rides every turn` });
    }

    const busy = Number(baseline[consumer]) || 0;
    const x = busy >= SPIKE_BASE_MIN ? billable / busy : 0;
    if (billable >= SPIKE_MIN && x >= SPIKE_X && arm("spike", consumer)) {
      out.push({ signal: "spike", consumer, billable, busy_hour: Math.round(busy),
        factor: Math.round(x * 10) / 10, calls,
        message: `"${consumer}" spent ${Math.round(billable / 1e6)}M billable tokens this hour, `
          + `${Math.round(x * 10) / 10}x its normal busy hour (${Math.round(busy / 1e5) / 10}M)` });
    }
  }
  return out;
}

// `local` is our own GPU and `images` bills GPU seconds, not tokens — neither can drain the Max
// pool, and autonoma's 37M/hour against the local model is exactly the false positive that would
// train someone to ignore this.
const PAID = "provider NOT IN ('local','images','blocked')";

async function scanWaste(now = Date.now()) {
  if (!dbUp()) return [];
  const [rows, base] = await Promise.all([
    dbRows(
      "SELECT split_part(project,':',1) AS consumer, count(*)::int AS calls, "
      + "COALESCE(SUM(GREATEST(COALESCE(total_tokens,0)-COALESCE(cache_read,0),0)),0)::bigint AS billable, "
      + "COALESCE(SUM(COALESCE(prompt_tokens,0)),0)::bigint AS prompt, "
      + "COALESCE(SUM(COALESCE(cache_read,0)),0)::bigint AS cread, "
      + "COALESCE(round(avg(tools_kb)),0)::int AS tools_kb, "
      + "COALESCE(max(tool_count),0)::int AS tools, COALESCE(max(mcp_tools),0)::int AS mcp "
      // `ts < $2` is not decoration. Without an upper bound this reads "the last hour AND everything
      // after it", which is invisible in production (nothing is after now) and silently makes any
      // backtest or replay sum the entire remaining log into every window — the bug that made a
      // 7-day replay report the same 1593M hour 90 times running.
      + `FROM calls WHERE ts >= $1 AND ts < $2 AND ${PAID} AND project IS NOT NULL AND project <> '' GROUP BY 1`,
      [now - HOUR, now]),
    // Baseline excludes the hour being judged, or a big enough spike drags its own baseline up and
    // hides itself. `HAVING SUM(...) > 0` keeps idle hours out of the percentile — an hour a
    // consumer did not run is not evidence about how big its working hours are.
    dbRows(
      "SELECT consumer, percentile_cont(0.9) WITHIN GROUP (ORDER BY b) AS busy_hr FROM ("
      + "SELECT split_part(project,':',1) AS consumer, ts/3600000 AS hr, "
      + "SUM(GREATEST(COALESCE(total_tokens,0)-COALESCE(cache_read,0),0)) AS b "
      + `FROM calls WHERE ts >= $1 AND ts < $2 AND ${PAID} GROUP BY 1,2 `
      + "HAVING SUM(GREATEST(COALESCE(total_tokens,0)-COALESCE(cache_read,0),0)) > 0) s GROUP BY 1",
      [now - 7 * DAY, now - HOUR]),
  ]);
  const baseline = {};
  for (const b of base || []) baseline[b.consumer] = b.busy_hr;
  const findings = evaluate(rows || [], baseline, now);
  for (const f of findings) {
    console.warn(`[waste] ${f.signal.toUpperCase()} ${f.message}`);
    const { message, ...attrs } = f;
    shipEvent(message, { event: `waste_${f.signal}`, ...attrs });
  }
  return findings;
}

module.exports = {
  scanWaste, evaluate,
  BURN_TOKENS, BURN_CACHE_PCT, BURN_PROMPT_AVG, BLOAT_KB, SPIKE_X, SPIKE_MIN, SPIKE_BASE_MIN, COOLDOWN,
};
