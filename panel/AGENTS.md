<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# shadcn/ui — how it must be used here

shadcn is **not a dependency**; the CLI copies source into `components/ui/` and we own it. Run every
CLI command **from `panel/`** — `components.json` lives there, not at the repo root.

Setup as it actually is (don't "fix" these to match a generic recipe): style **`radix-nova`**,
baseColor **`neutral`**, `cssVariables: true`, Tailwind **v4** (no `tailwind.config`, theme lives in
`app/globals.css`), icons **lucide**, aliases on `@/*` → `panel/*`. `style` / `baseColor` /
`cssVariables` are **immutable after init** — a different look is theme-CSS work, never a re-init.

1. **Add primitives via the CLI, never by hand** — `npx shadcn@latest add dialog` from `panel/`.
   A hand-written file in `components/ui/` is a bug. Discover names with the `shadcn` MCP
   (`.mcp.json` at the repo root) or `npx shadcn@latest search <q>` — don't guess.
2. **Compose feature UI from primitives** in `components/panel/`. Never edit a `ui/` primitive for a
   one-off; wrap it or override via props (`ui/*` components spread `{...props}` last).
3. **Semantic tokens only** — `bg-card text-card-foreground`, plus our own `text-ok` / `text-warn` /
   `text-danger` / `bg-sunken` / `text-brand` / `bg-p-claudecode`. Never a raw palette class
   (`bg-zinc-900`) and never `accent-[var(--brand)]`-style escapes into a token.
4. **New color = new token**: define under `.dark` in `globals.css` **and** register it in
   `@theme inline` as `--color-<name>`, or no Tailwind utility exists for it.
5. **The panel is dark-only.** `<html className="dark">` is forced in `app/layout.tsx`; there is no
   `next-themes` ThemeProvider. The `:root` light block is what shadcn shipped and is never applied.
   Any primitive that calls `useTheme()` (e.g. `ui/sonner`) will read `"system"` and render light —
   pass `theme="dark"` at the call site, as `shell.tsx` does for `<Toaster>`.
6. **Type scale: four steps, no bracket sizes.** `text-micro` (10px) · `text-meta` (11.5px) ·
   `text-ui` (12.5px) · `text-body` (13px), defined in the `@theme` block in `globals.css`; anything
   bigger uses Tailwind's own `text-sm`/`base`/`lg`. **Never write `text-[13px]`** — that is how ten
   sizes between 9.5px and 13.5px accumulated here in the first place. Spacing likewise stays on the
   scale: `space-y-4.5`, not `space-y-[18px]` (v4 accepts fractional steps). Bracket values are still
   fine for genuine layout constraints — `max-h-[340px]`, `w-[min(440px,90vw)]`, `grid-cols-[…]`.
7. **`cn()` from `@/lib/utils`** for conditional/merged classes.
8. **Zero external requests at runtime** — no `next/font`, no CDN, no remote images. Fonts are the
   system stack in `--font-sans` / `--font-mono`. A CLI-added component that pulls a web font or a
   remote asset must be stripped of it before it ships.
