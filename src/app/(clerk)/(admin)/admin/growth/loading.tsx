import { AdminLoading } from "@/components/admin/loading-shells";
import { GrowthTabs } from "@/components/admin/admin-tabs";

/** Mirrors Acquisition's layout block for block, so the swap does not jump. */
export default function AdminAcquisitionLoading() {
  return (
    <AdminLoading
      title="Growth"
      subtitle="Counting page views…"
      tabs={<GrowthTabs />}
      blocks={[
        { range: true },
        { tiles: 5 },
        { panel: true, title: "Views per day", height: "h-40" },
        { panel: true, title: "Conversion funnel", height: "h-64" },
        { panel: true, title: "Most viewed pages", height: "h-48" },
      ]}
    />
  );
}
