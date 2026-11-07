import { UsersTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminAuditLoading() {
  return (
    <AdminLoading
      title="Users"
      subtitle="Reading the trail…"
      tabs={<UsersTabs />}
      blocks={[{ toolbar: true }, { panel: true, height: "h-64" }]}
    />
  );
}
