import { AdminLoading } from "@/components/admin/loading-shells";
import { TrafficTabs } from "@/components/admin/traffic-tabs";

export default function AdminTrafficLoading() {
  return (
    <AdminLoading
      title="Traffic"
      subtitle="Counting page views…"
      tabs={<TrafficTabs />}
      blocks={[
        { range: true },
        { tiles: 4 },
        { panel: true, title: "Views per day", height: "h-40" },
        { panel: true, title: "Most viewed pages", height: "h-48" },
        {
          pair: [
            { title: "Countries", height: "h-32" },
            { title: "Cities", height: "h-32" },
          ],
        },
      ]}
    />
  );
}
