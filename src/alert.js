// Telling a HUMAN, on their phone — and the one thing worth waking someone for: an app that just
// gained access to the premium (opus/fable) models on the shared Max pool.
//
// Why a second channel at all. `shipEvent` (telemetry.js) already carries alertable signals, but it
// carries them to HyperDX, where they wait to be looked at. The premium signal there is
// `premium_usage`, and it fires when an app RUNS opus — after the spend. The expensive moment is
// earlier and quieter: a consumer being created, or an allowlist being widened, so that opus is
// reachable at all. Nothing said a word about that, and the router is the only thing that sees it.
//
// Why Telegram directly rather than the notify MCP at notify.hostbun.cc: that service only speaks
// MCP over HTTP and wants an `initialize` handshake plus a session id before a tools/call — perhaps
// 30 lines of protocol in a zero-dep process, and one more hop that can be down. sendMessage is one
// POST. The channel is the notify registry's own `llm-router` bot (keyvault `notify/channels`), so
// the messages land in the same Telegram group as every other fleet alert.
//
// Unset token/chat = console only. That is the state every test runs in, and a dev box too.
const { isPremiumModel } = require("./pricing");

const TG_TOKEN = process.env.ALERT_TG_TOKEN || "";
const TG_CHAT = process.env.ALERT_TG_CHAT || "";

let sent = 0, failures = 0, lastError = null, lastErrorAt = 0;
// Whether the channel is configured AND working is not the same question as whether anything fired.
// A rotated bot token drops every alert with nothing anywhere saying so — the same failure mode
// telemetry's shipFails counter exists for, so it is counted the same way and surfaced on
// /api/health beside it.
const alertHealth = () => ({ channel: TG_TOKEN && TG_CHAT ? "telegram" : "console-only", sent, failures, lastError, lastErrorAt: lastErrorAt || null });

// Fire-and-forget: an alert must never delay or fail the write that triggered it.
function notifyHuman(text) {
  console.warn(`[alert] ${String(text).replace(/\n/g, " | ")}`);
  if (!TG_TOKEN || !TG_CHAT) return false;
  sent++;
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text: String(text).slice(0, 3800), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000),
  }).then((r) => { if (!r.ok) noteFail(`HTTP ${r.status}`); })
    .catch((e) => noteFail(e.message));
  return true;
}
function noteFail(why) {
  if (!failures) console.error(`[alert] telegram delivery failing: ${why} — premium-app warnings are not reaching anyone`);
  failures++; lastError = why; lastErrorAt = Date.now();
}

// ── which apps can reach opus/fable ──────────────────────────────────────────
// Reads the same two things the router itself reads at dispatch time — the consumer's kind and its
// projectRoutes rule — so this cannot drift from what actually happens on the wire. Deliberately
// only `app` consumers: a developer at a keyboard choosing opus is the normal case, and warning on
// it is how a warning gets muted (same call as the premium_usage event in server.js).
//
// The order below is the order resolveRoute() applies them in, and each step is load-bearing:
//   block      nothing runs at all.
//   rule.model a pin REWRITES every request to that id, so a pin to haiku makes opus unreachable
//              however wide the allowlist is. Reading the allowlist first would report half the
//              fleet as premium-capable.
//   allowModels an explicit list decides outright; empty means no restriction, never "nothing".
//   allowProviders a list without claudecode cannot reach a claude model, premium or not.
// Anything left is unrestricted — which is the case worth warning about, because it is what a
// freshly registered consumer looks like when nobody wrote it a rule.
function premiumWhy(cfg, name) {
  const rule = (cfg.projectRoutes || {})[name];
  if (rule && rule.block) return null;
  if (rule && rule.model) return isPremiumModel(rule.model) ? `pinned to ${rule.model}` : null;
  const am = (rule && rule.allowModels) || [];
  if (am.length) {
    const prem = am.filter(isPremiumModel);
    return prem.length ? `allowModels includes ${prem.join(", ")}` : null;
  }
  const ap = (rule && rule.allowProviders) || [];
  if (ap.length && !ap.includes("claudecode")) return null;
  return rule ? "no allowModels — every claudecode id, opus and fable included"
              : "no routing rule at all — every claudecode id, opus and fable included";
}

// name -> why, for every app-kind consumer that can currently reach a premium model.
function premiumApps(cfg) {
  const out = new Map();
  for (const [name, e] of Object.entries((cfg && cfg.consumers) || {})) {
    if (!e || e.kind !== "app") continue;
    const why = premiumWhy(cfg, name);
    if (why) out.set(name, why);
  }
  return out;
}

// Diff against the last look and alert on ADDITIONS only. Called from persistConfig(), which is the
// one place every registry write, every panel save and every /api/routes edit passes through — so
// there is no path that creates an opus-capable app without going past here. The FIRST call sets the
// baseline silently (loadConfig does it at boot), or a restart would page about every app we already
// have. Returns what it alerted on, so a test can assert on it without a network.
let baseline = null;
function watchPremiumApps(cfg) {
  const now = premiumApps(cfg);
  if (!baseline) { baseline = now; return []; }
  const added = [...now].filter(([n]) => !baseline.has(n)).map(([name, why]) => ({ name, why }));
  baseline = now;
  for (const a of added)
    notifyHuman(`⚠️ llm.hostbun.cc — app "${a.name}" can now use PREMIUM models (opus/fable) on the shared Claude Max pool.\n`
      + `why: ${a.why}\n`
      + `opus is ~5x and fable ~10x haiku per token, and both burn the shared 5h/7d windows fastest.\n`
      + `restrict it: POST /api/routes {"project":"${a.name}","allowModels":[...]} — or panel → Routing → Rules`);
  return added;
}

module.exports = { notifyHuman, premiumApps, premiumWhy, watchPremiumApps, alertHealth };
