// What the PUBLIC docs claim, checked against the code — and what they must never publish.
//
//   node test/docs-claims.test.mjs      (also runs in `npm test`)
//
// These checks read files and nothing else. They lived in docs.test.mjs, which needs jsdom (a dev
// dependency) to prove the docsify site actually renders — so it is deliberately outside `npm test`
// and only runs when someone remembers. That left the checks that matter most on every push, the
// ones that stop a stale security claim or a live secret being published, running never.
//
// Split by what they need, not by subject: rendering needs a browser, truth needs a file read.
// docs.test.mjs keeps the render, the sidebar links, the traversal probes and the 301.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const req_ = createRequire(import.meta.url);
const DOCS = join(ROOT, "docs");
const pages = readdirSync(DOCS).filter((f) => f.endsWith(".md"));
const md = (f) => readFileSync(join(DOCS, f), "utf8");
const all = pages.map(md).join("\n") + readFileSync(join(DOCS, "index.html"), "utf8");

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => (cond
  ? (pass++, console.log(`  ok    ${label}`))
  : (fail++, console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`)));

console.log("nothing secret is published:");
// The docs describe the panel and the key format; they must never carry a live value.
check("no admin password", !/\bddash\b/.test(all));
check("no Max setup token", !/sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/.test(all)); // real token body, not the bare prefix
check("no complete API key", !/sk-llm-[0-9a-f]{8}-[\w-]{20,}/.test(all));
check("no DATABASE_URL", !/postgres(ql)?:\/\/[^\s`]+:[^\s`]+@/.test(all));

console.log("\nnothing false is published:");
// This site is public and unauthenticated, read by people who cannot check it against the code. It
// told readers for weeks that `auth.mode` was `optional`, that "the network is the only boundary"
// and to treat the URL as a secret — while prod had been `required` the whole time. Read literally
// it said: do not bother sending a key. A stale security claim is worse than none.
{
  const claims = md("README.md") + md("identity.md") + md("quickstart.md");
  const stale = [
    [/auth\.mode` is still `optional`|Currently `optional`/, "says auth.mode is optional — prod is `required`"],
    [/the network is the only boundary/, "says the network is the only boundary — a key is required"],
    [/while auth\.mode is optional/, "offers a placeholder key as an alternative to a real one"],
  ];
  const found = stale.filter(([re]) => re.test(claims)).map(([, why]) => why);
  check("the published auth posture is current", found.length === 0, found.join("; "));
}

// A lead example that 401s teaches the wrong thing regardless of what the prose says.
{
  const firstCurl = (md("quickstart.md").match(/```bash[\s\S]*?```/) || [""])[0];
  check("the first quickstart example sends a key",
    /Authorization: Bearer sk-llm-|x-api-key/i.test(firstCurl), firstCurl.slice(0, 200));
}

// Every image id the router accepts must be listed, and the docs must not name one it refuses. The
// id MISSING from the docs is the one a caller sends to a text endpoint and is refused on — or
// worse, the one that reaches crazyrouter per-token for a 404. That is why IMAGE_MODEL_IDS exists.
{
  const routing = md("routing.md");
  const ids = req_(join(ROOT, "src", "config.js")).IMAGE_MODEL_IDS;
  const missing = ids.filter((id) => !new RegExp("`" + id + "`").test(routing));
  check(`every image model id is documented (${ids.length} ids)`, missing.length === 0, `missing: ${missing.join(", ")}`);
}

// The page table drifted a full rename behind the panel: it still said Consumers/Providers after
// the 2026-07-27 rename to Callers/Upstreams, so a reader looked for nav entries that are not
// there. panel-nav.test.mjs keeps the five files INSIDE the panel agreeing; nothing kept the
// published description honest.
{
  const shell = readFileSync(join(ROOT, "panel", "components", "panel", "shell.tsx"), "utf8");
  const navNames = [...shell.matchAll(/\{\s*name:\s*"([^"]+)",\s*slug:/g)].map((m) => m[1]);
  const adminDoc = md("admin.md");
  const missing = navNames.filter((n) => !adminDoc.includes(`| ${n} |`));
  check(`the published page table names the panel's pages (${navNames.length})`, missing.length === 0,
    `missing rows for: ${missing.join(", ")}`);
}

// A documented URL on THIS host that this host does not serve sends a reader to a 400 —
// `/dashboard/billing/*` is crazyrouter's API, called server-side, and was published as ours.
check("no doc points a reader at llm.hostbun.cc/dashboard/* — that is crazyrouter's API, not ours",
  !/llm\.hostbun\.cc\/dashboard\//.test(all));

console.log("\nthe operating manual matches the gate:");
// CLAUDE.md is what the next person (or agent) reads before touching anything, and it said "Nine
// suites, 302 checks" while `npm test` had grown to twenty. A manual that is wrong about the gate is
// how a suite gets added and then quietly dropped: nobody notices the list shrink back.
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const suites = [...pkg.scripts.test.matchAll(/node (\S+\.(?:mjs|js))/g)].map((m) => m[1]);
  const manual = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
  const undocumented = suites.filter((f) => !manual.includes(f.replace(/^test\//, "")));
  check(`every suite in the gate is described (${suites.length})`, undocumented.length === 0,
    `not mentioned in CLAUDE.md: ${undocumented.join(", ")}`);
  const claimed = (manual.match(/## Tests — `npm test` \((\d+) suites/) || [])[1];
  check("the manual's suite COUNT is current", Number(claimed) === suites.length,
    `manual says ${claimed}, package.json runs ${suites.length}`);
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
