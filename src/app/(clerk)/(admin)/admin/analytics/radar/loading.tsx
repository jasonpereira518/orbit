import { AdminLoading } from "@/components/admin/loading-shells";
import { TrafficTabs } from "@/components/admin/traffic-tabs";

export default function AdminRadarLoading() {
  return (
    <AdminLoading
      title="Radar"
      subtitle="Reading what people did with Radar…"
      tabs={<TrafficTabs />}
      blocks={[
        { range: true },
        { tiles: 4 },
        { panel: true, title: "By kind", height: "h-32" },
        { panel: true, title: "Did the AI rerank help?", height: "h-24" },
        { panel: true, title: "Pre-written drafts", height: "h-20" },
        { panel: true, title: "Runs", height: "h-20" },
      ]}
    />
  );
}
