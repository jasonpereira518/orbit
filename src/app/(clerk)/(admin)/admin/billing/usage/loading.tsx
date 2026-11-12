import { AdminLoading } from "@/components/admin/loading-shells";
import { MoneyTabs } from "@/components/admin/admin-tabs";

export default function AdminUsageLoading() {
  return (
    <AdminLoading
      title="Usage"
      tabs={<MoneyTabs />}
      blocks={[
        { tiles: 4 },
        { panel: true, title: "This period, by plan", height: "h-40" },
        { panel: true, title: "Accounts nearest their cap", height: "h-56" },
        { panel: true, title: "Last 12 months", height: "h-56" },
      ]}
    />
  );
}
