import { AdminLoading } from "@/components/admin/loading-shells";
import { MoneyTabs } from "@/components/admin/money-tabs";

export default function AdminCostsLoading() {
  return (
    <AdminLoading
      title="Costs"
      tabs={<MoneyTabs />}
      blocks={[
        { tiles: 4 },
        { panel: true, title: "Cash in against cost out", height: "h-60" },
        { panel: true, title: "Record a cost", height: "h-28" },
        {
          pair: [
            { title: "Provider bills, this month", height: "h-28" },
            { title: "Acquisition and CAC", height: "h-28" },
          ],
        },
      ]}
    />
  );
}
