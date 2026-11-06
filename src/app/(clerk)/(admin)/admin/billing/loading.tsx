import { AdminLoading } from "@/components/admin/loading-shells";
import { MoneyTabs } from "@/components/admin/admin-tabs";

export default function AdminBillingLoading() {
  return (
    <AdminLoading
      title="Money"
      tabs={<MoneyTabs />}
      blocks={[
        { tiles: 4 },
        { panel: true, title: "Needs a decision", height: "h-64" },
        { panel: true, title: "Credits and included AI, last 30 days", height: "h-56" },
        { panel: true, title: "Recent movements", height: "h-28" },
      ]}
    />
  );
}
