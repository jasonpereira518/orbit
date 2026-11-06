import { AdminLoading } from "@/components/admin/loading-shells";
import { MoneyTabs } from "@/components/admin/admin-tabs";

export default function AdminRevenueLoading() {
  return (
    <AdminLoading
      title="Revenue"
      tabs={<MoneyTabs />}
      blocks={[
        { tiles: 4 },
        { panel: true, title: "Recurring movement by month", height: "h-72" },
        { panel: true, title: "Which wall, and who got past it", height: "h-56" },
        { panel: true, title: "Comped accounts", height: "h-28" },
      ]}
    />
  );
}
