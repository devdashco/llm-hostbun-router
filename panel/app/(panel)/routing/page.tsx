"use client";
import { Tabbed } from "@/components/panel/tabbed";
import { Rules } from "@/components/panel/pages/rules";
import { Models } from "@/components/panel/pages/models";

export default function RoutingPage() {
  return (
    <Tabbed
      def="rules"
      items={[
        ["rules", "Rules", Rules],
        ["models", "Models", Models],
      ]}
    />
  );
}
