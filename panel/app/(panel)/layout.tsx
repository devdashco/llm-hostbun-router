"use client";
import { usePathname } from "next/navigation";
import { PanelGate, NAV } from "@/components/panel/shell";

// Legacy slugs collapse onto their canonical nav page for the active-highlight (they also redirect;
// see each legacy route). Mirrors admin/ui/core.js SLUG_ALIAS. `identity`/`settings` are themselves
// legacy as of the 2026-07-26 rename: the account pool is outbound (providers), the auth gate is
// inbound (consumers), and neither belonged under the word it was filed at.
const ALIAS: Record<string, string> = {
  stats: "overview",
  models: "routing",
  identity: "consumers",
  settings: "consumers",
  secrets: "consumers",
  accounts: "providers",
  crazyrouter: "providers",
};
// Derived from the nav itself — a sixth nav entry with a hand-maintained list here silently
// highlighted "Overview" on the new page.
const SLUGS = NAV.map((n) => n.slug);

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname() || "/";
  let s = path.replace(/^\/+/, "").split("/")[0] || "overview";
  s = ALIAS[s] || s;
  const active = SLUGS.includes(s) ? s : "overview";
  return <PanelGate active={active}>{children}</PanelGate>;
}
