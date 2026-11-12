import { OpsTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminOpsRefreshLoading() {
  return (
    <AdminLoading
      title="Ops"
      subtitle="Reading the job ledger…"
      tabs={<OpsTabs />}
      blocks={[
        { panel: true, height: "h-48" },
        { panel: true, title: "Recent refreshes", height: "h-32" },
      ]}
    />
  );
}
