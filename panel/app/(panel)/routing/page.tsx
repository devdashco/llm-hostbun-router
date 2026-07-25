"use client";
import { Tabbed } from "@/components/panel/tabbed";
import { RoutingRules } from "@/components/panel/pages/routing";
import { Models } from "@/components/panel/pages/models";

export default function RoutingPage() {
  return (
    <Tabbed
      def="rules"
      items={[
        ["rules", "Rules", RoutingRules],
        ["models", "Models", Models],
      ]}
    />
  );
}
