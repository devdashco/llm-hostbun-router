"use client";
import { Tabbed } from "@/components/panel/tabbed";
import { Accounts } from "@/components/panel/pages/accounts";
import { Crazyrouter } from "@/components/panel/pages/crazyrouter";
import { ImageTemplates } from "@/components/panel/pages/image-templates";

// Outbound: every upstream we spend against. The claudecode Max pool and the crazyrouter relay are
// the two that carry credentials; `local` is free and configured by env, so it has no tab here.
// Image templates sit beside crazyrouter because that is the upstream they are billed against —
// SD-Turbo, the free image path, has no configuration a person edits.
export default function ProvidersPage() {
  return (
    <Tabbed
      def="accounts"
      items={[
        ["accounts", "Accounts", Accounts],
        ["crazyrouter", "Crazyrouter", Crazyrouter],
        ["image-templates", "Image templates", ImageTemplates],
      ]}
    />
  );
}
