import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminAuditLoading() {
  return (
    <AdminLoading
      title="Audit"
      subtitle="Reading the trail…"
      blocks={[{ toolbar: true }, { panel: true, height: "h-64" }]}
    />
  );
}
