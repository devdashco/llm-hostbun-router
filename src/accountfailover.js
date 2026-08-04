// Retry a 429'd claudecode call on ANOTHER LOGIN of the same pool. Same model, same
// provider, nothing paid per token.
//
// This is a deliberate carve-out of routing.js's "no fallback" invariant, and only of
// the account clause. The invariant's reason — answering with a DIFFERENT MODEL on a
// DIFFERENT PROVIDER hides both cost and truth — is untouched here and still holds:
// nothing below substitutes a model or crosses a provider. If every login refuses, the
// caller gets the 429.
//
// WHY A SELECTION RULE CANNOT DO THIS JOB, measured 2026-08-04. The harvested u5/u7
// reading is a WHOLE-ACCOUNT aggregate, and on this pool it comes almost entirely off
// Haiku responses — every row in /api/limits that day read `model: claude-haiku-4-5`. A
// Max plan meters Opus and Sonnet in their own buckets, which that reading cannot see,
// so an account reports u5=0/u7=0/status=allowed and still 429s every Opus call. Ranking
// by headroom does not help: `emphyx` at 28% left 429'd exactly like `claude4` at 4%,
// while bofrid's daily article job burned four days of drafts on the difference. The
// only way to find a login that still has the higher tier is to ask one.
//
// The cooldown that already existed steers the NEXT request; it cannot rescue the one in
// hand, which is what the caller is waiting on.
const TR = require("../translate");
const { CFG } = require("./config");
const { ACCT_DEAD, recordLimits } = require("./db");
const { noteAcctCooldown, clearAcctCooldown } = require("./routing");

// How many logins one request may try before the caller gets the 429. 3, not "all":
// every attempt costs a full upstream round trip on the caller's latency, and if three
// separate subscriptions refuse the same model then the pool really is out.
const MAX_ACCOUNT_TRIES = parseInt(process.env.MAX_ACCOUNT_TRIES || "3", 10);

/**
 * @returns {{up: Response|null, threw: boolean, fetchErr: Error|null}} the last attempt.
 * On success `opts.account` and `base_rec.keyLabel` are updated in place, so the call is
 * attributed to whoever actually served it — otherwise the spend lands on the login that
 * refused and the call log names the wrong org.
 */
async function retryOnAnotherAccount(ctx) {
  let { up, threw, fetchErr } = ctx;
  const { req, opts, base_rec, curTarget, curInit, stream, timeoutMs } = ctx;
  const model = base_rec.sentModel || base_rec.reqModel;
  const tried = new Set([String(opts.account).toLowerCase()]);
  let last = opts.account;

  while (up && up.status === 429 && tried.size < MAX_ACCOUNT_TRIES) {
    recordLimits(up.headers, base_rec.project, model, last);
    noteAcctCooldown(last, Number(up.headers.get("retry-after")) || 0);

    const next = (CFG.claudecodeAccountPool || []).find(
      (a) => !tried.has(String(a.name).toLowerCase()) && a.token && !a.disabled && !ACCT_DEAD.has(a.name));
    if (!next) break;
    tried.add(String(next.name).toLowerCase());
    last = next.name;
    console.warn(`[account] 429 on ${base_rec.keyLabel} — retrying ${model} on ${next.name}`);

    // A fresh controller per attempt: reusing an aborted one aborts the retry instantly.
    const ctl = new AbortController();
    const tmr = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      up = await fetch(curTarget, {
        ...curInit,
        signal: ctl.signal,
        // claudecode headers are SYNTHESIZED per token, never inherited — see http.js.
        headers: {
          ...TR.anthropicHeaders(next.token, { extraBeta: req.headers["anthropic-beta"] || "" }),
          accept: stream ? "text/event-stream" : "application/json",
        },
      });
      threw = false;
      fetchErr = null;
    } catch (e) {
      threw = true;
      fetchErr = e;
      up = null;
    } finally {
      clearTimeout(tmr);
    }

    if (up && up.status < 400) {
      opts.account = next.name;
      base_rec.keyLabel = `claudecode:${next.name}`;
      clearAcctCooldown(next.name);
      console.log(`[account] failover OK -> ${next.name} for ${model}`);
    }
  }
  return { up, threw, fetchErr };
}

module.exports = { retryOnAnotherAccount, MAX_ACCOUNT_TRIES };
