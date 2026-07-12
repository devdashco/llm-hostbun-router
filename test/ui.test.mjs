// Does the control panel actually boot?
//
// The panel is nine ES modules plus a vendored preact/htm. Nothing type-checks it and nothing bundles
// it, so a wrong import name, a missing export, or an identifier left behind in another module is a
// blank page in production and a green test suite here. This loads the real shell, the real modules
// and the real server, in a real DOM, and asserts the panel renders.
//
//   node test/ui.test.mjs
//
// jsdom is a devDependency; the container installs with --omit=dev and never sees it.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CFG = join(mkdtempSync(join(tmpdir(), "llm-ui-test-")), "config.json");
const PORT = await new Promise((r) => { const s = createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => r(port)); }); });
const BASE = `http://localhost:${PORT}`;

const server = spawn("node", [join(ROOT, "server.js")], {
  env: { ...process.env, PORT: String(PORT), CONFIG_FILE: CFG, ADMIN_PASSWORD: "ddash",
         SESSION_INSECURE: "1", ADMIN_FILE: join(ROOT, "admin/index.html"), DATABASE_URL: "" },
  stdio: "ignore",
});
process.on("exit", () => server.kill());
await new Promise((r) => setTimeout(r, 2000));

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
};

// Every console.error and every uncaught exception inside the page is a failure. A panel that renders
// while throwing is not a panel that works.
const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (e) => pageErrors.push(String(e.message || e)));
virtualConsole.on("error", (...a) => pageErrors.push(a.join(" ")));

// jsdom does not execute <script type="module">, so loading the page over HTTP would run vendor.js and
// stop there. Build the same environment by hand: the real shell HTML, the real vendor bundle, then
// import the real module graph through node. Same files the browser gets, same order.
const dom = new JSDOM(readFileSync(join(ROOT, "admin/index.html"), "utf8"), {
  url: BASE, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole,
});
const { window } = dom;
window.eval(readFileSync(join(ROOT, "admin/ui/vendor.js"), "utf8"));
// The modules reach for these as globals (document, fetch, history, preact…), exactly as in a browser.
// NOT setTimeout/clearTimeout: jsdom's implementation delegates to the global one, so copying it over
// the global makes it call itself until the stack dies.
for (const k of ["window", "document", "location", "history", "HTMLInputElement", "Event", "PopStateEvent",
                 "preact", "preactHooks", "htm", "getComputedStyle"])
  Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
// The panel fetches relative /api/* paths. Resolve them against the test server — via a captured
// reference, because assigning globalThis.fetch a function that calls `fetch` calls itself.
// node's fetch has no cookie jar, and the panel's whole auth model is one HttpOnly cookie, so keep a
// one-cookie jar here. Without it every post-login request 401s and the panel looks broken.
const realFetch = globalThis.fetch;
let jar = "";
globalThis.fetch = async (u, o = {}) => {
  const headers = { ...(o.headers || {}), ...(jar ? { cookie: jar } : {}) };
  const r = await realFetch(new URL(u, BASE), { ...o, headers });
  const sc = r.headers.get("set-cookie");
  if (sc) jar = sc.split(";")[0];
  return r;
};
await import(new URL("../admin/ui/app.js", import.meta.url).href).catch((e) => pageErrors.push(`import: ${e.message}`));
// Wait for the module graph, the first render, and the /api/state round-trip that decides
// authed=false → <Login/>.
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
};
const root = () => window.document.getElementById("root");

check("vendored preact/htm loaded (no CDN)", await until(() => window.preact && window.preactHooks && window.htm));
check("the module graph executed", await until(() => root() && root().children.length > 0));

// Unauthenticated, /api/state answers 401, so the panel must land on the login form — not spin on "…".
const loggedOut = await until(() => /password/i.test(root().innerHTML));
check("renders the login form when unauthenticated", loggedOut, loggedOut ? "" : `root was: ${root().innerHTML.slice(0, 160)}`);
check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

// Log in through the real form, then assert every nav page mounts without throwing.
if (loggedOut) {
  const input = window.document.querySelector("input[type=password]");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "ddash");
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  // Let preact flush the state update before clicking: the submit handler closes over `pw`, so a
  // click in the same tick posts the value from the previous render — an empty password, a 401, and
  // a test that blames the panel for the harness's impatience.
  await new Promise((r) => setTimeout(r, 50));
  window.document.querySelector("button").click();

  const shell = await until(() => /Overview/i.test(root().textContent), 10000);
  check("logs in and mounts the shell", shell, shell ? "" : root().textContent.slice(0, 160));

  if (shell) {
    // NAV is the panel's own list of pages, plus every legacy slug that must still resolve (they
    // alias onto a page + tab). Every entry must render; a page in the nav that throws on mount is
    // exactly the "page that doesn't work" this test exists to catch.
    const slugs = ["overview", "calls", "routing", "identity", "settings",
                   "stats", "consumers", "calls", "accounts", "models", "crazyrouter", "secrets"];
    for (const slug of slugs) {
      const before = pageErrors.length;
      window.history.pushState({}, "", `/${slug}`);
      window.dispatchEvent(new window.PopStateEvent("popstate"));
      const mounted = await until(() => root().textContent.length > 0 && pageErrors.length === before, 4000);
      const clean = pageErrors.length === before;
      check(`page /${slug} mounts clean`, mounted && clean, clean ? "" : pageErrors.slice(before).join(" | "));
    }
    // A legacy slug must land on the right TAB of its new page, not just any tab. /accounts was
    // reached from /calls above, so the alias — not a leftover mount — chose what rendered. The URL
    // now reads /settings?t=secrets (last alias in the loop), and the page shows the secrets content.
    check("legacy slug rewrites the URL onto its new page + tab",
      /\/settings\b/.test(window.location.pathname) && /t=secrets/.test(window.location.search),
      `url was: ${window.location.pathname}${window.location.search}`);
    const secretsTab = await until(() => /Admin password/i.test(root().textContent));
    check("legacy /secrets lands on the Secrets tab of Settings", secretsTab);
    // And the tab strip itself switches content: click "Crazyrouter" on Settings.
    const tabBtn = [...window.document.querySelectorAll(".tabs button")].find((b) => /crazyrouter/i.test(b.textContent));
    if (tabBtn) tabBtn.click();
    const swapped = await until(() => /Update key/i.test(root().textContent));
    check("clicking a tab swaps the sub-page", !!tabBtn && swapped);
  }
}

dom.window.close();
server.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
