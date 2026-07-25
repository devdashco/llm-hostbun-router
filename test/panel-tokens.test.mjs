// The panel's design tokens, enforced. Reads SOURCE (not the build), so it runs in plain `npm test`
// with no `panel/ npm ci` first — unlike panel-secrets.test.mjs, which needs panel/out.
//
// Why this exists: shadcn's whole contract is that look-and-feel lives in CSS variables, so a
// component that hardcodes a colour or a pixel size silently opts out of the theme. Both had already
// happened here — one `accent-[var(--brand)]` escaping a token that was never registered, and 141
// hand-typed font sizes spread over TEN values between 9.5px and 13.5px. That is not a type scale,
// it is drift, and it only regrows if nothing is watching. So: watch it.
//
// Scope is panel/components/panel + panel/app — the code WE write. panel/components/ui is exempt:
// those files are `shadcn add` output that we do not hand-edit (see panel/AGENTS.md), and the
// upstream `button` primitive genuinely ships a `text-[0.8rem]`.
import { readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const PANEL = join(fileURLToPath(new URL(".", import.meta.url)), "..", "panel");
const ROOTS = [join(PANEL, "components", "panel"), join(PANEL, "app")];
const CSS = join(PANEL, "app", "globals.css");

let pass = 0;
const fail = (m) => {
  console.error("  FAIL  " + m);
  process.exitCode = 1;
};
const ok = (m) => {
  console.log("  ok    " + m);
  pass++;
};

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if ([".tsx", ".ts"].includes(extname(e.name))) out.push(p);
  }
  return out;
};
const files = ROOTS.flatMap((r) => walk(r));
const rel = (f) => f.slice(PANEL.length + 1);

const scan = (re) => {
  const hits = [];
  for (const f of files) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(re)) hits.push(`${rel(f)}:${i + 1} ${m[0]}`);
      });
  }
  return hits;
};

// 1. No bracket font sizes. The scale is text-micro | text-meta | text-ui | text-body, then
//    Tailwind's own text-sm/base/lg. A new size is almost always the wrong answer — pick a step.
{
  const hits = scan(/\btext-\[[0-9][^\]]*\]/g);
  hits.length
    ? fail(`bracket font size — use the type scale (panel/AGENTS.md §6):\n        ${hits.join("\n        ")}`)
    : ok(`no bracket font sizes in ${files.length} panel source files`);
}

// 2. No raw Tailwind palette. cssVariables is true, so a palette class bypasses the theme entirely
//    and will not follow it when the theme changes.
{
  const hits = scan(/\b(?:bg|text|border|ring|fill|stroke|from|via|to)-(?:zinc|slate|neutral|gray|stone)-\d{2,3}\b/g);
  hits.length
    ? fail(`raw palette class — use a semantic token:\n        ${hits.join("\n        ")}`)
    : ok("no raw Tailwind palette classes (semantic tokens only)");
}

// 3. No escaping into a CSS variable to dodge a missing token. `accent-[var(--brand)]` means the
//    token was never registered in @theme inline — register it, don't bracket around it.
{
  const hits = scan(/\b[a-z-]+-\[var\(--[a-z-]+\)\]/g);
  hits.length
    ? fail(`bracketed var() — register the token in @theme inline instead:\n        ${hits.join("\n        ")}`)
    : ok("no bracketed var() escapes (every token has a real utility)");
}

// 4. Every custom colour used as a utility is actually registered. A `--brand` defined under .dark
//    but absent from @theme inline compiles to nothing: the class is silently dropped and the
//    element renders unstyled, which is far harder to spot than a build error.
{
  const css = readFileSync(CSS, "utf8");
  const themeBlock = css.slice(css.indexOf("@theme inline"), css.indexOf("\n}", css.indexOf("@theme inline")));
  const darkBlock = css.slice(css.indexOf("\n.dark {"), css.indexOf("\n}", css.indexOf("\n.dark {")));
  const declared = [...darkBlock.matchAll(/^\s*--([a-z0-9-]+):/gm)].map((m) => m[1]);
  const registered = new Set([...themeBlock.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]));
  // Only colour-ish tokens need a --color-* twin; fonts/radius/charts have their own namespaces.
  const skip = /^(font-|radius|chart-|sidebar|background|foreground|card|popover|primary|secondary|muted|accent|destructive|border|input|ring)/;
  const missing = declared.filter((n) => !skip.test(n) && !registered.has(n));
  missing.length
    ? fail(`token declared in .dark but not registered in @theme inline (no utility generated): ${missing.join(", ")}`)
    : ok(`every custom .dark colour token is registered in @theme inline (${declared.length} declared)`);
}

// 5. The scale itself exists and has exactly the four documented steps.
{
  const css = readFileSync(CSS, "utf8");
  const steps = [...css.matchAll(/^\s*--text-([a-z]+):\s*([^;]+);/gm)].map((m) => `${m[1]}=${m[2].trim()}`);
  const want = ["micro=10px", "meta=11.5px", "ui=12.5px", "body=13px"];
  steps.join(",") === want.join(",")
    ? ok(`type scale is the four documented steps (${steps.join(" · ")})`)
    : fail(`type scale drifted — expected ${want.join(" · ")}, got ${steps.join(" · ") || "(none)"}`);
}

console.log(`\n${pass} passed${process.exitCode ? ", FAILURES above" : ", 0 failed"}`);
