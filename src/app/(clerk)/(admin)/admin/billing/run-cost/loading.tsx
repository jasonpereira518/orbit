import { AdminLoading } from "@/components/admin/loading-shells";
import { MoneyTabs } from "@/components/admin/money-tabs";

export default function AdminRunCostLoading() {
  return (
    <AdminLoading
      title="Cost to run"
      tabs={<MoneyTabs />}
      blocks={[
        { tiles: 4 },
        { panel: true, title: "Spend per account, by month", height: "h-56" },
        {
          pair: [
            { title: "By model, 30 days", height: "h-28" },
            { title: "By operation, 30 days", height: "h-28" },
          ],
        },
        { panel: true, title: "Heaviest accounts, 30 days", height: "h-28" },
      ]}
    />
  );
}
