import { OpsTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminOpsAccountsLoading() {
  return (
    <AdminLoading
      title="Ops"
      subtitle="Checking every account…"
      tabs={<OpsTabs />}
      blocks={[
        { panel: true, title: "Open alerts", height: "h-16" },
        { tiles: 4 },
        { panel: true, title: "Accounts that cannot use AI at all", height: "h-10" },
        { panel: true, title: "Failed and stalled imports", height: "h-16" },
      ]}
    />
  );
}
