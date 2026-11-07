import { UsersTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminUsersLoading() {
  return (
    <AdminLoading
      title="Users"
      subtitle="Loading accounts…"
      tabs={<UsersTabs />}
      blocks={[{ toolbar: true }, { panel: true, height: "h-96" }]}
    />
  );
}
