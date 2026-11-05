import { AdminLoading } from "@/components/admin/loading-shells";
import { GrowthTabs } from "@/components/admin/admin-tabs";

/** Mirrors Retention's layout block for block, so the swap does not jump. */
export default function AdminRetentionLoading() {
  return (
    <AdminLoading
      title="Growth"
      subtitle="Bucketing history…"
      tabs={<GrowthTabs />}
      blocks={[
        { range: true },
        { tiles: 5 },
        { panel: true, title: "Accounts over time", height: "h-80" },
        { tiles: 4 },
        { panel: true, title: "Did something", height: "h-80" },
        { panel: true, title: "Retention by signup month", height: "h-72" },
      ]}
    />
  );
}
