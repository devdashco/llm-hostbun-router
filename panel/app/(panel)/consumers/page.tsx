"use client";
import { Tabbed } from "@/components/panel/tabbed";
import { Consumers } from "@/components/panel/pages/consumers";
import { Access } from "@/components/panel/pages/access";

// Inbound: who is allowed to call this router, and under what key. The account pool moved to
// /providers — a Claude Max subscription is an upstream we call, not a caller identity.
export default function ConsumersPage() {
  return (
    <Tabbed
      def="consumers"
      items={[
        ["consumers", "Consumers", Consumers],
        ["access", "Access", Access],
      ]}
    />
  );
}
