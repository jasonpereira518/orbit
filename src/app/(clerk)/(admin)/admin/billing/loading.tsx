import { AdminLoading } from "@/components/admin/loading-shells";
import { MoneyTabs } from "@/components/admin/money-tabs";

export default function AdminBillingLoading() {
  return (
    <AdminLoading
      title="Money"
      tabs={<MoneyTabs />}
      blocks={[
        { tiles: 4 },
        {
          pair: [
            { title: "Recurring movement, 6 months", height: "h-64" },
            { title: "Needs a decision", height: "h-64" },
          ],
        },
        { panel: true, title: "Subscription health", height: "h-16" },
        { panel: true, title: "Recent movements", height: "h-28" },
      ]}
    />
  );
}
