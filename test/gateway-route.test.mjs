// cccc/shell/gateway-route.sh — what a shell ends up with, per branch.
//
//   node test/gateway-route.test.mjs
//
// This script decides, on every new shell, whether `claude` talks to the router or straight to
// api.anthropic.com, and whether it ships OTel. Both halves are silent when wrong: a routed box that
// also shipped OTel double-counts every call, and a direct box that ships OTel with the wrong
// credential loses every call instead. The second one was live — pbox's ~/.claude/settings.json
// carries a GENERIC OTEL_EXPORTER_OTLP_HEADERS holding a HyperDX token, settings env is applied over
// the shell's, so the router saw a steady stream of `[otel] 401 no key … ua=OTel-OTLP-Exporter-…`
// and every direct-connect call on that box went unlogged.
//
// It sources the real script in bash with a throwaway HOME and prints the environment, so what is
// asserted is what a shell actually gets.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "cccc/shell/gateway-route.sh");

let pass = 0, fail = 0;
const check = (label, actual, expected) => (JSON.stringify(actual) === JSON.stringify(expected)
  ? (pass++, console.log(`  ok    ${label}`))
  : (fail++, console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`)));

// Source the script with a HOME we control, and dump the env it leaves behind.
const run = (home, base) => {
  const out = execFileSync("bash", ["-c", `. "${SCRIPT}" >/dev/null 2>&1; env`], {
    encoding: "utf8", env: { ...process.env, HOME: home, CCCC_GATEWAY_BASE: base },
  });
  const env = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
};

const home = fs.mkdtempSync(join(os.tmpdir(), "gw-route-"));
fs.mkdirSync(join(home, ".claude-accounts"), { recursive: true });
fs.mkdirSync(join(home, ".claude"), { recursive: true });
fs.writeFileSync(join(home, ".claude-accounts", ".cccc-key"), "sk-llm-abcd1234-secret\n");
fs.writeFileSync(join(home, ".claude-accounts", ".cccc-machine"), "pbox\n");

// A port nothing is listening on: the health probe fails, so this is the DIRECT branch — the one
// that must ship telemetry, because the router will not be writing a row for these calls.
const dead = await new Promise((r) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); });
});

console.log("gateway-route.sh — the direct branch ships OTel it can authenticate:");
{
  fs.rmSync(join(home, ".claude", ".cctl-route"), { force: true });
  const env = run(home, `http://127.0.0.1:${dead}`);
  check("telemetry is on", env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
  check("logs go to the router's ingest, not the generic endpoint",
    env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, `http://127.0.0.1:${dead}/otel/v1/logs`);
  // The one that was missing. Generic-only is overwritten by a settings.json that sets the generic
  // form for a different backend; per-signal wins in the OTLP spec and settings.json does not set it.
  check("the LOGS-specific header carries this box's router key",
    env.OTEL_EXPORTER_OTLP_LOGS_HEADERS, "Authorization=Bearer sk-llm-abcd1234-secret");
  check("...and the generic header still does too, for a box with no conflicting config",
    env.OTEL_EXPORTER_OTLP_HEADERS, "Authorization=Bearer sk-llm-abcd1234-secret");
  check("http/json, because the router cannot decode protobuf", env.OTEL_EXPORTER_OTLP_PROTOCOL, "http/json");
  // The router credential is worthless against api.anthropic.com — exporting it would 401 the
  // inference itself, which is the opposite of what this branch is for.
  check("the router key is NOT presented as the Anthropic token", env.ANTHROPIC_AUTH_TOKEN, undefined);
}

console.log("\ngateway-route.sh — a box with no key ships nothing:");
{
  const bare = fs.mkdtempSync(join(os.tmpdir(), "gw-route-bare-"));
  fs.mkdirSync(join(bare, ".claude-accounts"), { recursive: true });
  fs.mkdirSync(join(bare, ".claude"), { recursive: true });
  const env = run(bare, `http://127.0.0.1:${dead}`);
  // Shipping unauthenticated is what produced the 401 flood in the router's log. No key, no export.
  check("telemetry stays off with no credential to send", env.CLAUDE_CODE_ENABLE_TELEMETRY, undefined);
  check("...and no logs endpoint is left pointing at the router", env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, undefined);
  check("...and no per-signal header is left behind", env.OTEL_EXPORTER_OTLP_LOGS_HEADERS, undefined);
  fs.rmSync(bare, { recursive: true, force: true });
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
