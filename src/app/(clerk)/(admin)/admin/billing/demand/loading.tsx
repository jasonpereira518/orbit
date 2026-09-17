import { AdminLoading } from "@/components/admin/loading-shells";
import { MoneyTabs } from "@/components/admin/money-tabs";

export default function AdminDemandLoading() {
  return (
    <AdminLoading
      title="Demand"
      tabs={<MoneyTabs />}
      blocks={[
        { tiles: 3 },
        { panel: true, title: "Which wall, and who got past it", height: "h-56" },
        { panel: true, title: "How to read this", height: "h-28" },
      ]}
    />
  );
}
