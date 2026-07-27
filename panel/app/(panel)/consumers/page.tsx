"use client";
import { Tabbed } from "@/components/panel/tabbed";
import { Consumers } from "@/components/panel/pages/consumers";
import { Access } from "@/components/panel/pages/access";

// Inbound: who is allowed to call this router, and under what key. The account pool moved to
// /providers — a Claude Max subscription is an upstream we call, not a caller identity.
//
// The tab IDs stay `consumers`/`access` while the labels read "Callers"/"Secrets": an id is a URL
// (`?t=`), and every legacy redirect and bookmark points at those two strings.
export default function ConsumersPage() {
  return (
    <Tabbed
      def="consumers"
      items={[
        ["consumers", "Callers", Consumers],
        ["access", "Secrets", Access],
      ]}
    />
  );
}
