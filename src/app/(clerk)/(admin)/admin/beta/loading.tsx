import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminBetaLoading() {
  return (
    <AdminLoading
      title="Beta"
      subtitle="Reading the numbers…"
      blocks={[{ tiles: 4 }, { panel: true, title: "Beta", height: "h-40" }]}
    />
  );
}
