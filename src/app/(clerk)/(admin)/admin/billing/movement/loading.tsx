import { AdminLoading } from "@/components/admin/loading-shells";
import { MoneyTabs } from "@/components/admin/money-tabs";

export default function AdminMovementLoading() {
  return (
    <AdminLoading
      title="Movement"
      tabs={<MoneyTabs />}
      blocks={[
        { tiles: 4 },
        { panel: true, title: "Recurring movement by month", height: "h-72" },
        { panel: true, title: "One-time sales", height: "h-32" },
        { panel: true, title: "Comped accounts", height: "h-28" },
      ]}
    />
  );
}
