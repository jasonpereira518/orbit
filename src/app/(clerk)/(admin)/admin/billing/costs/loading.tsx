import { AdminLoading } from "@/components/admin/loading-shells";
import { MoneyTabs } from "@/components/admin/admin-tabs";

export default function AdminCostsLoading() {
  return (
    <AdminLoading
      title="Costs"
      tabs={<MoneyTabs />}
      blocks={[
        { tiles: 4 },
        { panel: true, title: "Cash in against cost out", height: "h-60" },
        { panel: true, title: "Unit economics by plan", height: "h-40" },
        { panel: true, title: "Spend per account, by month", height: "h-56" },
        {
          pair: [
            { title: "By model, 30 days", height: "h-28" },
            { title: "By operation, 30 days", height: "h-28" },
          ],
        },
        { panel: true, title: "Heaviest accounts", height: "h-28" },
      ]}
    />
  );
}
