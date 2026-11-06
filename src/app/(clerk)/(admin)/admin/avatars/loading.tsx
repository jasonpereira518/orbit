import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminAvatarsLoading() {
  return (
    <AdminLoading
      title="Shared photos"
      subtitle="Reading the pool…"
      blocks={[{ toolbar: true }, { panel: true, height: "h-64" }]}
    />
  );
}
