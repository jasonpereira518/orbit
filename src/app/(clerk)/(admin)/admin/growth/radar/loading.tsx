import { AdminLoading } from "@/components/admin/loading-shells";
import { GrowthTabs } from "@/components/admin/admin-tabs";

export default function AdminRadarLoading() {
  return (
    <AdminLoading
      title="Growth"
      subtitle="Reading what people did with Radar…"
      tabs={<GrowthTabs />}
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
