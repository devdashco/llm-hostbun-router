"use client";
import { Tabbed } from "@/components/panel/tabbed";
import { Accounts } from "@/components/panel/pages/accounts";
import { Crazyrouter } from "@/components/panel/pages/crazyrouter";

// Outbound: every upstream we spend against. The claudecode Max pool and the crazyrouter relay are
// the two that carry credentials; `local` is free and configured by env, so it has no tab here.
export default function ProvidersPage() {
  return (
    <Tabbed
      def="accounts"
      items={[
        ["accounts", "Accounts", Accounts],
        ["crazyrouter", "Crazyrouter", Crazyrouter],
      ]}
    />
  );
}
