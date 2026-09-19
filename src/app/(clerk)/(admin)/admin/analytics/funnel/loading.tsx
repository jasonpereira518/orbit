import { AdminLoading } from "@/components/admin/loading-shells";
import { TrafficTabs } from "@/components/admin/traffic-tabs";

export default function AdminFunnelLoading() {
  return (
    <AdminLoading
      title="Conversion"
      subtitle="Joining traffic to accounts…"
      tabs={<TrafficTabs />}
      blocks={[
        { range: true },
        { panel: true, title: "The funnel", height: "h-64" },
        { panel: true, title: "How to read this", height: "h-40" },
      ]}
    />
  );
}
