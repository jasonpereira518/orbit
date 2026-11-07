import { AdminLoading } from "@/components/admin/loading-shells";
import { GrowthTabs } from "@/components/admin/admin-tabs";

export default function AdminFeaturesLoading() {
  return (
    <AdminLoading
      title="Growth"
      subtitle="Reading what accounts did…"
      tabs={<GrowthTabs />}
      blocks={[
        { range: true },
        { tiles: 4 },
        {
          pair: [
            { title: "Accounts that have used each feature", height: "h-40" },
            { title: "Connector and extension", height: "h-40" },
          ],
        },
        { panel: true, title: "Actions per active account", height: "h-72" },
        { panel: true, title: "Imports completed, by provider", height: "h-24" },
      ]}
    />
  );
}
