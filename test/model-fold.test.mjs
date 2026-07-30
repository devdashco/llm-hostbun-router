// foldServedByModel — the byModel row's tier, premium flag and list cost when ONE requested model
// was served by SEVERAL upstream models in the window.
//
// The bug this pins was live for as long as byModel has existed and is invisible by inspection:
// `sent_models` is an unordered string_agg, the old code read element [0] of it, and everything
// downstream (tier, premium, list_usd) was computed from that one arbitrary member against the
// WHOLE group's tokens. Measured in prod 2026-07-30 over 7d: the `claude-sonnet-5` row reported
// `tier: haiku, premium: false`, and the `claude-haiku-4-5` row priced 1.87B tokens — sonnet-5
// traffic included — at haiku's rate. Both directions are the dangerous one: premium spend that
// reads as cheap, in the file whose whole job is making premium spend visible.
//
// No DB and no server: the fold is pure, and it is the money path, so it gets a real check.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { foldServedByModel } = require("../src/analytics.js");
const { listCostUsd } = require("../src/pricing.js");

let fails = 0;
const check = (name, cond) => { console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`); if (!cond) fails++; };
const row = (req, sent, provider, tok, ptok, ctok) => ({ req_model: req, sent_model: sent, provider, tok, ptok, ctok });

console.log("foldServedByModel");

// A request for sonnet-5 that mostly got served sonnet-5, with a slice rewritten to haiku. Haiku
// sorts first alphabetically — the old first-element read is exactly what this must not reproduce.
{
  const f = foldServedByModel([
    row("claude-sonnet-5", "claude-haiku-4-5", "claudecode", 1000, 900, 100),
    row("claude-sonnet-5", "claude-sonnet-5", "claudecode", 9000, 8000, 1000),
  ])["claude-sonnet-5 claudecode"];
  check("tier speaks for the model carrying the most tokens, not the first in the agg", f.served === "claude-sonnet-5");
  const perModel = listCostUsd("claude-haiku-4-5", 900, 100, 0, 0) + listCostUsd("claude-sonnet-5", 8000, 1000, 0, 0);
  check("list cost is the SUM of each served model priced at its own rate", Math.abs(f.listUsd - perModel) < 1e-9);
  check("...which is not the whole group priced at one model's rate",
    Math.abs(f.listUsd - listCostUsd("claude-haiku-4-5", 8900, 1100)) > 1e-6);
}

// The one that hides money: a mostly-haiku group with an opus slice in it.
{
  const f = foldServedByModel([
    row("claude-haiku-4-5", "claude-haiku-4-5", "claudecode", 100000, 90000, 10000),
    row("claude-haiku-4-5", "claude-opus-5", "claudecode", 500, 400, 100),
  ])["claude-haiku-4-5 claudecode"];
  check("a row that ran opus reads premium even when haiku dominates it", f.premium === true);
  check("the tier label still names the dominant model", f.served === "claude-haiku-4-5");
}

// An unpriced served id poisons the group: null means "unknown", never 0 (see listCostUsd).
{
  const f = foldServedByModel([
    row("claude-opus-4-1", "claude-opus-4-1", "claudecode", 1000, 900, 100),
    row("claude-opus-4-1", "claude-opus-5", "claudecode", 1000, 900, 100),
  ])["claude-opus-4-1 claudecode"];
  check("an unpriced member marks the whole group unknown", f.unknown === true);
  check("(guard) the fixture's unpriced id really has no price", listCostUsd("claude-opus-4-1", 900, 100) == null);
}

// A fully priced group is NOT unknown — otherwise the flag would say nothing.
{
  const f = foldServedByModel([row("claude-haiku-4-5", "claude-haiku-4-5", "claudecode", 10, 9, 1)])["claude-haiku-4-5 claudecode"];
  check("a fully priced group is not unknown", f.unknown === false && f.listUsd > 0);
}

// Non-claudecode rows carry no list cost at all: local is free and crazyrouter is priced in `usd`.
{
  const f = foldServedByModel([row("qwen3.5-9b", "qwen3.5-9b", "local", 1000, 900, 100)])["qwen3.5-9b local"];
  check("a local row accrues no list cost and is never unknown", f.listUsd === 0 && f.unknown === false);
  check("a local row still resolves its served model", f.served === "qwen3.5-9b");
}

// Providers are separate rows on the panel, so the fold must not smear across them.
{
  const f = foldServedByModel([
    row("claude-haiku-4-5", "claude-haiku-4-5", "claudecode", 10, 9, 1),
    row("claude-haiku-4-5", "qwen3.5-9b", "local", 9999, 9000, 999),
  ]);
  check("the same requested id on two providers stays two entries",
    f["claude-haiku-4-5 claudecode"].served === "claude-haiku-4-5" && f["claude-haiku-4-5 local"].served === "qwen3.5-9b");
}

// The rollup groups by (project, ...) too, so the same (model, provider) arrives split across rows.
{
  const f = foldServedByModel([
    row("claude-opus-5", "claude-opus-5", "claudecode", 100, 90, 10),
    row("claude-opus-5", "claude-opus-5", "claudecode", 100, 90, 10),
  ])["claude-opus-5 claudecode"];
  check("rows from different projects add up rather than overwrite",
    Math.abs(f.listUsd - 2 * listCostUsd("claude-opus-5", 90, 10)) < 1e-9);
}


// Anthropic bills a cache READ at 0.1x the input rate and a WRITE at 1.25x, and `ptok` is the total
// of fresh + read + write. Pricing all of it at the input rate overstated every cached consumer —
// wmac's opus-5 list cost read $1,165.51 for a window that is 96% cache reads, against $177.52 when
// the classes are priced apart. The number exists to make premium spend visible; one that is wrong
// in the alarming direction gets discounted, and the real alarm goes with it.
{
  const flat = listCostUsd("claude-opus-5", 1_000_000, 0);                       // no split given
  const cached = listCostUsd("claude-opus-5", 1_000_000, 0, 900_000, 0);         // 90% cache reads
  check("with no cache split, every prompt token is priced at the input rate", Math.abs(flat - 5) < 1e-9);
  // 100k fresh at $5/M + 900k reads at $0.50/M = 0.5 + 0.45
  check("a cache READ is priced at a tenth", Math.abs(cached - 0.95) < 1e-9);
  const written = listCostUsd("claude-opus-5", 1_000_000, 0, 0, 1_000_000);      // all cache writes
  check("a cache WRITE is priced at 1.25x", Math.abs(written - 6.25) < 1e-9);
  check("...so a heavily cached window costs a fraction of the flat reading", cached < flat / 5);
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
