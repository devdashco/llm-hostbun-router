// One gate per GPU BOX — src/gate.js keyFor() + limitFor().
//
//   node test/gate-perbox.test.mjs      (also runs in `npm test`)
//
// test/gate.test.mjs proves the gate serialises; this file proves it serialises the RIGHT SET. They
// are separate because the bug this pins is invisible to a concurrency count: on 2026-08-04
// agentic-marketplace held `local` at 4/4 with 8 queued against pbox, and ww's qwen3.5-2b answered
// in 9-11 s through the router while answering in 0.06 s when asked directly. Every request was a
// 200. The gate was working perfectly and queueing for a GPU the caller never touched.
//
// The trap worth a test of its own: limitFor() looks up DEFAULTS[key]. Key by base without
// splitting the provider back off and DEFAULTS["local@host"] is undefined -> Number.isFinite(NaN)
// is false -> limit 0 -> `gateFor` returns null -> `run` calls straight through. Admission control
// deletes itself, silently, and every test that only counts concurrency on ONE box still passes.
import { keyFor, limitFor } from "../src/gate.js";

let pass = 0, fail = 0;
const check = (name, cond, why) => cond
  ? (pass++, console.log(`  ok    ${name}`))
  : (fail++, console.log(`  FAIL  ${name}\n        ${why}`));

console.log("gate keys — one queue per box, limits still resolve:");

const PBOX = "http://192.168.0.7:8080";
const WW = "http://10.0.1.250:8001";

// 1. Two local boxes must never share a key, or one box's burst queues the other's traffic.
check("two local bases -> two keys", keyFor("local", PBOX) !== keyFor("local", WW),
  `both resolved to ${keyFor("local", PBOX)}`);
check("same base -> same key", keyFor("local", WW) === keyFor("local", WW), "keyFor is not stable");

// 2. Only `local` splits. images is one box by definition, and the cloud providers are ungated —
//    handing either of them a per-base key would be a behaviour change nobody asked for.
check("images is not split", keyFor("images", PBOX) === "images", keyFor("images", PBOX));
check("claudecode is not split", keyFor("claudecode", PBOX) === "claudecode", keyFor("claudecode", PBOX));
check("local with no base falls back", keyFor("local", null) === "local", keyFor("local", null));
check("unparseable base falls back", keyFor("local", "not a url") === "local", keyFor("local", "not a url"));

// 3. THE ONE THAT MATTERS. A per-box key must still resolve a non-zero limit: 0 means ungated.
check("per-box key keeps the local default", limitFor(keyFor("local", WW)) === 4,
  `limit was ${limitFor(keyFor("local", WW))} — 0 means the gate is OFF for that box`);
check("bare provider unchanged", limitFor("local") === 4, `limit was ${limitFor("local")}`);
check("images unchanged", limitFor("images") === 1, `limit was ${limitFor("images")}`);
check("unknown provider stays ungated", limitFor("crazyrouter") === 0, "cloud providers must not gate");

// 4. Both override shapes: the blunt one still moves every box, the precise one moves one.
process.env.GATE_LOCAL = "7";
check("GATE_LOCAL still moves a per-box key", limitFor(keyFor("local", WW)) === 7,
  `limit was ${limitFor(keyFor("local", WW))}`);
process.env.GATE_LOCAL_10_0_1_250_8001 = "1";
check("GATE_LOCAL_<HOST> wins for that box", limitFor(keyFor("local", WW)) === 1,
  `limit was ${limitFor(keyFor("local", WW))}`);
check("...and leaves the other box alone", limitFor(keyFor("local", PBOX)) === 7,
  `limit was ${limitFor(keyFor("local", PBOX))}`);
delete process.env.GATE_LOCAL;
delete process.env.GATE_LOCAL_10_0_1_250_8001;

// 5. The queue is bounded and so is the key set: `gates` is keyed by CONFIGURED bases, never by
//    model or caller input, so it cannot grow with traffic. Key it by model and this Map becomes an
//    unbounded cache fed by whatever string a caller puts in "model".
const many = new Set(Array.from({ length: 500 }, (_, i) =>
  keyFor("local", i % 2 ? WW : PBOX)));
check("key set is bounded by bases, not by requests", many.size === 2, `got ${many.size} keys`);

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
