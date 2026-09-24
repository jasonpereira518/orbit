import { AdminLoading } from "@/components/admin/loading-shells";
import { TrafficTabs } from "@/components/admin/traffic-tabs";

export default function AdminEngagementLoading() {
  return (
    <AdminLoading
      title="Engagement"
      subtitle="Reading what accounts did…"
      tabs={<TrafficTabs />}
      blocks={[
        { range: true },
        { tiles: 4 },
        { panel: true, title: "Imports completed, by provider", height: "h-24" },
        { panel: true, title: "Captures saved, by source", height: "h-24" },
        { panel: true, title: "Outreach messages sent, by channel", height: "h-24" },
      ]}
    />
  );
}
