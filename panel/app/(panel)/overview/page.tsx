"use client";
import { Tabbed } from "@/components/panel/tabbed";
import { Health } from "@/components/panel/pages/health";
import { Usage } from "@/components/panel/pages/usage";

export default function OverviewPage() {
  return (
    <Tabbed
      def="health"
      items={[
        ["health", "Health", Health],
        ["usage", "Usage", Usage],
      ]}
    />
  );
}
