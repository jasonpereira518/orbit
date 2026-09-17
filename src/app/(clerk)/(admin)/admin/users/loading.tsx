import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminUsersLoading() {
  return (
    <AdminLoading
      title="Users"
      subtitle="Loading accounts…"
      blocks={[{ toolbar: true }, { panel: true, height: "h-96" }]}
    />
  );
}
