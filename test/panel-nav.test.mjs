// The panel's navigation, read from SOURCE (so it needs no `panel/` build, like panel-tokens).
//
// Five separate files have to agree about what the pages are called, and nothing checked that they
// did. The nav lived in shell.tsx, a second hand-kept slug list in layout.tsx, the served-route
// whitelist in src/config.js, one page.tsx per slug, and a PageHead title inside each component.
// Every mismatch is silent and every one of them had happened:
//
//   · a slug in the nav but not in UI_ROUTES  → hard-refresh 404s that tab (the shell is only
//     served for enumerated slugs; a catch-all would shadow /v1/*, so this list is load-bearing)
//   · a legacy redirect pointing at a slug with no page.tsx → a bookmark lands on nothing
//   · a nav label, its landing tab and its heading all saying different words → the thing that
//     made "Identity" hold the outbound account pool for two weeks without anyone noticing
//
// Regex over source, not a bundler: this suite is zero-dep and must stay runnable before a build.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = join(ROOT, "panel");
const ROUTES_DIR = join(PANEL, "app", "(panel)");
const PAGES_DIR = join(PANEL, "components", "panel", "pages");

let pass = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const fail = (m) => { console.log(`  FAIL  ${m}`); process.exitCode = 1; };
const read = (p) => readFileSync(p, "utf8");

// ── what the source says ────────────────────────────────────────────────────────────────────────
const shell = read(join(PANEL, "components", "panel", "shell.tsx"));
const NAV = [...shell.matchAll(/\{\s*name:\s*"([^"]+)",\s*slug:\s*"([^"]+)"/g)].map(([, name, slug]) => ({ name, slug }));

const layout = read(join(ROUTES_DIR, "layout.tsx"));
const aliasBlock = layout.match(/const ALIAS[^=]*=\s*\{([\s\S]*?)\n\}/);
const ALIAS = Object.fromEntries([...(aliasBlock?.[1] || "").matchAll(/(\w+):\s*"([^"]+)"/g)].map(([, k, v]) => [k, v]));

const cfg = read(join(ROOT, "src", "config.js"));
const uiBlock = cfg.match(/const UI_ROUTES = new Set\(\[([\s\S]*?)\]\)/);
const UI_ROUTES = new Set([...(uiBlock?.[1] || "").matchAll(/"\/([^"]+)"/g)].map(([, s]) => s));

const routeDirs = readdirSync(ROUTES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROUTES_DIR, d.name, "page.tsx")))
  .map((d) => d.name);

// A page.tsx is either a Tabbed page (its own tabs) or a LegacyRedirect (slug + tab it forwards to).
const routes = new Map(routeDirs.map((slug) => {
  const src = read(join(ROUTES_DIR, slug, "page.tsx"));
  const redirect = src.match(/<LegacyRedirect\s+slug="([^"]+)"\s+tab="([^"]+)"/);
  const tabs = [...src.matchAll(/\["([\w-]+)",\s*"([^"]+)",\s*(\w+)\]/g)].map(([, id, label, comp]) => ({ id, label, comp }));
  const single = src.match(/return <(\w+) \/>/);
  return [slug, { redirect: redirect && { slug: redirect[1], tab: redirect[2] }, tabs, single: single?.[1], src }];
}));

// Component name → the PageHead title it renders. One file may export several (accounts.tsx).
const titles = new Map();
for (const f of readdirSync(PAGES_DIR).filter((f) => f.endsWith(".tsx"))) {
  const src = read(join(PAGES_DIR, f));
  for (const m of src.matchAll(/export function (\w+)\(\)[\s\S]*?(?=\nexport function |$)/g)) {
    const t = m[0].match(/<PageHead[\s\S]*?title="([^"]+)"/) || m[0].match(/title="([^"]+)"/);
    if (t) titles.set(m[1], t[1]);
  }
}

// ── the checks ──────────────────────────────────────────────────────────────────────────────────
console.log("panel nav:");
if (NAV.length < 3) fail(`parsed only ${NAV.length} NAV entries from shell.tsx — the regex has drifted from the source`);
else ok(`${NAV.length} nav entries parsed (${NAV.map((n) => n.name).join(" · ")})`);

const navSlugs = new Set(NAV.map((n) => n.slug));
for (const { name, slug } of NAV) {
  if (!routes.has(slug)) fail(`nav "${name}" → /${slug}/ has no app/(panel)/${slug}/page.tsx`);
  else if (routes.get(slug).redirect) fail(`nav "${name}" → /${slug}/ is a LegacyRedirect, not a real page`);
  else ok(`nav "${name}" → /${slug}/ is a real page`);

  // Without this the slug is served only by the client router: a hard refresh or a pasted link
  // falls through to the model router and answers "model_not_routable" instead of the panel.
  if (!UI_ROUTES.has(slug)) fail(`nav slug "${slug}" is missing from UI_ROUTES in src/config.js — a hard refresh 404s`);
  else ok(`nav slug "${slug}" is served by UI_ROUTES`);
}

console.log("\nlegacy redirects:");
for (const [slug, r] of routes) {
  if (!r.redirect) continue;
  const target = routes.get(r.redirect.slug);
  if (!target) fail(`/${slug}/ redirects to /${r.redirect.slug}/, which has no page`);
  else if (target.redirect) fail(`/${slug}/ redirects to /${r.redirect.slug}/, which is itself a redirect (chain)`);
  else if (!navSlugs.has(r.redirect.slug)) fail(`/${slug}/ redirects to /${r.redirect.slug}/, which is not in the nav`);
  else if (target.tabs.length && !target.tabs.some((t) => t.id === r.redirect.tab))
    fail(`/${slug}/ redirects to ?t=${r.redirect.tab}, but /${r.redirect.slug}/ has no such tab (${target.tabs.map((t) => t.id).join(", ")})`);
  else ok(`/${slug}/ → /${r.redirect.slug}/?t=${r.redirect.tab}`);

  if (!UI_ROUTES.has(slug)) fail(`legacy slug "${slug}" is missing from UI_ROUTES — the bookmark it exists for 404s`);
  // The highlight comes from ALIAS; without an entry the legacy slug highlights nothing on arrival.
  if (ALIAS[slug] !== r.redirect.slug)
    fail(`ALIAS["${slug}"] is ${ALIAS[slug] ? `"${ALIAS[slug]}"` : "missing"}, but its page redirects to "${r.redirect.slug}"`);
}
if (!process.exitCode) ok("every legacy slug redirects to a real page, a real tab, and highlights the right nav entry");

console.log("\nnav label == landing tab == page heading:");
for (const { name, slug } of NAV) {
  const r = routes.get(slug);
  if (!r) continue;
  if (r.single) {
    // A single-component page: the nav label is the heading, there is no tab strip.
    const t = titles.get(r.single);
    // A MISSING heading has to fail. `t && t !== name` sent every falsy `t` — no <PageHead
    // title=…> at all, or a regex that simply missed — down the else branch and reported ok, so a
    // page with no heading was indistinguishable from a correct one. That is the exact bug this
    // file exists to catch, in the file that catches it. Probed: stripping every title= from
    // call-log.tsx left the suite green at 33 passed.
    if (!t) fail(`nav "${name}" (/${slug}/) renders <${r.single}/>, which has no discoverable <PageHead title=…>`);
    else if (t !== name) fail(`nav "${name}" (/${slug}/) renders <${r.single}/>, whose heading is "${t}"`);
    else ok(`nav "${name}" → heading "${t}"`);
    continue;
  }
  for (const tab of r.tabs) {
    const t = titles.get(tab.comp);
    // Same rule for a tab: a component with no heading is a finding, not a reason to skip. The
    // silent `continue` here dropped the comparison for that tab with nothing saying so.
    if (!t) { fail(`/${slug}/ tab "${tab.label}" renders <${tab.comp}/>, which has no discoverable <PageHead title=…>`); continue; }
    if (t !== tab.label) fail(`/${slug}/ tab "${tab.label}" renders <${tab.comp}/>, whose heading is "${t}"`);
    else ok(`/${slug}/ tab "${tab.label}" → heading "${t}"`);
  }
}

// Every UI_ROUTES entry must be a slug we actually build, or the server advertises a 404.
console.log("\nUI_ROUTES:");
for (const slug of UI_ROUTES) {
  if (!routes.has(slug)) fail(`UI_ROUTES has "/${slug}" but there is no app/(panel)/${slug}/page.tsx to serve`);
}
if (!process.exitCode) ok(`all ${UI_ROUTES.size} served slugs have a page`);

// ── the panel's window list must match the server's ─────────────────────────────────────────────
// panel/lib/routing-helpers.ts carries its own LIM_WINDOWS because the panel is a separate static
// build with no way to import src/config.js. That copy is the one that bites: offer a window the
// server's sanitizeLimit() does not accept and the operator saves a cap that silently becomes
// "24h", with no error anywhere. The server side is derived from WINDOW_MS, so this pins the only
// remaining hand-kept copy.
console.log("\nlimit windows:");
{
  const req_ = createRequire(import.meta.url);
  const { LIMIT_WINDOWS, LIMIT_HARD, PROVIDERS } = req_(join(ROOT, "src", "config.js"));
  const helpers = read(join(PANEL, "lib", "routing-helpers.ts"));
  const m = helpers.match(/export const LIM_WINDOWS\s*=\s*\[([^\]]*)\]/);
  if (!m) fail("could not find LIM_WINDOWS in panel/lib/routing-helpers.ts");
  else {
    const panelWins = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    if (JSON.stringify(panelWins) === JSON.stringify(LIMIT_WINDOWS))
      ok(`panel LIM_WINDOWS matches the server (${panelWins.join(", ")})`);
    else fail(`panel offers ${JSON.stringify(panelWins)} but the server accepts ${JSON.stringify(LIMIT_WINDOWS)} — a cap saved on a window the server rejects silently becomes 24h`);
  }

  // Same hazard, same fallback: sanitizeLimit() rewrites an unknown `hard` to "block", so a panel
  // offering an action the server does not know turns "warn only" into a 429 without saying so.
  const hardM = helpers.match(/export const LIM_HARD[^=]*=\s*\[([\s\S]*?)\];/);
  if (!hardM) fail("could not find LIM_HARD in panel/lib/routing-helpers.ts");
  else {
    const panelHard = [...hardM[1].matchAll(/\[\s*"([^"]+)"/g)].map((x) => x[1]);
    if (JSON.stringify(panelHard) === JSON.stringify(LIMIT_HARD))
      ok(`panel LIM_HARD matches the server (${panelHard.join(", ")})`);
    else fail(`panel offers hard actions ${JSON.stringify(panelHard)} but the server accepts ${JSON.stringify(LIMIT_HARD)} — an unknown one silently becomes "block"`);
  }

  // Providers: compared as a SET, because the panel deliberately orders them for display.
  const provM = read(join(PAGES_DIR, "rules-controls.tsx")).match(/export const PROVS\s*=\s*\[([^\]]*)\]/);
  if (!provM) fail("could not find PROVS in rules-controls.tsx");
  else {
    const panelProvs = [...provM[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    if (JSON.stringify(panelProvs) === JSON.stringify([...PROVIDERS].sort()))
      ok(`panel PROVS is the same set as the server's PROVIDERS (${panelProvs.join(", ")})`);
    else fail(`panel PROVS ${JSON.stringify(panelProvs)} != server PROVIDERS ${JSON.stringify([...PROVIDERS].sort())}`);
  }
}

console.log(`\n${pass} passed${process.exitCode ? " · FAILURES ABOVE" : ""}`);
